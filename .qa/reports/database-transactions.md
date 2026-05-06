# Agent Report: Database/Transaction

_Dream-state production-hardening run · 2026-05-06 · code-only audit, no edits._

## Scope Reviewed

- **Migrations** — 100 SQL files (`0000_mature_masked_marvel` → `0102_onboarding_drafts`); journal/file count + ordering verified in sync. Last 10 reviewed in detail: `0085_tenant_invariants`, `0089_runner_token_ttl`, `0094_company_physical_address`, `0095_workflow_run_approval_states`, `0096_company_financials`, `0098_approvals_workflow_run`, `0099_company_memory_agent_recall`, `0100_notifications`, `0101_magic_link_tokens`, `0102_onboarding_drafts`. Also reviewed `0073_auth_mirror_orphan_guard`, `0077_events`, `0079_connector_health`, `0081_insights`, `0083_experiments`, `0088_content_drafts` for CHECK-constraint coverage and ALTER TABLE lock patterns.
- **Schema files** — 90+ files in `packages/db/src/schema/`. Inspected: `instance_subscription.ts`, `notifications.ts`, `events.ts`, `integrations.ts`, `agents.ts`, `companies.ts`, `projects.ts`, `company_secrets.ts`, `instance_invites.ts`, `agent_handoffs.ts`, `company_memberships.ts`, `company_memory.ts`.
- **Services** — Inspected `onboarding-bootstrap.ts`, `event-ingest.ts`, `posthog-poll.ts`, `posthog-client.ts`, the four `integrations/*-ingest.ts` (slack, linkedin, hubspot, notion), `subscription.ts`, `secrets.ts`, `instance-invite.ts`, `notifications.ts`, `companies.ts`, `agents.ts`, `projects.ts` (workspace insert tx), `issues.ts` (checkout staleness tx), `issue-approvals.ts`, `heartbeat.ts` (queue/retry tx), `auth/post-signup-hook.ts`, `workflows.ts` (idempotency tx).

## Top Findings

### Finding 1
- **Severity**: P1
- **Category**: persistence
- **Graph node**: invite consume → role grant
- **File(s)**: `server/src/services/instance-invite.ts:153-194`
- **What is wrong**: `consumeInvite()` does the conditional UPDATE on `instance_invites` (line 156-163, atomic single-row TOCTOU-safe) but the subsequent role grant (`SELECT instance_user_roles` line 173-177 then `INSERT instance_user_roles` line 181-184) runs **outside any transaction**. The two operations are issued on `db` directly, not under `db.transaction(async (tx) => ...)`.
- **Why it matters**: If the UPDATE succeeds and the INSERT fails (DB blip, connection drop, transient FK error, or even a process crash between the two awaits), the invite is marked `consumedAt = now()` but no role row exists. The teammate cannot re-consume the invite (the WHERE-clause `IS NULL` filter blocks them) and has no `instance_admin` / `instance_member` role — they are silently locked out of the workspace they were invited to. This is the *exact* failure mode CLAUDE.md notes for the older auth-bootstrap pre-fix at a different layer.
- **Evidence**:
  ```ts
  // line 156-163 — atomic invite consume (good)
  const [updated] = await db.update(instanceInvites)
    .set({ consumedAt: now, consumedBy: input.userId })
    .where(and(eq(instanceInvites.id, pending.id), isNull(instanceInvites.consumedAt)))
    .returning();
  // ...
  // line 181-184 — separate connection, NOT under tx
  await db.insert(instanceUserRoles).values({
    userId: input.userId,
    role: updated.role,
  });
  // ...
  } catch (err) {
    logger.warn({ err, ... }, "instance-invite: failed to insert ... — continuing");
  }
  ```
- **Suggested fix**: Wrap the conditional UPDATE + role-grant lookup + INSERT in a single `db.transaction(async (tx) => ...)`. Use `onConflictDoNothing({ target: [instanceUserRoles.userId, instanceUserRoles.role] })` to absorb the duplicate-grant case idempotently and drop the SELECT-existing pre-check.
- **Test to add**: `instance-invite.test.ts` — simulate INSERT failure on `instance_user_roles` (mock to throw) after UPDATE on `instance_invites` succeeds; assert that the invite is NOT marked consumed (the whole tx rolls back).
- **Effort**: small
- **Safe to fix now?**: yes

### Finding 2
- **Severity**: P1
- **Category**: dedup / persistence
- **Graph node**: notifications create
- **File(s)**: `server/src/services/notifications.ts:44-98`, `packages/db/src/migrations/0100_notifications.sql:34-62`, `packages/db/src/schema/notifications.ts:39-87`
- **What is wrong**: `create()` claims to dedupe on `(user_id, kind, ref_kind, ref_id) WHERE read_at IS NULL` (CLAUDE.md states this as a contract). The implementation does SELECT-then-INSERT (lines 51-67 then 69-80) — a textbook TOCTOU race. **There is NO unique index in the migration backing this dedup**: migration 0100 declares only `idx_notifications_user_created`, `idx_notifications_user_unread`, `idx_notifications_company_kind_created`, `idx_notifications_ref` — none enforce uniqueness on the dedup tuple.
- **Why it matters**: Two concurrent producers (e.g. workflow run completed + insight critical fired in parallel against the same approval refId) can both pass the SELECT, both insert, and both publish a `notification.created` live event. The bell badge then over-counts and the user sees doppelgänger entries. The comment in `notifications.ts:42` literally says "without requiring a unique index" — but at scale, that's exactly the failure shape `vinamr-invariants` warns about: nullable dedup column + ON CONFLICT DO NOTHING semantics minus the actual constraint = silent dedup loss.
- **Evidence**:
  ```ts
  // notifications.ts:51-67 — SELECT half of TOCTOU
  const [existing] = await db.select().from(notifications)
    .where(and(eq(notifications.userId, params.userId), ...));
  if (existing) return existing;
  // ...
  // notifications.ts:69-80 — INSERT half (no constraint backstop)
  const [row] = await db.insert(notifications).values({...}).returning();
  ```
  Migration 0100 (lines 34-82): no `UNIQUE` or `unique index` on the dedup tuple — only ordinary indexes.
- **Suggested fix**: Add a partial unique index in a follow-up migration: `CREATE UNIQUE INDEX idx_notifications_dedup_unread ON notifications (user_id, kind, ref_kind, ref_id) WHERE read_at IS NULL AND ref_kind IS NOT NULL`. Switch service to `INSERT ... ON CONFLICT DO NOTHING` + return existing on conflict (same shape as `event-ingest.ts:107-161`). Note: nullable `ref_kind` means `NULLS DISTINCT` (PG default) leaks rows where ref is null — the partial index condition `ref_kind IS NOT NULL` sidesteps this.
- **Test to add**: `notifications-dedup.test.ts` — fire two concurrent `create()` calls with identical `(userId, kind, refKind, refId)` against embedded PG; assert exactly one row exists.
- **Effort**: small (one migration + service refactor)
- **Safe to fix now?**: yes

### Finding 3
- **Severity**: P1
- **Category**: schema / dedup
- **Graph node**: stripe billing upsert
- **File(s)**: `packages/db/src/schema/instance_subscription.ts:6-29`, comment at line 8-15 admits the issue.
- **What is wrong**: `instanceSubscription.stripeSubscriptionId` is `text(...).unique()` AND nullable. Postgres default is `NULLS DISTINCT`, so multiple rows with `stripeSubscriptionId = NULL` can coexist. The schema comment explicitly relies on this for "free-tier placeholder rows."
- **Why it matters**: The current `subscription.ts:82-85` early-returns if `stripeSubscriptionId` is missing, so the live Stripe webhook path is safe TODAY. But any future code path that creates a placeholder row + later tries to upsert with `null` target on conflict would silently insert duplicates instead of updating — the same `defaultRandom()` ID footgun pattern documented in `vinamr-invariants.staging.md` for Stripe webhooks. The test `subscription-idempotency.test.ts` may pass while the production behavior under multiple-instance-per-company drift is unprotected.
- **Evidence**: `instance_subscription.ts:13-15`: "PostgreSQL UNIQUE treats NULLs as distinct, so multiple NULL rows coexist" — this is acknowledged but not fenced. No CHECK ensures `(plan = 'free' OR stripe_subscription_id IS NOT NULL)`, so a paid row with a null stripe id could in theory be written.
- **Suggested fix**: Migration: `DROP CONSTRAINT instance_subscription_stripe_subscription_id_key; ADD CONSTRAINT ... UNIQUE NULLS NOT DISTINCT (stripe_subscription_id)` (PG15+ — Fly MPG ships PG16). Plus add CHECK `(plan = 'free') OR (stripe_subscription_id IS NOT NULL)` as a defense-in-depth gate.
- **Test to add**: `subscription-placeholder-uniqueness.test.ts` — try to insert two rows with `stripe_subscription_id = null` on embedded PG with the new index; assert the second one fails.
- **Effort**: small
- **Safe to fix now?**: yes (additive constraint; existing rows already obey it because the live path early-returns on null id)

### Finding 4
- **Severity**: P2
- **Category**: schema
- **Graph node**: enum-shaped text columns lacking DB enforcement
- **File(s)**:
  - `packages/db/src/schema/agents.ts:19,22` — `role` and `status` are bare `text` with TS-only enum.
  - `packages/db/src/schema/companies.ts:36` — `status` text, no CHECK.
  - `packages/db/src/schema/projects.ts:15` — `status` text, no CHECK.
  - `packages/db/src/schema/integrations.ts:25,27` — `kind` and `status` text, no CHECK (comment lists the valid values but DB doesn't enforce).
  - `packages/db/src/schema/instance_subscription.ts:18` — `status` text, no CHECK.
  - `packages/db/src/schema/instance_invites.ts:15` — `role` text, no CHECK (the auth-mirror migration 0073 added FK but not a role CHECK).
  - `packages/db/src/schema/agent_handoffs.ts:28` — `status` text, no CHECK.
  - `packages/db/src/schema/company_memberships.ts:11` — `status` text, no CHECK.
  - `packages/db/src/schema/company_memory.ts:69,75` — `kind` and `source` text; `category` IS check-constrained (migration 0099) but `kind`/`source` are not.
  - `packages/db/src/schema/budget_incidents.ts:22` — `status` text, no CHECK.
  - `packages/db/src/schema/agent_runtime_state.ts`, `agent_wakeup_requests.ts:15` — `status` text, no CHECK on these (only on heartbeat_runs and runner_jobs as of migration 0085).
  - `packages/db/src/schema/feedback_exports.ts:19` — `status` text, no CHECK.
  - `packages/db/src/schema/composio_connections.ts:51` — `status` text, no CHECK (note: `last_sync_status` IS check-constrained per migration 0079).
  - `packages/db/src/schema/issue_work_products.ts:28,33` — `type` and `status` text, no CHECK.
- **What is wrong**: TS `$type<X>()` annotations erase at runtime — raw SQL inserts (CLI, ad-hoc psql, future migrations, agent-generated workflow steps that bypass the typed insert path) can write arbitrary garbage like `'undefined'`, `'idle '` (trailing space), `'IDLE'` (case-mismatch), `'paid'` (typo), and the application reads them back without complaint until a downstream consumer pattern-matches and silently ignores the row.
- **Why it matters**: Per the existing pattern (council 2026-05-05 R1 added CHECK on `runner_jobs.status`, `heartbeat_runs.status`, `execution_workspaces.status`, `events.source`, `notifications.kind`/`ref_kind`, `company_memory.category`, `composio_connections.last_sync_status`), the team has already accepted CHECK-as-runtime-backstop as the standard. The above 14+ enum-shaped columns are the long tail. Highest-priority subset for buyer-critical paths: `agents.role/status`, `companies.status`, `projects.status`, `integrations.kind/status`, `instance_invites.role`, `instance_subscription.status`. These all sit on the founder-onboarding + tenant-isolation hot path.
- **Suggested fix**: One migration per logical group, multi-clause `ALTER TABLE` per table to take ACCESS EXCLUSIVE once. Keep TS unions in `packages/shared` and the CHECK clause in lockstep (same review checklist as `events.source` / `company_memory.category`).
- **Test to add**: For each table, raw SQL insert with bogus value + assert constraint failure on embedded PG.
- **Effort**: medium (~4 migrations × 3 tables each)
- **Safe to fix now?**: yes for additive checks where existing rows already obey the value set; verify per-table with a `SELECT DISTINCT status FROM ...` before applying — the migration must list every value already in production, not just the union TS exports today.

### Finding 5
- **Severity**: P2
- **Category**: dedup
- **Graph node**: PostHog poll → events
- **File(s)**: `server/src/services/posthog-poll.ts:130-143`
- **What is wrong**: PostHog ingest passes `dedupKey: event.id` directly. CLAUDE.md spec (S2.1 dedup contract) explicitly states: "PostHog events when `event.id` is missing → `synth:${eventName}:${timestamp}:${distinctId ?? "anon"}`". The current code does NOT implement that fallback. The TS type `PostHogRawEvent.id: string` (`posthog-client.ts:49`) makes this *typed* as required, but PostHog's REST API can return null/empty `id` for some custom or projected event variants — and the runtime guard in `event-ingest.ts:99` will throw with a thorny error message instead of using the synthetic key.
- **Why it matters**: Posthog poll silently drops events when the API returns an id-less event (caught only at warn-level: line 150-153). The watermark advances regardless (line 146-148: `newestTimestamp` updated unconditionally), so the dropped events are never retried. The CLAUDE.md contract was set explicitly — implementation drifted from spec.
- **Evidence**:
  ```ts
  // posthog-poll.ts:132-143
  await ingestEvent({
    companyId, source: "posthog",
    entityType: resolveEntityType(event.event),
    eventName: event.event,
    dedupKey: event.id,            // ← not synth-fallback
    occurredAt: new Date(event.timestamp),
    payload: { ... },
  });
  ```
  vs CLAUDE.md S2.1 dedup contract.
- **Suggested fix**: `const dedupKey = event.id?.trim() || \`synth:${event.event}:${event.timestamp}:${event.distinct_id ?? "anon"}\`;`
- **Test to add**: `posthog-poll.test.ts` — feed an event with `id: null` (cast); assert `ingestEvent` is called with the synth key, not throws.
- **Effort**: small
- **Safe to fix now?**: yes

### Finding 6
- **Severity**: P2
- **Category**: persistence (TOCTOU)
- **Graph node**: secret create
- **File(s)**: `server/src/services/secrets.ts:170-216`
- **What is wrong**: `secretService.create()` does `getByName()` (line 180) → throws `conflict()` if exists → `provider.createVersion()` (network/crypto, line 184) → `db.transaction` (line 189). The existence check is a SELECT and the transaction starts later. A second concurrent caller can pass the same SELECT, do its own provider.createVersion, then both call `db.transaction` and one will fail at the unique index `company_secrets_company_name_uq` (`company_secrets.ts:23`).
- **Why it matters**: The unique index catches the actual race so data is safe — but the user-visible failure is a generic Drizzle UNIQUE-violation thrown out of the transaction, *not* the friendly `conflict("Secret already exists: ${name}")` from line 181. Worse, `provider.createVersion` may have written a key to an external secret store (e.g., a `local_encrypted` material blob in memory; a future `aws_secretsmanager` provider would write a real KMS handle) before the rollback — leaving an orphan external resource. For `local_encrypted` the cost is zero (in-process); for any future external provider it is real $$ + audit-log noise.
- **Suggested fix**: Move the existence-check **inside** the transaction (use `tx.select().from(companySecrets).where(...)` then insert, leveraging `onConflictDoNothing()` to keep it idempotent). For external providers, defer `createVersion` until after the existence check passes.
- **Test to add**: `secrets-toctoc.test.ts` — two concurrent create() calls with same name on embedded PG; assert exactly one wins, the other gets a `conflict` error not a generic UNIQUE violation, and the loser's external resource (mock `provider.createVersion`) is rolled back.
- **Effort**: small
- **Safe to fix now?**: yes

### Finding 7
- **Severity**: P3
- **Category**: migration
- **Graph node**: ALTER TABLE lock acquisition
- **File(s)**: `packages/db/src/migrations/0089_runner_token_ttl.sql:20-26`, `0095_workflow_run_approval_states.sql:13-26`
- **What is wrong**: Two of the recent migrations take ACCESS EXCLUSIVE more than once on the same table:
  - **0089** does `ALTER TABLE runner_tokens ADD COLUMN ...; ALTER TABLE runner_tokens ADD CONSTRAINT runner_tokens_rotated_from_token_id_fk ...;` — two separate locks. The header comment at line 15-18 *explicitly cites* `vinamr-invariants` "combine into one multi-clause ALTER" but the implementation splits them anyway (the second statement is the FK referencing a column added in the first — the FK clause CAN be combined into the first ALTER's clause list).
  - **0095** does `ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS ...; ALTER TABLE workflow_runs ADD CONSTRAINT ...;` — two locks. Postgres allows DROP+ADD in the same ALTER.
- **Why it matters**: `runner_tokens` is on a hot 5-second-poll path per the CLAUDE.md note ("the runner polls every 5s under load"). Each ACCESS EXCLUSIVE acquisition can stall under concurrent traffic; doubling them doubles the worst-case stall window during the Fly `release_command`. `workflow_runs` is less hot but the principle stands. Both are textbook examples of the very vinamr-invariant the migrations cite. Low severity because impact is bounded (sub-second on small tables) and rollout is during pre-traffic-shift, but the pattern is contagious for future migrations that copy this template.
- **Suggested fix**: Future migrations only. (Don't rewrite already-applied migrations — would corrupt the journal.) Add a `pnpm --filter @founderos/db check:migrations` lint rule that flags multiple `ALTER TABLE "<same>"` statements per file.
- **Test to add**: Linter rule in `packages/db/src/check-migration-numbering.ts` (or new `check-migration-locks.ts`).
- **Effort**: small
- **Safe to fix now?**: linter is safe; rewriting applied migrations is NOT.

### Finding 8
- **Severity**: P3
- **Category**: persistence
- **Graph node**: outbound side-effects in onboarding tx
- **File(s)**: `server/src/services/onboarding-bootstrap.ts:266-280`
- **What is wrong**: Inside the bootstrap transaction (line 216), `secrets.create()` is invoked for the Anthropic key (line 270). `secretService.create()` calls `provider.createVersion()` which for the `local_encrypted` provider is in-process crypto — fine. But the comment at line 18-20 explicitly states "external network calls hold tx resources for too long. The Anthropic key live-API check belongs to the caller" — meaning the *validation* call lives outside. If a future change adds a remote secret backend (AWS KMS, GCP Secret Manager) the `provider.createVersion` becomes a network call and silently re-introduces the very pattern the comment forbids: a long-running tx holding `companies`, `goals`, `projects`, `agents` row locks during a multi-second remote round-trip.
- **Why it matters**: Defensive-programming-debt rather than active bug. The `local_encrypted` provider is the only one shipped today (`secrets/local-encrypted-provider.ts`). But the abstraction (`getSecretProvider(input.provider)`) is plugin-shaped; adding a remote provider is a one-PR change. Pair this with the council 2026-05-03 P1 finding on holding tx open through external I/O — same root cause.
- **Suggested fix**: Move `provider.createVersion(...)` **outside** the transaction in `onboarding-bootstrap.ts`. Pre-compute `prepared = { externalRef, material, valueSha256 }` before `db.transaction(async (tx) => ...)`, then pass `prepared` into a `secrets.createPrepared(tx, ...)` variant that does only the two INSERTs. Mirrors the same pattern already used in `secrets.ts:184-187` — the prep is split out, but the orchestrator calls the public `create` which re-merges them.
- **Test to add**: Mock provider with a 5-second delay; assert the bootstrap transaction COMMIT happens within ~50ms after the slow provider call resolves (i.e., locks are held briefly).
- **Effort**: medium (requires shaping a new `createPrepared` API surface).
- **Safe to fix now?**: yes

## Schema Hygiene Audit

### Missing CHECK constraints on enum-shaped columns

Highest-priority (founder onboarding + tenant isolation hot path):

| Table | Column | Valid values (from TS unions / comments) | File:line |
|---|---|---|---|
| `agents` | `role` | (broad set, see `AgentRole` in shared) | `agents.ts:19` |
| `agents` | `status` | `idle | running | paused | terminated | pending_approval | ...` | `agents.ts:22` |
| `companies` | `status` | `active | archived` | `companies.ts:36` |
| `projects` | `status` | `backlog | in_progress | done | archived` | `projects.ts:15` |
| `integrations` | `kind` | `posthog | hubspot | slack | notion | linkedin | stripe` | `integrations.ts:25` |
| `integrations` | `status` | `connected | error | disconnected` | `integrations.ts:27` |
| `instance_subscription` | `status` | `inactive | active | past_due | canceled | trialing` (Stripe set) | `instance_subscription.ts:18` |
| `instance_invites` | `role` | `instance_admin | instance_member` | `instance_invites.ts:15` |
| `agent_handoffs` | `status` | `pending | accepted | declined | expired` | `agent_handoffs.ts:28` |
| `company_memberships` | `status` | `active | invited | revoked | ...` | `company_memberships.ts:11` |
| `company_memory` | `kind` | `weekly_summary | experiment_outcome | founder_note | milestone` | `company_memory.ts:69` |
| `company_memory` | `source` | `auto | manual` | `company_memory.ts:75` |
| `composio_connections` | `status` | `pending | connected | revoked | error` | `composio_connections.ts:51` |
| `agent_wakeup_requests` | `status` | `queued | claimed | streaming | completed | failed | cancelled` | `agent_wakeup_requests.ts:15` |
| `feedback_exports` | `status` | `local_only | exporting | exported | failed` | `feedback_exports.ts:19` |
| `issue_work_products` | `type`, `status` | (broad sets) | `issue_work_products.ts:28,33` |
| `budget_incidents` | `status` | `open | acknowledged | resolved` | `budget_incidents.ts:22` |
| `agent_reviews` | `source` | `auto | manual` | `agent_reviews.ts:23` |
| `routines` | `kind`, `source`, `status` | (broad sets) | `routines.ts:32,58,94,95` |
| `join_requests` | `status` | `pending_approval | approved | denied` | `join_requests.ts:13` |
| `plugin_entities` | `status` | (per-plugin, no closed set) | `plugin_entities.ts:39` — may legitimately need to stay open |

### Nullable dedup columns

- `instance_subscription.stripe_subscription_id` — `text("...").unique()` AND nullable. Default `NULLS DISTINCT` permits multiple `NULL` rows; safe today only because `subscription.ts:82-85` early-returns on null id, and there is no current placeholder-row writer. Recommend `UNIQUE NULLS NOT DISTINCT` or `NOT NULL` per Stripe-pattern invariant in `vinamr-invariants.staging.md`.
- `notifications.(user_id, kind, ref_kind, ref_id) WHERE read_at IS NULL` — claimed dedup tuple in CLAUDE.md, NO unique index in migration 0100. Service does TOCTOU dedup. See Finding #2.
- `magic_link_tokens.token_hash` — UNIQUE, NOT NULL — clean (per migration 0101).
- `events.dedup_key` — UNIQUE composite + NOT NULL — clean (per migration 0077). Reference implementation.

### ON CONFLICT targets that may not collide

- `instance_subscription.stripeSubscriptionId` — described above; current live path is safe due to caller-side null guard, but the index permits null-row duplicates.
- `auth.users` (post-signup-hook.ts:79) `onConflictDoNothing({ target: authUsers.id })` — `id` is the user-supplied Supabase UUID, which is deterministic and stable per signup, so this is a real collision target. Clean.
- `instance_user_roles` (post-signup-hook.ts:190) `onConflictDoNothing({ target: [instanceUserRoles.userId, instanceUserRoles.role] })` — composite tuple. Verify the table has a UNIQUE on this tuple in migration history (the schema appears to enforce it — a non-blocking finding to verify in a follow-up).
- `events` (event-ingest.ts:118) — relies on UNIQUE `(company_id, source, dedup_key)` from migration 0077. Clean.
- `workflow_runs` (workflows.ts:295) — composite target `(companyId, workflowId, idempotencyKey)`. Verify migration 0092 defines this UNIQUE.

## Recommended PR Slices

In rank order; each is independently shippable.

1. **PR — `fix(invites): wrap consume + role grant in single tx`** (Finding #1, P1, small). Single file: `instance-invite.ts`. Add 1 test against embedded PG.
2. **PR — `fix(notifications): partial unique index + ON CONFLICT dedup`** (Finding #2, P1, small). 1 migration + service refactor + 1 test.
3. **PR — `fix(billing): NULLS NOT DISTINCT on stripe_subscription_id + plan-paid CHECK`** (Finding #3, P1, small). 1 migration + 1 test.
4. **PR — `fix(posthog): synthetic dedupKey fallback when event.id missing`** (Finding #5, P2, small). 1 file + 1 test.
5. **PR — `fix(secrets): existence check inside tx, defer external provider call`** (Finding #6, P2, small). 1 file + 1 test.
6. **PR — `chore(schema): CHECK constraints on agents/companies/projects/integrations/instance_subscription`** (Finding #4 hot subset, P2, medium). 1 migration covering 6-8 tables, multi-clause ALTER per table.
7. **PR — `chore(schema): CHECK constraints on remaining enum-shaped text columns`** (Finding #4 long tail, P3, medium). Follow-up to #6.
8. **PR — `chore(onboarding): pre-compute provider.createVersion outside bootstrap tx`** (Finding #8, P3, medium). 1 service refactor + 1 test.
9. **PR — `chore(db): linter rule for multi-statement ALTER TABLE on same table`** (Finding #7, P3, small). Add to `check-migration-numbering.ts` or sibling.

## Notes Out of Scope

- **Init singleton risk** (vinamr-invariants `event-ingest.ts` pattern) — confirmed present in `event-ingest.ts:171-193`. Tests using the module-level `ingestEvent()` MUST `initEventIngest(mockDb)` per CLAUDE.md note. Not a production bug; flagged here as a known test-fixture footgun.
- **Embedded PG test fixture** — confirmed `startEmbeddedPostgresTestDatabase(prefix)` returns `{ connectionString, cleanup }` per CLAUDE.md. Several S2.6 ingest tests still `describe.skip` per task #125. Not in this report's scope.
- **Drizzle `.where(a).where(b)` chained-replace bug** — scanned `server/src/services/`, `server/src/routes/`, `packages/db/src/`. Every multi-condition `.where(...)` use in source files goes through `and(eq, eq, ...)` (correct pattern per `vinamr-invariants`). Test files contain the literal string `.where(a).where(` only inside `// NEVER chain ...` comment lines (e.g. `content-generator.ts:359,397`) — false positives. **No real instances of the bug in production code.**
- **Migration journal integrity** — verified: 100 SQL files, 100 journal entries, names match by sort. Numbers `0078` and `0080` are skipped (intentional sprint-branch gaps), but no parallel-branch merge corruption (each entry has unique idx, monotone `when` timestamps, no orphan SQLs).
- **Advisory lock placement** — verified `pg_advisory_xact_lock` is correctly placed inside `db.transaction(async (tx) => tx.execute(...))` at `auth/post-signup-hook.ts:135-153`. The dev-vs-prod degrade-on-failure logic is well-reasoned (production rethrows; pglite logs and continues since pglite serializes in-process).
- **Onboarding bootstrap** — confirmed properly wrapped in single `db.transaction(...)` at `onboarding-bootstrap.ts:216-407`. The known issue cited in CLAUDE.md (`onboarding-bootstrap.ts:201` adapter mismatch) is a different concern (`resolveBaseAdapterType` collapses `anthropic_api` to `claude_local`) and not a transaction/persistence bug; flagged for the agent owning that surface.
