# CONTINUE.md — FounderOS next-step source of truth

_Last updated: 2026-05-06 (AM, S4 Wave 1 shipped + S4.5 council BLOCK closed + Wave 2 dispatched) by Claude_

## 🟢 2026-05-06 AM — Trust-closure DONE · S4 Wave 1 shipped · S4.5 council BLOCK closed · Wave 2 in flight

**Status:** `feat/trust-closure` is now a 5-commit ladder past `1dcc7d1`. Branch HEAD `134fde1`. All known P1 BLOCK findings from THREE adversarial council rounds (R1 trust-closure, R2 self-reaction, S4.5 council) are closed with verification. Sprint 4 Wave 1 (S4.1 + S4.5) merged. Wave 2 (S4.2 / S4.6 / S4.7 / S4.9) dispatched in 4 parallel worktrees on Haiku/Sonnet. Tests: 98/98 across 7 affected batteries; typecheck clean across server + ui + cli; migrations clean (idx 0..84 contiguous).

### Branch ladder (top → bottom)

| SHA | Type | What |
|---|---|---|
| `134fde1` | merge | SDE-A's S4.1 (content briefs schema + intake) merged with stub-vs-real conflict resolution. Tiebreaker `desc(id)` added to ordering to defeat same-microsecond `now()` race. |
| `52f1f7d` | fix | Council BLOCK fix on S4.5: (1) `assertStrictCompanyMembership` no instance-admin bypass on autonomy-write paths, (2) autonomy flag re-checked at run creation (kill switch now works), (3) `LogActivityInput.workflowId` + `lineageRefs` populated. Plus R2 carry: hubspot `connectionId` threaded from cron → service for multi-admin determinism. |
| `c5478fe` | feat | SDE-A: S4.1 content_briefs table + Zod validators + intake API + 19 integration tests. UNIQUE(id, company_id) per TC-3 pattern; CHECK on status enum. |
| `b1b1e55` | fix | Council R1 PARTIAL fix: TC-1 telemetry consent was COSMETIC — DB write but boot only read file config. Added `reinitTelemetryFromInstanceSettings(db)` hooked from boot post-DB + onboarding consent persist + settings PATCH. C2: hubspot service `eq(status, "active")` defense in depth. |
| `086faab` | feat | SDE-B: S4.5 lifecycle CRM workflow registry + 31 tests (18 integration + 13 unit). LANDED VIA WORKTREE LEAK — agent committed straight to feat/trust-closure instead of its worktree branch. Council #154 caught BLOCK retroactively. |

### Council 2026-05-06 — S4.5 verdict BLOCK (closed by `52f1f7d`)

Council on `086faab` ran PARTIAL (Codex `gpt-5.4` healthy; Gemini 429 capacity exhausted on `gemini-2.5-pro` — third consecutive Gemini outage in 24h). Codex returned **3 P1 BLOCKs + 2 P2s**:

| ID | Sev | Surface | Status |
|---|---|---|---|
| S4.5-P1A | P1 | `routes/authz.ts:21` `assertCompanyAccess` instance-admin bypass on workflow writes | ✅ FIXED — added `assertStrictCompanyMembership` |
| S4.5-P1B | P1 | `routes/workflows.ts:350` autonomy flag not re-checked at POST /runs (kill switch was future-only) | ✅ FIXED — re-call `canRunAutonomously(db, workflow)` per run |
| S4.5-P1C | P1 | `services/activity-log.ts:45` `workflow_id` column never populated despite S1.8 schema | ✅ FIXED — extended `LogActivityInput` with `workflowId` + `lineageRefs`, plumbed from S4.5 service |
| S4.5-P2A | P2 | `routes/workflows.ts:71` `triggerSpec: z.record(z.unknown())` free-form | 📋 deferred — discriminated validator follow-up |
| S4.5-P2B | P2 | `0087.sql:110` redundant single-column FK on workflow_runs | 📋 deferred — composite FK supersedes; cosmetic |

Council ledger entry written. Run artifact at `~/.vanta/council-runs.jsonl` ts=`2026-05-06T00:00:00.000Z`. Findings hashed in `~/.vanta/council-feedback.jsonl`.

### Council 2026-05-05 R1 + R2 — verdict BLOCK→closed (closed by `b1b1e55` + `52f1f7d`)

Council on `1dcc7d1` (trust-closure pre-S4.5 state) found:
- **C1 P2 BLOCK**: TC-1 telemetry consent was cosmetic — UI wrote to DB, boot only read file config. Singleton `initTelemetry()` early-returned on subsequent calls. The trust contract ("no telemetry until you flip it on") was broken on opt-in.
- **C2 P2**: hubspot service re-selected by (companyId, appName) without `status="active"` filter — manual triggers could bind to revoked rows.
- **C3 P3**: CI threshold drift (PR claims 75%, enforced 65%).
- **C4 P3**: Sentry alert rules dashboard-only, no code provisioning.

R2 self-reaction (Codex re-read its R1 + the fix code) added one more residual:
- **C-R2 P2**: hubspot multi-admin scenario — when multiple active rows exist (different userIds), `.limit(1)` picks arbitrary row. Cron has the right `connectionId` but throws it away. Fix: thread `connectionId` from cron → service.

### Sprint 4 Wave 2 dispatch (4 background agents, in flight)

| Agent | Ticket | Model | Workscope |
|---|---|---|---|
| SDE-C | #160 S4.2 | Sonnet | Multi-format content generator + content_drafts table (idx 85) — LLM-heavy |
| SDE-D | #161 S4.6 | Haiku | Onboarding email workflow template (no new schema) |
| SDE-E | #162 S4.7 | Haiku | Activation nudge workflow template (no new schema) |
| SDE-F | #163 S4.9 | Haiku | Upsell workflow template + Stripe checkout integration |

All four were briefed with the post-council invariants:
- `assertStrictCompanyMembership` for autonomy-write paths (no instance-admin cross-tenant bypass)
- `canRunAutonomously()` re-check at SEND time, not just at workflow registration
- Pass `workflowId` to every `logActivity` call from workflow-context code
- TC-3 composite FK pattern for any new per-company table
- Drizzle `and(eq, eq)` invariant; never `eq && eq` or `.where().where()`

### Session invariants discovered (NEW)

- **Worktree leak now lands COMMITS on parent branch** — SDE-B's S4.5 commit `086faab` appeared directly on `feat/trust-closure` instead of staying in its worktree branch. The leak goes deeper than file-level: the agent harness's worktree isolation can leak commits too. Defense: explicit pre-commit `git diff --name-only HEAD` check, and assume commits to the parent branch are possible. The council #154 caught it retroactively, but ideally we run council BEFORE the commit lands.
- **Single-microsecond `now()` race in test fixtures** — `created_at timestamptz NOT NULL DEFAULT now()` on rapid back-to-back inserts produces equal timestamps. ORDER BY `created_at DESC` alone is non-deterministic in tests. Always add a tiebreaker (e.g., `desc(id)`) on user-facing list endpoints.
- **Codex P1 finding on TC-1 was a TRUST-CONTRACT VIOLATION, not a bug** — the fix shipped, the schema flipped, the UI was added, but the runtime never read the persisted state. PR narrative claimed P1 closed; reality was the toggle was inert. The lesson: TEST THE WIRE, not the schema. Adding the consent UI without a runtime hydration test left the regression invisible.

### Next-session resume protocol

1. Wait for SDE-C/D/E/F (Wave 2) completions. Each will commit to its worktree branch and report. Anticipate worktree-leak: check `git status` after each completion before merging.
2. Council on S4.8 (#155 — churn rescue + autonomous customer email loop) is REQUIRED before S4.8 dispatch. That ticket is the demo-line — autonomously emailing customers with churn rescue offers. Maximum council scrutiny.
3. After Wave 2 lands: dispatch Wave 3 (S4.8 + S4.3 + S4.4) and Wave 4 (S4.10).
4. After Sprint 4 closes: open PR for trust-closure + Sprint 4 combined, then move to Sprint 5 (Finance dept) per `.planning/PHASES/PHASE-S5-finance.md`.
5. Keep watching Gemini capacity — three 429 events in 24h. The full council mode may not be available until tomorrow. PARTIAL council with Codex still produces verdicts; document mode in every ledger entry.

### Carry-along tickets (deferred from this session)

| # | Severity | Item |
|---|---|---|
| #176 | P2 | TC-7 — extend cross-tenant regression test pattern to composio_connections + apply TC-3 composite FK pattern |
| #135 | P1 | runner_tokens.expiresAt + rotation + device fingerprint (Sprint 3 carry) |
| follow-up | P2 | S4.5 P2A — discriminated validator for triggerSpec by triggerKind |
| follow-up | P2 | S4.5 P2B — drop redundant single-column FK from 0087.sql:110 (composite supersedes) |
| follow-up | P3 | C3 — align CI coverage threshold 65→75 (or update narrative) |
| follow-up | P3 | C4 — Sentry alert rules in code (not dashboard-only) for drift resistance |

---

## 🔴 2026-05-05 PM — Council EXPANDED BLOCK · Sprint 3 shipped · trust-closure dispatched

**Status:** Sprint 3 fully shipped (10/10 tickets) at `feat/s3-cos-growth` SHA `d562228`, PR [#39](https://github.com/bajajvinamr/founderos/pull/39) extended with Wave 3. User invoked `/council` for expanded broader product audit. Council `2026-05-05T16:22:34Z` ran FULL adversarial mode (Codex `gpt-5.4` + Gemini `gemini-2.5-pro` after `gemini-3.1-pro-preview` AND `gemini-3-pro-preview` both 429 — preview-pool capacity event). **Verdict: BLOCK** on P1 telemetry-consent default mismatch + 4 confirmed-by-both P2s. User chose Path A — trust-closure sprint (~3-5d) before Sprint 4 dispatch. 4 trust-closure agents in flight + TC-6 shipped + TC-2 holding for sequential post-TC-1.

### Sprint 3 — DONE (10/10 tickets, integrated, pushed)

| Ticket | Branch SHA | Tests | Notes |
|---|---|---|---|
| S3.1 Insights schema + API | `8eff28e` | passing | Wave 1 |
| S3.5 Experiments + Growth UI | `b3f30b2` | passing | Wave 1 (1 flake — see #175) |
| S3.2 KPI anomaly detection | `97a7b0a` | passing | Wave 2 |
| S3.3 Daily Founder Brief | `d1652e6` | passing | Wave 2 |
| S3.4 Department Status rollup | `dee1733` | passing | Wave 2 |
| S3.7 Funnel diagnostics | `166e118` | passing | Wave 2 |
| S3.6 Experiment suggester + pgvector | `6a79405` | 27/27 | Wave 3 (idx 81 / file 0084) |
| S3.8 Channel recommendation | `06d1e19` | 5/5 | Wave 3 (last-touch attribution) |
| S3.9 LinkedIn growth attribution | `d02515c` | 5/5 | Wave 3 (DEMO LINE: "32% from LinkedIn") |
| S3.10 Magic activation gate | `4bbf4ac` | 5/5 + 10/10 bootstrap | Wave 3 (10-min first-value) |

Integrated branch: `feat/s3-cos-growth` @ `d562228`. Auto-released to v0.4.0 (release-main workflow). Full battery 58/58 (1 known flake: experiments.test.ts ice_impact=11 race — task #175). Migration journal idx 0..81 clean per `pnpm --filter @founderos/db check:migrations`.

### Council 2026-05-05 EXPANDED — confirmed-by-both findings (must close before S4 dispatch per Path A)

| ID | Sev | Title | File:line | Status |
|---|---|---|---|---|
| TC-1 (#169) | **P1 BLOCK** | Telemetry consent default mismatch | `Landing.tsx:1114` says opt-in, `config.ts:377` defaults `?? true`, `shared/telemetry/{config,client}` posts to `telemetry.founderos.ai/ingest` unconditionally | 🛠 In flight (Sonnet) |
| TC-2 (#170) | P2 | GrowthConsole leaks mock data on paid path | `onboarding.ts:74-76` makes integrations optional; `GrowthConsole.tsx:161-225+453-471` falls back to `MOCK_CHANNELS`/`MOCK_FUNNEL` | ⏸ Hold for post-TC-1 (Sonnet) |
| TC-3 (#171) | P2 | App-code-only tenant invariants | `runner.ts:94-107+126`, `heartbeat_runs.ts:10-14`, `issue_labels.ts:9-11`, `execution_workspaces.ts:19-22` — composite FK + CHECK absent | 🛠 In flight (Sonnet, idx 82 / file 0085) |
| TC-4 (#172) | P2 | On-call is "wait for founder to notice" | `observability-plan.md:32-45` "No SLO / no alerts"; `e2e-synthetic.yml` runs public-only; `auth-round-trip.spec.ts:9-17+41-44` test.skip | 🛠 In flight (general-purpose) |
| TC-5 (#173) | P2 | S3 analytics layer partially untested | `slack-ingest.test.ts:24-30` + `notion-ingest.test.ts:20-22` describe.skip; #125-#128 still open; ci.yml:130-148 no coverage threshold | 🛠 In flight (general-purpose) |
| TC-6 (#174) | P3 | Doc canonical drift PGlite vs embedded-postgres | `AGENTS.md:36`, `doc/SPEC.md:384+486`, `doc/SPEC-implementation.md:729`, `CLAUDE.md:20+28` | ✅ DONE — `feat/tc-6-doc-canonical` @ `39b6dbf` |

Single-model findings (lower priority, logged in decisions.md):
- [P2→P3] Single-origin Fly SPOF (Gemini-only; Codex disputes citing aspirational SPEC.md). Resolution: known accepted risk from 2026-05-03 council.
- [P2] Product strategy contracting to single $4k buyer (Gemini-only; Codex calls out-of-scope GTM). Time-box runner pitch, validate broader OS thesis with 5-10 prospects, reserve 20% capacity for Path B.

Council artifact: `~/.gstack/projects/founderos/decisions.md` 2026-05-05 EXPANDED entry. Run artifact: `~/.vanta/council-runs.jsonl` ts=`2026-05-05T16:22:34.337Z`. Findings: 7 hashes traceable in `~/.vanta/council-feedback.jsonl`.

### Next-session resume protocol

1. **Wait for TC-1, TC-3, TC-4, TC-5 completions** — agent IDs tracked in this session. When they return, integrate into `feat/s3-cos-growth` (or new `feat/trust-closure` branch — TBD based on PR #39 size).
2. **Dispatch TC-2 sequentially after TC-1 lands** — TC-2 modifies onboarding wizard which TC-1 also touches; explicit non-overlap requires sequential dispatch.
3. **Re-run full test battery** post-integration. Watch for regressions from composite FK migration (TC-3) — some tests that insert cross-company rows may need fixture updates.
4. **Update PR #39 description** to reflect Sprint 3 + trust-closure (or open #41 for trust-closure if PR #39 grows past reviewable size).
5. **Verify CI green** — billing block #129 cleared earlier today, but the schema-drift FAILURE is non-blocking per #38 precedent.
6. **Re-run /council on TC-1/3/4 work BEFORE merging** — telemetry default flip + composite FK migration + alert routes are all council-trigger surface (auth/security-adjacent). Defense in depth.
7. **THEN dispatch Sprint 4 Wave 1** (#152 S4.1, #153 S4.5) — both council-flagged (#154/#155); council R1 must precede merge per Path A.

### Carry-along tickets (deferred, not blocking trust-closure)

| # | Sprint | Severity | Item |
|---|---|---|---|
| #135 | S3 carry | P1 | `runner_tokens.expiresAt` (default 90d) + rotation + device fingerprint |
| #136 | S4 | P2 | Session resume fallback when `~/.claude/sessions/<sid>/` missing on second machine |
| #137 | S4 | P2 | Runner stdout per-line + per-batch byte caps (DoS hardening) |
| #138 | post-#129 | P3 | Promote `release-smoke.yml` to required pre-traffic gate |
| #140 | S4 | follow-up | `heartbeat-billing-gate.test.ts` integration test (6 gate branches) |
| #144 | S4 | P3 | Full `/api/health` strip to `{ok, version}` for unauth (root endpoint) |
| #156 | S4.5 follow | follow-up | Switch S3.4 dept-status from `routines.status` to `workflows.status` once S4.5 lands |
| #175 | S4 hardening | follow-up | `experiments.test.ts:251` ice_impact=11 parallel-fork TRUNCATE-cascade race (1/58 flake on Wave 3 integration verify; passed on retry) |

### Session invariants discovered

- **Worktree isolation has write-leak edge cases** — `Agent({isolation: "worktree"})` isolates the branch state but file modifications to existing tracked files can appear in the parent checkout's `git status`. Defense: always run `git diff --name-only HEAD` before committing to confirm scope.
- **Agent self-named branches when parent ignored explicit branch instruction** — TC-4's worktree landed on auto-generated `worktree-agent-<id>` instead of the requested `feat/tc-4-auth-canary-slos`. Branch name is descriptive only; integration still works via worktree path.
- **Gemini preview-pool 429s repeat across same-day capacity windows** — `gemini-3.1-pro-preview` AND `gemini-3-pro-preview` both 429 within minutes of each other (and within hours of yesterday's same pattern). Drop directly to `gemini-2.5-pro` for FounderOS reviews until capacity event clears.

---

## 🟡 2026-05-05 AM — Council retro PASS WITH CONDITIONS · pre-S3 trust closure shipped (historical)

**Status:** Sprint 1 + Sprint 2 shipped on `feat/s1-workspace-home`. CI billing block (#129) RESOLVED. Council `2026-05-05T13:42:57Z` ran adversarial retro on BYO Runner + product audit (PARTIAL mode — Gemini 429 across `gemini-3.1-pro-preview` and `gemini-2.5-pro` fallback; Codex `gpt-5.4` healthy R1+R2 self-check). Verdict **PASS WITH CONDITIONS** on BYO Runner; 2 new P1s + 3 new P2s to close before Sprint 3 dispatch. User chose B (carry findings as parallel work, NOT defer Sprint 3). Pre-S3 trust closure underway — see "🛠 In flight" below.

### ✅ Closed by R1/R2 file:line verification (CLAUDE.md drift corrected)

The 2026-05-03 council BLOCK cluster shipped fixes that earlier CONTINUE.md/CLAUDE.md still described as open. Council 2026-05-05 R2 self-check verified all 5 closures with file:line proof:

| Domain | Status | Proof (verified) |
|---|---|---|
| Stripe webhook idempotency | CLOSED | `subscription.ts:90-103` upserts on `stripeSubscriptionId`; `instance_subscription.ts:16` unique index |
| Composio cross-org leak | CLOSED | `composio-skill-bridge.ts:96-113` requires `connectedAccountId` |
| Silent run stranding (`executeRun.catch`) | CLOSED | `heartbeat.ts:1571/2635/2685` all `setRunStatus("failed")` |
| `/api/health/deep` admin auth | CLOSED | `health.ts:132-133` `assertInstanceAdmin` |
| Fly migration `release_command` | CLOSED | `fly.toml:32-43` release_command + rolling strategy |

Full council log + new findings: `~/.gstack/projects/founderos/decisions.md` 2026-05-05 entry.

### 🛠 In flight — Pre-S3 trust closure (BLOCKERS before Sprint 3 dispatch)

| # | Status | Severity | Item | Effort |
|---|---|---|---|---|
| #132 | ✅ DONE | P1 | `billingGate` pushed to `heartbeat.wakeup()/invoke()` layer (defense in depth) — closes 5 ungated wake paths: `issues.ts:840`, `issues.ts:1411`, `approvals.ts:164`, `issues-comments.ts:289`, `issues-execution.ts:290`, `plugin-host-services.ts:887/1017` | ~3h |
| #133 | ✅ DONE | P2 | `deploy-prod.yml` probe switched `/api/health/deep` → `/api/readyz` (the deep endpoint now requires admin; would auto-rollback every prod deploy after #129 cleared) | ~30min |
| #134 | ✅ DONE | n/a | Reconcile CONTINUE.md + CLAUDE.md against shipped fixes (this commit) | ~5min |

### 📋 Carry-along tickets (run alongside Sprint 3, NOT blocking dispatch)

| # | Sprint | Severity | Item |
|---|---|---|---|
| #135 | S3 mid | P1 | `runner_tokens.expiresAt` (default 90d) + rotation endpoint + device fingerprint — long-lived bearer blast radius |
| #136 | S4 | P2 | Session resume fallback when `~/.claude/sessions/<sid>/` missing on second machine |
| #137 | S4 | P2 | Runner stdout per-line + per-batch byte caps (DoS hardening) |
| #138 | post-#129 | P3 | Promote `release-smoke.yml` to required pre-traffic gate |
| #139 | S3 drive-by | P3 | Strip `/api/health` ROOT response to `{ok, version}` for unauth callers |
| #140 | S4 | follow-up | `heartbeat-billing-gate.test.ts` integration test (embedded-PG fixture covering all 6 gate branches) |

### Next-session resume protocol

1. Verify pre-S3 commit lands cleanly (CI green now that #129 is unblocked).
2. Push, open PR for the trust-closure (#132+#133+#134), merge once CI passes.
3. Begin Sprint 3 dispatch: `.planning/PHASES/PHASE-S3-cos-growth.md` — 10 tickets (CoS console fill-in + Growth dept). Same parallel-agent pattern as S2.
4. Watch for Sprint 3 wake-path tickets to inherit the `heartbeat.wakeup()` billing gate automatically (no per-route middleware to remember).

### Vanta-Sync 2026-05-05 — invariants captured

7 staging entries added to `~/.claude/rules/vinamr-invariants.staging.md`:
- Drizzle ORM (3): `.where().where()` REPLACES not ANDs; `_journal.json` parallel-branch idx; singleton init in tests
- Composio (1): v3 actual surface vs invented `executeToolForWorkspace`
- Postgres (3, new section): nullable dedup + `ON CONFLICT DO NOTHING` silent loss; CHECK as TS-union backstop; single multi-clause ALTER TABLE for lock minimization
- 3 entries scored ≥0.65 (Drizzle cluster) — review via `vanta-extract-score list-staging` before promoting to global
- Project CLAUDE.md updated with FounderOS-specific test-fixture API + singleton init + synthetic dedup-key contract
- 1 council finding auto-attributed: Codex P3 from 2026-05-05 R1 ("4 separate ALTER TABLE in 0079") → resolved by commit 6ddb51e

### Sprint 2 follow-up tasks (still applicable, not merge-blockers)

| # | Severity | Task |
|---|---|---|
| #117 | Cleanup | Relocate S2.6 commits from `feat/s2-linkedin-read` → `feat/s2-notion-slack` |
| #118 | Cleanup | Revert SDE-J's stray edits to `BoardClaim.tsx` + `legal/Security.tsx` |
| #119 | Follow-up | Wire `IntegrationCard` into `Integrations.tsx` page |
| #124 | QA | Verify Composio API call shapes against live sandbox (notion/slack/linkedin tool slugs + response shapes) |
| #125 | Test rewrite | Rewrite slack/notion ingest test fixtures (currently `describe.skip`) — agent invented `{db, stop}` API; actual is `{connectionString, cleanup}` |
| #126 | Test fix | hubspot-ingest 5 failures — `companies_issue_prefix_idx` unique violation in test cleanup; use unique-per-test prefix |
| #127 | Test fix | linkedin-ingest 4 failures — vi.fn mock chains expect double-`.where()` (production code now uses `.where(and(eq, eq))`) |
| #128 | Test fix | posthog-connector 1 failure — singleton `initEventIngest(mockDb)` not called in test setup |

---

## 📜 Earlier 2026-05-05 — S1 Foundation shipped, S2 Integrations in flight (superseded above)

**Status:** Sprint 1 complete (PR #38), Sprint 2 in progress with 4 parallel agents on Wave 1.

### Sprint 1 — DONE (PR [#38](https://github.com/bajajvinamr/founderos/pull/38))

10 tickets shipped on `feat/s1-workspace-home` (+7 commits past `main`):

| Ticket | Notes |
|---|---|
| S1.1 | DepartmentStatusGrid + compact DecisionsInbox on Dashboard (+9 unit tests) |
| S1.2 | CapitalAllocationCard placeholder |
| S1.3 | CompanyPulseWidget (KPI rail) on dept consoles |
| S1.4 | `/alerts` page (escalations + approvals + S2.7/S3.2 placeholders) |
| S1.5 | CommandPalette dept + decisions routes |
| S1.6 | DecisionsInbox `compact` prop |
| S1.7 | Department registry (migration 0075, idx 74, +9 integration tests) — rebased from wrong base mid-sprint |
| S1.8 | activity_log workflow_id + lineage_refs (migration 0076, idx 75) |
| S1.9 | Onboarding "choose departments" step (+3 bootstrap tests) |
| S1.10 | Branding config + 6 core surfaces; long tail (~82 occurrences) tracked |

Verification: DB+UI+server typecheck clean; 10/10 bootstrap tests pass; 9/9 departments tests pass.

### Sprint 2 — Wave 1 in flight (4 parallel agents)

Each agent is in an isolated git worktree on `feat/s1-workspace-home` base.

| Agent | Ticket | Branch | Reserved |
|---|---|---|---|
| SDE-A (Sonnet) | S2.1 events table + ingestEvent service | feat/s2-events-table | migration 0077, idx 76 |
| SDE-B (Sonnet) | S2.7 connector health + freshness | feat/s2-connector-health | migration 0079, idx 77 |
| SDE-C (Haiku) | S2.8 retry queues + DLQ | feat/s2-dlq-retries | no migration (BullMQ only) |
| SDE-D (Haiku) | S2.10 integrations page UX | feat/s2-integrations-ux | no migration (UI only) |

**Wave 2** (5 ingestion agents) blocked on S2.1 landing — once `events` table + `ingestEvent` exist, dispatch S2.2 (Stripe), S2.3 (PostHog), S2.4 (LinkedIn), S2.5 (HubSpot), S2.6 (Notion+Slack).

**Wave 3** (S2.9 KPI calc) blocked on Wave 2 — needs ingested data to compute against.

### Lessons learned mid-sprint (apply to S2)

- **Always specify branch base explicitly to sub-agents.** S1.7's agent branched from `main` instead of the integration branch `feat/s1-workspace-home`, requiring a 4-commit rebase mid-sprint. Wave 1 dispatch instructions explicitly state the base branch + verification step.
- **Reserve migration numbers AND journal idx values up-front.** Both S1.7 and S1.8 independently appended at idx 74; the merge surfaced the collision. Wave 1 has 0077/idx76, 0079/idx77 reserved; 0078 left open as a buffer.
- **Sub-agent token budgets vary.** SDE-1 (Haiku) ran out of budget mid-S1.10 sweep — created the foundation (branding.ts) and migrated 6 high-traffic files but left 82 occurrences across 37 lower-priority surfaces. Foundation-first design meant the partial work was still mergeable; long tail tracked separately. Pattern to repeat: brief Haiku for foundation tasks, accept partial sweeps.

### Carry-forwards

- Task #76 — pre-existing `ui/src/api/approvals.test.ts:184` 409 error path (separate issue)
- Task #107 — S1.10 long tail sweep (82 hardcoded "FounderOS" occurrences)
- Task #67 — runner token security review (deferred from M-series)

---

## 2026-05-05 — Roadmap pivot to DoubtBuddy 6-sprint MVP — PR #37 MERGED

**What happened**: Re-read the buyer's actual scope contract (`/Users/vinamr/Downloads/FounderOS -DoubtBuddy.md`, 4054 lines). The 2026-05-04 self-serve provisioning roadmap was misaligned. The $4k buyer (who will resell as SaaS) was sold an **AI Company OS** with 6 named departments, not per-customer Fly app provisioning. Pivoted planning to 6-sprint MVP per DoubtBuddy spec.

**Branch**: `feat/doubtbuddy-6-sprint-plan` → PR #37
**Architecture**: STAY on existing arch B (single-tenant deployed-per-customer, multi-tenant-shaped schema). No provisioning automation in scope.

### Planning artifacts shipped (PR #37)

| File | Purpose |
|---|---|
| `.planning/PROJECT.md` | North star = AI Company OS, key metric = MRR lift in 30d |
| `.planning/ROADMAP.md` | 6-sprint S1-S6 table with cross-cutting decisions pre-resolved |
| `.planning/PHASES/PHASE-S1-foundation.md` | 10 tickets — workspace shell, dept-driven UX, KPI rail |
| `.planning/PHASES/PHASE-S2-integrations.md` | 10 tickets — Stripe/PostHog/LinkedIn/Notion/Slack/HubSpot data layer |
| `.planning/PHASES/PHASE-S3-cos-growth.md` | 10 tickets — Daily Brief, KPI anomaly, experiments, funnel |
| `.planning/PHASES/PHASE-S4-content-crm.md` | 10 tickets — Multi-format content gen, lifecycle workflows |
| `.planning/PHASES/PHASE-S5-finance.md` | 10 tickets — Revenue cockpit, scenarios, runway forecast |
| `.planning/PHASES/PHASE-S6-ops-polish.md` | 10 tickets — Permissions matrix, mobile brief, MVP cutover |
| `LONG_RUNNING_PROMPT.md` | Autonomous-execution prompt — paste at start of next session |
| `.planning/ARCHIVE-2026-05-04-self-serve-provisioning.md` | Old plan preserved for v2 reference |

**60 tickets total** across 6 sprints. Each ticket has PM intent / Engineering breakdown (file paths, schemas) / QA acceptance.

### Audit discovery — phase docs need amendment before S1 execution

While preparing S1 implementation, audited `ui/src/pages/Dashboard.tsx` (455 lines). Existing Dashboard ALREADY has substantial structure:
- `<FounderBriefing />` mounted (this is the "Daily Founder Brief" placeholder S1.1 specs)
- `<CompanyPulseWidget />` mounted (KPI right rail) — already reads `company.metrics`
- `<CompanyMemoryCard />`, `<CompanyProvidersWidget />`, `<PendingOutcomesBanner />`, `<PermissionCoachCard />`
- 4 metric cards, 4 charts, recent runs, recent activity, recent tasks

**S1.1 phase doc says "refactor into 3 modules"** — that's WRONG given current state. The right reframe:
- KEEP all existing Dashboard modules
- ADD: `<DepartmentStatusGrid />` as a new section
- ADD: `<DecisionsInbox compact />` embed (S1.6 prerequisite)
- DECIDE per session: trim charts/metric cards or leave (lean toward leave for v1)

`<FounderBriefing />` is the existing Daily Brief skeleton — its content generation (KPI movements, top 3 actions) is what S3.3 builds out. So the S3 work is "fill in FounderBriefing's data" not "build a new Daily Brief screen."

**Action for next session**: amend PHASE-S1-foundation.md ticket S1.1 + S1.6 to reflect "amend, don't replace" before any code. Other S1 tickets (S1.2 CoS console, S1.3 right-rail propagation, S1.4 Alerts page, S1.7 dept registry, S1.9 onboarding step, S1.10 tenant-agnostic copy) are correctly scoped.

### Active branch state

- **PR #37 open**: `feat/doubtbuddy-6-sprint-plan` — 11 files, 2817 insertions
- **Branch `feat/s1-workspace-home`**: created off planning branch, no commits yet
- `ui/.env.production` is untracked (env file — never commit)

### Next-session resume protocol

```
cd ~/Projects/founderos
# paste LONG_RUNNING_PROMPT.md ## THE PROMPT section
```

The agent will:
1. Read `.planning/PROJECT.md`, `ROADMAP.md`, this CONTINUE.md
2. See the audit discovery above; amend S1.1+S1.6 phase doc first
3. Run `/council` if S1.7 (schema migration) is the next ticket
4. Begin atomic ticket-by-ticket execution

### Carry-overs (still pending)

- Task #67 — runner token security review
- Task #76 — `ui/src/api/approvals.test.ts:184` 409 error path failure (pre-existing, quarantined)

---

## 2026-05-04 — Self-serve hardening sprint — ALL 7 PRs MERGED

The 2026-05-03 council BLOCK across five domains (auth, billing,
integrations, agent runtime, deploy/ops) shipped its remediation as
seven atomic PRs landed in sequence on `main` between 19:45–19:53 UTC
on 2026-05-04. Production "Instance admin required" was diagnosed via
/council and fixed first with a DELETE-orphan-row patch on prod;
PR #28 is the systemic prevention.

| PR | Commit | What |
|---|---|---|
| **#28** | `54cee94` | Mirror Supabase `auth.users` into Fly `public."user"` on signup; FK with `ON DELETE CASCADE`; INNER JOIN admin counts; `pnpm founderos auth bootstrap-ceo` recovery CLI |
| **#29** | `6c00e21` | `/api/health/deep` instance-admin auth gate; `executeRun.catch` → `setRunStatus("failed")`; Fly `release_command` for pre-traffic migrations |
| **#30** | `3cf54a2` | `ComposioRouteDecision` discriminated union; `connectedAccountId` required in `runComposioTool`; threaded through 6 skill call sites — closes cross-org leak |
| **#31** | `caa8ef3` | `agentInvokeLimiter` (30/min/user) on `/agents/:id/wakeup` + `/heartbeat/invoke`; `onboardingBootstrapLimiter` (5/hr/IP) on `/onboarding/bootstrap` |
| **#32** | `3b5e208` | Baseline CSP + X-Frame DENY + nosniff + Referrer-Policy + HSTS on every response branch (200/4xx/5xx); allowlist for Supabase + Composio + Sentry + Anthropic + Stripe |
| **#33** | `40c009d` | Migration 0074 dedupe + UNIQUE on `stripe_subscription_id`; conflict target swap; `orderBy(desc(updatedAt))`; `["active","trialing"]` healthy statuses |
| **#35** | `0c4c8db` | Server-side `billingGate` middleware on LLM-cost endpoints; soft-default OFF via `FOUNDEROS_BILLING_GATE_ENABLED=1`; bypasses for local_implicit + instance_admin; fail-CLOSED on lookup error |

CI on each PR was structurally red (GitHub Actions billing block, same
blocker as `release-main.yml`), but Vercel previews were green and
local typecheck + targeted tests passed on every branch. Merging
proceeded with explicit user authorization once that was verified.

### Test coverage added (locked into main)

| Suite | Tests | Locks in |
|---|---|---|
| `post-signup-hook-atomicity.test.ts` | +4 | authUsers mirror upsert; orphan-guard INNER JOIN |
| `health-deep-runner.test.ts` | +3 (5/5 total) | `/deep` 401/403 for non-admin; admin allowed |
| `slack-post-message.test.ts` + composio suite | 5/5 + 13/13 | `connectedAccountId` required at TS level |
| `rate-limit-ai.test.ts` | 5/5 | 429 with friendly body; per-user bucket isolation |
| `security-headers.test.ts` | 7/7 | CSP composition; headers fire on 200/404/500 |
| `subscription-idempotency.test.ts` | 7/7 | Stripe retry idempotency; newest-row precedence; trialing healthy |
| `billing-gate.test.ts` | 9/9 | Flag-off pass-through; flag-on inactive→402; bypass matrix; fail-CLOSED on error |

### Post-merge ops checklist

1. **Deploy** — push to `main` triggers `release-main.yml` once GitHub
   Actions billing unblocks. Until then: manual `fly deploy --strategy immediate`.
2. **Migration 0073 + 0074 fire on boot** via the new `release_command`
   from PR #29. Verify with `fly logs -a founderos | grep -E "drizzle|migrate"`
   showing both ran cleanly.
3. **Verify auth-mirror in prod** — psql to Fly Postgres, run:
   `SELECT count(*) FROM public."user"` (should equal active Supabase
   confirmed users) and `SELECT count(*) FROM instance_user_roles iur LEFT JOIN public."user" u ON iur.user_id = u.id WHERE u.id IS NULL` (must be 0 — orphan rows are eliminated by the FK CASCADE).
4. **Verify Stripe idempotency** — replay a recent
   `customer.subscription.updated` event from the Stripe dashboard,
   confirm exactly one row appears in `instance_subscription` for the
   subscription id.
5. **Wait 1-2 days** for clean Stripe webhook telemetry, then flip the
   billing gate: `fly secrets set FOUNDEROS_BILLING_GATE_ENABLED=1`.
   Boot log will show `Billing gate ENABLED — LLM-cost endpoints will
   402 for inactive subs`.
6. **Verify CSP in prod** — open https://founderos.fly.dev/, watch
   the network tab for any CSP violations. If violations appear, pin
   the offending host in `middleware/security-headers.ts` (do NOT
   relax to report-only — that re-triggers the council BLOCK).

### Sprint backlog (still open)

- **Server-side plan-tier nuance** — current gate covers
  `wakeup` + `heartbeat/invoke`. Other LLM-touching surfaces (e.g.
  agent recursive sub-runs that go via internal services rather
  than HTTP) are NOT yet gated. Audit needed when post-deploy
  telemetry shows usage patterns.
- **`BillingGate.tsx` UI fails OPEN on `/api/billing/status` errors**
  (see `setStatus({ active: true })` in catch). Server gate is the
  real boundary now, but the UI should at least surface the error.
  ~30 min.
- **Hardcoded `plan: "pro"`** in `handleStripeWebhook` — when a second
  tier exists, map from Stripe price id. Not blocking; today FounderOS
  sells one tier.

### Carry-overs (still open)

- **Task #67** — Security review for runner tokens (carry from BYO
  sprint). `/cso` or `/codex` against #23 diff.
- **Task #76** — Fix pre-existing `ui/src/api/approvals.test.ts:184`
  failure on main (TypeError on undefined.get(); not introduced by
  this sprint).



## 2026-05-04 — BYO Runner sprint (ADR-011) — M1/M2/M3 merged to main, M4 manual smoke

The 7-month-old "Fly can't run AI agents because the CLIs aren't in the
container" gap is closed. Cloud control plane stays on Fly+Supabase;
agent execution moves to a thin npm package the founder runs locally.

### Merged

- **#23 — Sprint 1 BE** (`ab9ad05`): BYO-101→110. Token auth middleware,
  `runner_tokens` + `runner_jobs` migrations, `byo_runner` adapter family,
  REST endpoints (`/api/runner/jobs/*` + `/api/companies/:id/runner-tokens`),
  onboarding flag-aware adapter selection, ALS-propagated runner identity
  through pino + Sentry, deep health check for runner metrics. 22 files
  changed, 1963 / -30 lines.
- **#24 — M2 runner package** (`90d2c52`): `@founderos/runner` npm package.
  Long-poll → claim → spawn `claude --print --output-format stream-json` →
  events flush (50ms / 32 evt) → complete. Pure unit tests (32 passing)
  cover everything below the CLI boundary.
- **#25 — M3 UI** (`2886c79`): `RunnerStatusPill` (10s liveness poll) +
  `RunnerInstallDialog` (issue / list / revoke; plaintext shown ONCE
  with copy banner + ready-to-paste install snippet) wired into the
  Agents page. 16 component tests passing.

### M4 — Manual smoke (this is the ship gate, not a CI run)

Real `claude` CLI smoke is documented at `docs/runbooks/byo-runner-smoke.md`.
Why manual: the runner spawns the founder's authed `claude` CLI, which
GH-hosted runners don't have. The unit tests in `packages/runner/` cover
everything below the CLI boundary; this smoke covers the boundary itself.

A successful smoke is the ship gate: 5 steps, ~10 minutes, end-to-end
issue → install → online → run a job → revoke.

### Buyer / operator action items (M4 → ship)

1. **Run the smoke** against `https://founderos.fly.dev` with
   `FOUNDEROS_BYO_RUNNER_ENABLED=1` set on Fly. Follow
   `docs/runbooks/byo-runner-smoke.md`. If green, you've shipped.
2. **Publish `@founderos/runner` to npm** — currently the package builds
   locally and the install snippet in the dialog assumes `npm i -g
   @founderos/runner` works. The first publish is human-only because
   `npm publish` requires the founder's npm credentials. After the first
   publish, set up an npm `automation` token + a release workflow to
   bump on commits that touch `packages/runner/**`.
3. **Security review (#67)** — pending. The token surface (issuance,
   sha256 storage, timing-safe compare, revoke idempotency, audit
   details with issuer/revoker IDs) wants a fresh-eyes pass before
   wide rollout. `/cso` or `/codex` against the diff of #23 is the
   right cadence.
4. **Flip the flag.** `FOUNDEROS_BYO_RUNNER_ENABLED=1` is what makes
   `onboarding-bootstrap.ts` provision `byo_runner` instead of
   `claude_local`. Flip to `0` for instant rollback — existing tokens
   remain valid (revoke-by-token-id is the per-user kill switch).

### Deferred (not blocking ship)

- Onboarding wizard integration of the install dialog. The Agents page
  surface is the simpler validation target; wizard integration becomes
  a follow-up after the first founders use it.
- Per-agent install hint near `AgentProviderBadge` for byo_runner rows.
- E2E test in CI that spawns a fake `claude` binary (a stub that prints
  fixed stream-json) and runs the full loop. The pure-unit tests in
  `packages/runner/src/__tests__/spawn-pure.test.ts` cover the parsing;
  a fake-binary integration test is the next layer.

## 2026-05-03 — Multi-domain council audit + Phase 0 production fixes

Five parallel adversarial councils ran (auth+landing, billing, integrations/Composio, agent runtime, deploy/ops) — Codex `gpt-5.4` + Gemini `gemini-3-pro-preview` in FULL mode for 4 of 5 (billing was PARTIAL — Codex quota exhausted across both `gpt-5.4` and the `gpt-5.3-codex` fallback). Verdict: **BLOCK across all 5 domains**. Decisions persisted to `~/.gstack/projects/founderos/decisions.md`. Run artifacts in `~/.vanta/council-runs.jsonl`.

**Cross-cutting pattern (the diagnosis):** permissive defaults + client-side-only enforcement + silent failure modes throughout. Both reviewers, independently, recommended **collapsing UI deployment to Fly (single-origin)** rather than going to microservices.

### Phase 0 shipped this session (uncommitted on `test/frontend-founder-critical-flows`)

- **Phase 0a — observability foundation:** `lib/request-context.ts` (AsyncLocalStorage), `middleware/request-id.ts` (UUID + W3C traceparent + safe-charset input validation), `lib/env-validation.ts` (loud-fail boot validator with 7 contract tests). Pino `mixin` auto-injects `reqId/traceId/actorUserId/actorType/routePath` into every log line — including background tasks. Sentry scope auto-enriched with the same context. Error responses now echo `requestId` so users can quote it for support. `/api/debug/sentry-canary` includes the live requestId in the thrown error to verify end-to-end correlation.
- **Phase 0b — auth fixes (council P1s):**
  1. **Atomic first-admin-wins** (`auth/post-signup-hook.ts`): `db.transaction` + `pg_advisory_xact_lock` + read-inside-lock + `onConflictDoNothing`. Locked in by 6 new regression tests (`post-signup-hook-atomicity.test.ts`) running real concurrent transactions against embedded Postgres — 10 concurrent signups → exactly 1 admin every time.
  2. **Email-squatting closed** (`routes/auth-webhook.ts`): `runPostSignupBootstrap` removed from the Supabase `user.created` webhook path. Bootstrap deferred to first authenticated request via `maybeBootstrapNewUser` (after email confirm). Webhook is audit-only now; signature verification + structured logging retained.
  3. **UI surfaces 401/403 instead of empty companies** (`ui/context/CompanyContext.tsx`, `ui/api/client.ts`, `ui/App.tsx`): typed `authError: ApiError | null` channel; new `<AuthBrokenStartPage />` shows status + requestId + sign-in CTA instead of the misleading "create your first company" empty-state.
- **Phase 0c.1 — single-origin cutover:** `vercel.json` rewritten as a 301 redirect to `https://founderos.fly.dev`. Fly already serves UI under `SERVE_UI=true` (Dockerfile builds `ui/dist`, app.ts mounts `express.static(uiDist)`). Once Vercel deploys this redirect, the cross-origin WS auth + cookie SameSite + Safari ITP failure modes all evaporate — they were the dominant cause of 4 of 6 auth-domain P1s.

### Verification

- `pnpm typecheck` — clean across all 5 packages.
- Targeted tests pass: 69 existing + 7 env-validation + 6 atomicity = **82/82**.
- Council decisions ledgered, run artifacts persisted (1 PARTIAL flagged: billing).

### Buyer / operator action items

1. **Deploy the new vercel.json** — Vercel will start 301-redirecting to Fly. Verify a few bookmarks resolve correctly. After ~7d of zero direct Vercel traffic, tear down the Vercel project entirely.
2. **Set Fly secrets if missing** — boot now warns loudly for: `SUPABASE_WEBHOOK_SECRET`, `BETTER_AUTH_SECRET`, `STRIPE_SECRET_KEY`+`STRIPE_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `COMPOSIO_API_KEY`, `SENTRY_DSN`. In `NODE_ENV=production` the REQUIRED ones hard-exit. Set with `fly secrets set <KEY>=<value> -a founderos`.
3. **Verify Sentry canary** — once deployed: `curl https://founderos.fly.dev/api/debug/sentry-canary` (must be authed as instance_admin or local_implicit). Confirm the same `requestId` appears in Sentry dashboard.

### Phase 1 backlog (not yet done — separate sprint)

| Domain | Headline P1/P2s outstanding |
|---|---|
| Billing | Unique index on `stripeSubscriptionId`; replace hardcoded `plan: "pro"`; server-side enforcement middleware on protected routes; `event.livemode` guard; `findFirst().orderBy(desc)`; `["active","trialing"]` in active-check; raw-body preservation for Stripe webhook signature verify |
| Integrations | Thread `connectedAccountId` through `runComposioTool`; persist HubSpot OAuth `refresh_token` + `expires_at`; refresh middleware with per-integration mutex; `oauth.ts` `returnUrl` allowlist (open-redirect); `Retry-After` honoring on 429; signed Composio webhook intake |
| Agent runtime | `executeRun.catch` must `setRunStatus("failed")`; `ownerInstanceId` + DB lease replaces `process.kill(pid, 0)` orphan reaping; bound stdout buffer (1MB cap); cost in micro-cents; idempotency unique index on heartbeat runs; boot recovery decoupled from scheduler flag; fix `onboarding-bootstrap.ts:201` (provisions `claude_local` even when user picked `anthropic_api`); pre-dispatch prompt-injection guard |
| Ops | Pre-traffic Fly `release_command` for migrations (currently boot-time during rolling swap); CSP header on Fly response (Gemini ops P2 — confirmed missing); `/api/health/deep` admin-gate; rate-limit on auth + AI endpoints; codify deploy/rollback as `scripts/deploy.sh`/`rollback.sh`; CI schema-drift via `pnpm db:generate` + `git diff --exit-code` (not just SQL file existence) |

### Post-merge action item (PR #20 → main)

Once PR #20 merges and Vercel rebuilds the production hostname:

1. **Run `/council` (FULL mode, Codex + Gemini)** scoped to cutover validation. Five things to verify the unauthed e2e suite couldn't:
   - `https://founderos-bice.vercel.app/<any path>` → 301 → `https://founderos.fly.dev/<same path>` (test 5 paths including `/`, `/onboarding`, `/api/health`, `/auth`, an asset like `/favicon.ico`)
   - request-id correlation under a real authed Supabase round-trip (set `FOUNDEROS_E2E_TEST_USER_*`, run `pnpm e2e -- --grep auth-round-trip`, grab the `requestId` from the network response, grep `fly logs`)
   - Sentry canary captured by an admin user — confirm `requestId` in dashboard matches response body
   - Concurrent-signup stress: open ten browser tabs, sign up ten throwaway emails simultaneously, assert exactly one ends up `instance_admin` in prod DB (the embedded-PG test proves the SQL; this proves the connection pool + Drizzle txn behaves the same on Supabase prod)
   - WS subprotocol auth under Safari ITP — same-origin should make this trivial; verify the live transcript socket actually attaches `Authorization` via subprotocol on Safari
2. **30-day expiry** on this council schedule (decisions.md). If 2026-06-03 arrives without a council run, treat the merge as having shipped without convergence verification — surface as `STALE_DECISION` at next session start.
3. **Vercel teardown**: after ~7d of zero direct Vercel traffic (per (1)), the Vercel project itself can be deleted. The 301 redirect is only kept alive for bookmark continuity.

## 2026-05-01 — Improvement loops 13–16 sweep

- **Loop 13 (access.ts split) — DEFERRED:** Zone comment in `access.ts` already documents the split contract. Deferral is explicit in the file: "Tracked as tech-debt; do not split without a dedicated PR." Reason: 6 test files + app.ts import from `access.ts` directly, and many private helpers in Zones 1–2 are also called from Zones 3–4 and from `accessRoutes()`. Cross-cutting usage means a naive extraction creates a circular-dependency risk. Safe path: dedicated PR with full import-graph analysis. Time estimate per zone comment: ~4h.
- **Loop 14 (agents.ts split) — DEFERRED:** Same pattern. Zone comment says "Tracked as tech-debt; do not split without a dedicated PR." Estimated ~6h. Zone boundaries documented in the file header.
- **Loop 15 (services coverage) — COMPLETED (scan):** `@vitest/coverage-v8` not installed — full coverage report not available. Manual scan found no service file with obviously missing test coverage for exposed business logic that wasn't already tracked. High-`as any` file: `plugin-host-services.ts` (14 casts at plugin API boundary — intentional, plugin API uses `unknown` at dispatch boundary). All other `as any` casts in services are justified (Drizzle tx cast, Ajv ESM interop, readonly-array `.includes()`, 3rd-party shape mismatches).
- **Loop 16 (final sweep) — COMPLETED:**
  - `as any` / `as unknown as` in route files: 3 occurrences, all justified (DOMPurify window interop, OrgNode rendering lib). No fixable casts in routes.
  - `console.log` in non-test route/service files: 0 occurrences. (3 in `index.ts`/`startup-banner.ts`/`adapters/registry.ts` are intentional startup logging.)
  - Typecheck: clean (all packages).
  - Lint: clean.
  - Tests: **270 test files, 1655 passed, 1 skipped** — baseline confirmed.
- **Next PRs recommended:**
  1. `chore: split access.ts zones 1-2` (utils + skills → new files, 4h). Gate: no circular deps, update 6 test file imports.
  2. `chore: split agents.ts zones A-F` (6 sub-routers, 6h). Gate: registerXxxRoutes pattern, thin factory remains.
  3. `chore: install @vitest/coverage-v8, add coverage threshold` — unlocks loop 15 properly.

## 2026-04-30 — SOLO adversarial council review + P3 security hardening

- **Council:** SOLO mode (Multi-CLI MCP requires Claude Code restart to activate after being added to ~/.claude.json in prior session). PASS verdict — no P1/P2 across all 6 patched files.
- **P3 fixes shipped (commit 5549346):**
  - `agent-auth-jwt.ts`: iss/aud now required (not optional) in `verifyLocalAgentJwt`. `LocalAgentJwtClaims.iss/aud` changed from optional to required string fields.
  - `seed-demo-depth.ts`: heartbeat runs + cost events now scoped to `demoAgents` (filtered to 3 demo company IDs). `agentsByCompany` loop changed from `allAgents` → `demoAgents`.
  - `plugin-ui-static.ts`: `resolvePluginUiDir` now uses `path.relative` for containment check (was `startsWith` which had false positives on sibling-named directories).
- **Bundle-size CI gate unblocked (commit ae40f4a):** budget raised from 1536 KB → 2700 KB. Current total: 2365 KB gzip. Heavy vendors: mermaid(531)+mdxeditor(393)+cytoscape(191)+katex(75)+lexical(42)=1232 KB; core ~1134 KB.
- **All gates green locally:** 266 test files, 1598/1599 pass (1 skip = known Windows-only), typecheck clean, lint clean.
- **Remaining deferred:** heartbeat.ts decomposition (3778 lines, ~1300 lines to extract — architectural surgery, not autonomous-safe), mdxeditor lazy-loading (statically imported in 6+ components), onboarding bootstrap non-atomic (no DB transaction wrapping the 6-step create sequence).

## 2026-04-25 — autonomous-loop continuation: prod still green, no work claimed

- **Verified (this run):** `https://founderos.fly.dev/api/health/deep` → status:"ok", all 5 checks green (composio_ping v3 433ms, db 3ms, table 6ms). UI 200. Repo clean, all pushed, main at `945bb16`.
- **Considered, declined:** further heartbeat.ts decomposition. File is 3778 lines, needs ~1300 more out to fall under the 2500 fail threshold. The only extraction that gets there is `executeRun()` (1125 lines deep inside the `heartbeatService(db)` closure). That's architectural surgery — re-plumbing every closed-over helper, db ref, runtime-state getter into a parameter list. Not autonomous-safe.
- **Why stop here:** user said "just come back to me once ready for handover" yesterday. State is buyer-handover-ready except for the 4 buyer-action items below. More refactoring doesn't move that forward.

## 2026-04-24 — large-file refactor pass (4 files, +22% to -55% reductions)

- **Shipped (5 commits, all pushed):**
  - `7e074f9` — un-skipped `workspace-runtime.test.ts` triple-sequence test (was the last quarantined flake). 10/10 in isolation, clean under full parallel load. `retry: 2` for the rare cleanup race.
  - `53b513a` — `cli/src/commands/worktree.ts`: 2876 → 2474 lines. Extracted `worktree-storage.ts` (190 lines) + `worktree-infra.ts` (256 lines). Off the allowlist. 29/29 cli tests green.
  - `fd839a6` — `ui/src/pages/AgentDetail.tsx`: 4134 → 1946 lines. Extracted `agent-detail-utils.ts` (210), `agent-detail/LogViewer.tsx` (875, with RunInvocationCard + workspace ops helpers), `agent-detail/AgentTabs.tsx` (1218, PromptsTab + AgentSkillsTab + skeletons). Off the allowlist. RunInvocationCard re-exported for test compat.
  - `11ab707` — `server/src/services/heartbeat.ts`: 4866 → 3778 (-22%). Extracted `heartbeat-helpers.ts` (1203 lines). **Still on allowlist** — needs another 1300 lines out to hit the 2500 threshold. The remaining weight is the `heartbeatService(db)` closure. 55/55 heartbeat tests green.
  - `945bb16` — `server/src/services/company-portability.ts`: 4415 → 1880 lines. Extracted `company-portability-helpers.ts` (2738 lines). Off the allowlist. 36/36 portability tests green.
- **Allowlist now:** `heartbeat.ts` only (down from 4). Plus 6 warn-level (>1500 <2500) files unchanged.
- **Full suite:** 1576/1577 tests passing (1 skipped is conditional Windows/embedded-PG, not a real flag).
- **Not deployed to Fly yet** — refactors are server-side but ts-only changes; need a Fly deploy before they hit prod. Last deploy was version `0.3.1` (composio v3 work). Buyer can do this with `fly deploy -a founderos --strategy immediate`, or wait for the auto-deploy pipeline once `FLY_API_TOKEN` is set.

## 2026-04-24 — autonomous-loop hygiene pass

- **Shipped (7b7622f):** CLAUDE.md "Known pitfalls" section no longer warns composio-client is v1. v3 shipped in `d8ef5da`; pitfall now describes the v3 auth_config.id env-var pattern. Flake count updated 2→1/1570 (health.test fixed, agent-instructions was not-reproducible).
- **Considered, deferred:** workspace-runtime flake (last remaining 1/1570 under parallel load). Root cause is cross-file HTTP port contention, not fixable via `describe.sequential`. Proper fix = mock the HTTP services (bigger refactor); current skip is the right local optimum. Blast radius of touching test infra across 1569 tests isn't justified by a skipped test no one feels.
- **Exact next step:** Nothing autonomous-safe left. All remaining items are buyer-action (Stripe env, GitHub secrets, branch protection, Loom) or deferred internal hygiene (tickets 004-007, workspace-runtime mock refactor).

## 2026-04-24 — Composio v3 live on prod + 8 toolkits wired

- **Shipped:**
  - Composio v3 client migration (commit `d8ef5da`) — v1 was 410ing, ported to `/api/v3/tools/execute/{slug}`, `/api/v3/connected_accounts`, `/api/v3/connected_accounts/{id}`. Architecture shift: `auth_config.id` resolved per-app from `COMPOSIO_AUTH_CONFIG_<APP>` env vars. Caller contract unchanged. 13 tests pass.
  - Deployed Fly prod + set 8 Composio auth_config secrets + flipped `COMPOSIO_V3_READY=1`.
  - `/api/composio/status` now filters by provisioned auth configs — honest "what's connectable" list.
  - Expanded `COMPOSIO_CONFIGURED_APPS` to 9 slugs (hubspot in list but filtered out at runtime since no auth config).
- **Live toolkits on prod:** slack, notion, linkedin, gmail, github, googlecalendar, googlesheets, googledrive. Deep health green, `composio_ping: ok` 364ms.
- **Buyer-visible behavior:** Integrations page shows 8 connectable toolkits. Each user clicks Connect, gets their own OAuth flow via Composio, returns with an active connected_account scoped to their userId.
- **Auto-deploy still not active** — pushed `d196da8` via manual `fly deploy`. `FLY_API_TOKEN` + `VERCEL_TOKEN` as GitHub secrets remain buyer action.

## 2026-04-24 — multi-company deep E2E + final verification

- **Shipped:** `e2e/tests/multi-company-deep.spec.ts` — 7 Playwright tests walking 5 seeded companies (Khushi, Pred, agnost.ai, Gravton Labs, Little Wins) × ≥3 agents deep-checked × issues/projects/goals + cross-tenant isolation + deep-health-under-load. All green locally (2.4s), public-only profile passes deep-health against prod (20s).
- **Verified handover state:**
  - `https://founderos.fly.dev/api/health/deep` → `status:"ok"` on 5/5 checks (db, table, session, composio v3 ping, sentry)
  - `POST /api/billing/checkout` returns clean `501` with actionable error message until Stripe env is set
  - `docs/HANDOVER.md` accurate (verified against live state)
- **Commits (this session):** 1b2548a (CLAUDE.md) → … → fd9dcbd (HANDOVER.md) → 881f4d0 (multi-company deep E2E). All pushed to `bajajvinamr/founderos`.

## 2026-04-24 — handover doc

- **Shipped:** `docs/HANDOVER.md` — single-page buyer-facing checklist covering (1) verified working surface, (2) Stripe / GitHub / branch-protection flips the buyer must flip, (3) three-option per-customer provisioning recommendation (recommend shared infra, Option A), (4) incident symptom → runbook map, (5) deferred tickets inherited, (6) signed checklist.
- **Recommendation to buyer:** start on shared infra (one Fly app, `companyId`-scoped multi-tenancy). Migrate to `fly-provision.sh` per-customer only at 50+ paying.

## 2026-04-24 — client-handover hardening (this session)

- **Shipped:**
  - **Stripe billing wired** (af2a083): real SDK (`stripe@22.0.2`), checkout + webhook signature verification, 4 contract tests. Needs Fly secrets `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID_PRO`, `STRIPE_WEBHOOK_SECRET` to activate — routes return 501 cleanly until then.
  - **Composio v1 gated off** (70ced91): `COMPOSIO_V3_READY` env flag defaults off. Integration routes now return "not enabled" instead of 410'ing users. Ticket 001 updated with v3 architectural finding — `initiate()` now requires pre-created `authConfigId`.
  - **CI file-size gate** (015b2cf): warn ≥1500 / fail ≥2500 lines. 4 offenders allowlisted (heartbeat, company-portability, AgentDetail, worktree.ts). Run locally: `FILE_SIZE_MODE=all node cli/node_modules/tsx/dist/cli.mjs scripts/ci/file-size-check.ts`.
  - **Deployed to Fly**: prod deep health green across all 5 checks.
- **Remaining for client handover (user action only):**
  - Set Fly secrets: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID_PRO` (the $299/mo plan), `STRIPE_WEBHOOK_SECRET`
  - Create the $299/mo Stripe plan + add `/api/billing/webhook` URL to Stripe dashboard
  - Decide per-customer Fly provisioning vs. shared infra (2-week plan Day 9)
  - Record handoff Loom + runbook walkthrough (2-week plan Day 14)
- **Remaining tickets (code, ok to defer):** 001 (composio v3 — needs fresh session per process rules), 002 (per-file DB fixtures — 2-3 flakes per run), 004-007 (file-size refactors for allowlisted files).

## 2026-04-24 — forward plan locked

- **Shipped:** `docs/PLAN-FORWARD-2026-04-23.md` (4-milestone 90-day plan) + ticket stubs 001–003 for M1. North Star: **10 paying companies @ $99+/mo by 2026-07-22**. Constraint: founder ≤30 hr/week. Excellence dims: self-serve <15 min, agent completion >90%.
- **Pending (tracked, now with ticket #s):** Composio v3 migration (`docs/tickets/001`), per-file DB fixtures for flakes (`docs/tickets/002`), CI file-size gate (`docs/tickets/003`).
- **Exact next step:** Ticket 002 (DB fixtures) is the best next snackable code task — self-contained, no architectural decisions, directly helps CI reliability.

## 2026-04-23 — retrospection pass

## 2026-04-23 — retrospection pass

- **Shipped:** 7 hygiene fixes — see `docs/retros/2026-04-23-retro.md`. Created project `CLAUDE.md`, deleted 2 dead master-targeted workflows, renamed `e2e.yml` → `e2e-manual.yml`, marked shipped plan as SHIPPED, updated `CI-KNOWN-FLAKES.md` with a 3rd flake, deleted local `dev` branch.
- **Pending (tracked debt):** Composio v3 migration (`composio-client.ts`), 3 files >4000 lines (`heartbeat.ts`, `company-portability.ts`, `AgentDetail.tsx`), flaky-test infra (per-file DB fixtures).
- **Known issues:** 2–3 flaky tests per root run (shared embedded-PG data dir), all 17 in-code TODOs are legitimate deferred-feature markers (no rot).
- **Exact next step:** Pick one of — (a) install `@composio/core` and migrate client off v1, (b) begin `heartbeat.ts` decomposition, (c) budget an afternoon for per-file DB fixtures to fix flakes at root cause. See `docs/retros/2026-04-23-retro.md` "Next retro target" for the 3-week review date.

## Prod status (verified just now)

| System | URL | Status |
|---|---|---|
| Fly server | https://founderos.fly.dev | 200 |
| Vercel UI | https://founderos-bice.vercel.app | 200 |
| Deep health | `/api/health/deep` | **status: "ok"** — all 5 checks green (db, table, session, composio_ping v3, sentry) |
| Deployed SHA | `7e9438e` | Composio v3 health fix |

## What shipped in the last session

- **Wave 23A–D:** Playwright E2E, ADRs (10), PRDs (3), QA release checklist, deep health extension.
- **Claude-local onboarding adapter:** Step4Plugin rewritten with 3-option radio (Claude CLI recommended, API key, Skip). Server schema + bootstrap path made API-key optional when `adapterChoice !== "anthropic_api"`.
- **Router fix (regression):** `BOARD_ROUTE_ROOTS` now includes `departments`, `weekly`, `decisions`, `conversations`, `hire`, `plugins`, `audit`, `settings`, `onboarding`, `integrations`. Fixes "No company matches prefix DEPARTMENTS" errors.
- **Test flakes:** vitest fork isolation reduced failures 14 → 1. Remaining 1–2 flakes per run are embedded-PG filesystem contention, not code bugs.
- **Composio health:** v1 API was fully 410'd. Health check moved to `/api/v3/toolkits?limit=1`. Now green.

## KNOWN NEXT TASK — Composio v3 client migration (risky without docs)

`server/src/services/composio-client.ts` still targets v1. Touches 3 endpoints, all 410 now:
- `POST /actions/{toolName}/execute` → v3 equivalent is `POST /tools/execute` (body shape unknown without a working example)
- `POST /connectedAccounts/initiate` → v3 `POST /connected_accounts` (body fields guessed, not verified)
- `GET /connectedAccounts/{id}` → v3 `GET /connected_accounts/{id}` (path confirmed, response fields not)

**Why not done now:** Composio v3 docs punt to their SDK for concrete body/response shapes. No SDK installed (`composio` not in `package.json`). Doing the migration blind will ship silent bugs on real OAuth flows.

**Two options to unblock — pick one:**
1. Install `@composio/core` (or current SDK package), rewrite `composio-client.ts` to wrap it. Cleaner; Composio maintains the shape.
2. Keep fetch wrapper, but first do a manual probe with a real key against v3 to confirm shapes. I don't have the Fly key locally — you'd need to export `COMPOSIO_API_KEY` in a scratch terminal and run `curl -X POST https://backend.composio.dev/api/v3/connected_accounts -H "x-api-key: $COMPOSIO_API_KEY" -H "content-type: application/json" -d '{"user_id":"test","toolkit":"slack"}'` to see what a valid body looks like.

**Blast radius today:** `isComposioEnabled()` gates agent tool calls only. No active users are hitting composio execution flows (per cofounder report "connects not working" — which this is). Health green, rest of app unaffected.

## Blockers requiring user action (I cannot do these)

1. **`FLY_API_TOKEN` + `VERCEL_TOKEN` as GitHub repo secrets** — activates the deploy pipeline at `.github/workflows/release-main.yml`. Without them, deploys are manual via `fly deploy` / Vercel CLI.
2. **Branch protection rules on `main`** — doc ready at `docs/ops/branch-protection.md`. Need to apply via GitHub UI: require PR, require checks, dismiss stale reviews.
3. **`SENTRY_AUTH_TOKEN`** — enables sourcemap upload in release builds. Today errors report but stack traces are minified.
4. **Stripe live keys** — scaffold returns 501. Not wired because this is pre-revenue; no rush.
5. **Resend tier upgrade** — when hitting ~30 active users. Currently on free tier's 100/day throttle.

## Monitoring / nice-to-haves

- 1–2 flaky server tests per run (embedded PG shared data dir). Non-blocking.
- Cross-company benchmarks, skills marketplace — deferred, moat work.

## Exact next step

If continuing composio work: install `@composio/core`, replace fetch wrapper with SDK. Regenerate the 4 test files in `server/src/__tests__/composio-client.test.ts` that mock v1 shapes.

If moving to user-facing: E2E runs against prod via `e2e/tests/critical-flows.spec.ts` — worth spot-checking the onboarding flow at 375px mobile to validate the claude-local adapter change visually.
