# Agent Report: Observability/SRE + E2E

_Generated 2026-05-06. Scope: `observability_health`, `deployment_startup`, `e2e_critical`, `audit_logs`. Code-only review, no edits._

## Scope Reviewed

- Health/readiness/liveness endpoints — `server/src/routes/health.ts`, `server/src/app.ts:295-324`.
- Env validator — `server/src/lib/env-validation.ts`, invocation site `server/src/index.ts:95-98`.
- Cron services — 8 files under `server/src/services/*-cron.ts` plus `server/src/index.ts:709-808` scheduler block.
- Error handler / Sentry — `server/src/middleware/error-handler.ts`, `server/src/middleware/sentry.ts`, `server/src/observability/sentry.ts`, `server/src/lib/request-context.ts`.
- E2E configs + quarantines — `e2e/playwright.config.ts`, `tests/e2e/playwright.config.ts`, `e2e/tests/`, `tests/e2e/`.
- CI workflows — `.github/workflows/`, `.github/workflows/README.md`.
- Audit log call sites — `server/src/routes/runner.ts`, `server/src/services/agents.ts`, `server/src/middleware/billing-gate.ts`, `server/src/services/magic-link.ts`, `server/src/services/budgets.ts`.

## Top Findings

### Finding 1 — Domain-cron `setInterval` callbacks bypass `runInCronContext`; Sentry + pino correlation tags emit empty for every cron tick

- Severity: P1
- Category: structured-logging
- Graph node: observability_health, audit_logs
- File(s):
  - `server/src/services/slack-daily-summary-cron.ts:183-190`
  - `server/src/services/daily-digest-cron.ts:183`
  - `server/src/services/decision-followup-cron.ts:81`
  - `server/src/services/hubspot-sync-cron.ts` (no setInterval pattern shown but consistent with siblings)
  - `server/src/services/linkedin-sync-cron.ts:109`
  - `server/src/services/notion-sync-cron.ts:108`
  - `server/src/services/slack-sync-cron.ts:108`
  - `server/src/services/weekly-wrap-delivery-cron.ts:318`
- What is wrong: `runInCronContext` is the canonical wrapper that injects a synthetic requestId/traceId AND `actor: { type: "system", source: "cron:<name>" }` (`server/src/lib/request-context.ts:70-84`). It is used correctly by the heartbeat / routine / database-backup ticks (`server/src/index.ts:716, 729, 742, 804`) but every domain cron uses naked `setInterval(() => void tick().catch(...))`. Inside `tick()` `getRequestContext()` returns `undefined`, so the pino mixin emits no requestId/traceId and `captureServerError` writes a Sentry event with empty `requestId`, `traceId`, `routePath`, and `actorType` tags.
- Why it matters: CLAUDE.md explicitly states "cron ticks fall outside ALS — explicit `actor: { type: 'system' }`" is required. When a Slack daily-summary fails for one company at 09:00 PT, ops cannot grep `requestId` to bind logs to a Sentry event because both are blank. Per the FOUNDEROS-CRITICAL-FLOWS.md §16 invariant, this is a stated guarantee — it is currently false for 7 of the 8 schedulers.
- Evidence: `rg -n "runInCronContext" server/src/services/*-cron.ts` returns zero hits; only `server/src/index.ts` and `server/src/app.ts:588` (feedback-export-flush) wrap correctly.
- Suggested fix: wrap each `setInterval` body in `runInCronContext("<cron-name>", () => { void tick().catch(err => log.error(...)) })`. Mechanical port from `index.ts:716-727`.
- Effort: small (one-line change per cron × 7 files).
- Safe to fix now? yes.

### Finding 2 — Cron failures never reach Sentry; only pino `log.error`

- Severity: P1
- Category: structured-logging
- Graph node: observability_health
- File(s):
  - `server/src/services/slack-daily-summary-cron.ts:162, 185`
  - `server/src/services/daily-digest-cron.ts:162, 185`
  - `server/src/services/weekly-wrap-delivery-cron.ts:299, 320`
- What is wrong: `rg -n "captureException|captureServerError" server/src/services/` returns zero hits. The HTTP path captures via `server/src/middleware/sentry.ts:28`, but cron ticks throw → are caught by `.catch(err => log.error(...))` and the Sentry pipeline never sees them. Combined with Finding 1, a failing cron is invisible in Sentry and untaggable in pino.
- Why it matters: design-partner SLA-relevant flows — Slack daily-summary, daily-digest, weekly-wrap delivery — fail silently. Operators only learn about the miss when a founder asks "where's my Monday brief?".
- Evidence: see grep above; combined with `server/src/observability/sentry.ts:78` showing `captureServerError` exists but is never called outside `middleware/sentry.ts`.
- Suggested fix: add `captureServerError(err, { cron: "<name>" })` next to each `log.error(...)` in cron error branches; pair with Finding 1 so the captured event has full context.
- Effort: small.
- Safe to fix now? yes.

### Finding 3 — Critical secrets are NOT validated at boot

- Severity: P1
- Category: env-validation
- Graph node: deployment_startup
- File(s): `server/src/lib/env-validation.ts:35-136`
- What is wrong: the `CHECKS` table covers `BETTER_AUTH_SECRET` (REQUIRED_IN_PROD), Stripe pair (WARN), `ANTHROPIC_API_KEY` (WARN), `COMPOSIO_API_KEY` (WARN), `SENTRY_DSN` (WARN), `EMAIL_UNSUBSCRIBE_SECRET` (WARN). Missing entirely:
  - `OPENAI_API_KEY` — used at `server/src/services/provider-credentials.ts:99`, `server/src/adapters/codex-models.ts:35`; FOUNDEROS-CRITICAL-FLOWS.md §17 explicitly calls out "embedder service references it; missing key falls back to local hashing — must be visible".
  - `RESEND_API_KEY` — `server/src/jobs/content-publish-tick.ts:32`, `server/src/services/email-sender.ts:27`, `server/src/services/transports/email-transport.ts:163`. CAN-SPAM-relevant outbound mail silently capture-modes when missing (`email-transport.ts:173-174`).
  - `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` — `server/src/config.ts:251-253`. In Fly's authenticated mode, missing `SUPABASE_URL` throws at runtime (`index.ts:530-531`), but is not pre-flagged by the validator banner.
- Why it matters: per CLAUDE.md operator discipline, "Env var validation at startup. For any env var that gates a critical feature (payments, error tracking, analytics), add a startup check that warns loudly when it's missing." Today, an operator deploying to a fresh Fly app with `OPENAI_API_KEY` unset gets zero boot-time signal; embedder silently falls back to local hashing and search recall degrades unobserved.
- Evidence: `rg -n "OPENAI_API_KEY|RESEND_API_KEY|SUPABASE_SERVICE_ROLE_KEY" server/src/lib/env-validation.ts` returns zero hits.
- Suggested fix: add four entries to the `CHECKS` array — OpenAI WARN, Resend WARN, Supabase URL+anon REQUIRED_IN_PROD when `FOUNDEROS_AUTH_PROVIDER=supabase`, Supabase service-role-key WARN.
- Effort: small.
- Safe to fix now? yes — additive only, no runtime behavior change.

### Finding 4 — Smoke and signoff E2E specs read `deploymentMode` from `/api/health`, but it has been moved to `/api/health/bootstrap-state` (task #139)

- Severity: P1
- Category: E2E-quarantine
- Graph node: e2e_critical, observability_health
- File(s):
  - `tests/e2e/smoke/landing-to-dashboard.spec.ts:41-49` — `requiresAuth()` reads `body.deploymentMode` from `/api/health` and inverts; today `deploymentMode` is undefined so `body.deploymentMode !== "local_trusted"` is always `true`, the skip never fires, and the sign-up flow runs against local_trusted mode where `/auth` doesn't exist → guaranteed test failure.
  - `tests/e2e/signoff-policy.spec.ts:113-124` — `setupCompany()` reads the same field and **throws** if `health.deploymentMode !== "local_trusted"`; today that condition is always true so the signoff suite hard-aborts on every run.
  - `e2e/tests/critical-flows.spec.ts:208-209` correctly asserts the absence of `deploymentMode` from `/api/health` (the regression test); the two specs above are the inverse — they assume the pre-#139 shape.
- Why it matters: when CI billing comes back online, these specs will surface as red even though the underlying app is healthy. Buyer-critical: the smoke spec is the canonical "landing → onboarding → dashboard" path; if it can't even decide whether to skip, the dream-state happy-path bar is broken.
- Evidence: `server/src/routes/health.ts:36-58` confirms `/api/health` is now `{status, version}` only; `/bootstrap-state` (lines 65-120) carries `deploymentMode`. Specs above haven't been updated.
- Suggested fix: switch both specs to `GET /api/health/bootstrap-state` and read `deploymentMode` from there.
- Effort: small (URL change in two files).
- Safe to fix now? yes.

### Finding 5 — `tests/e2e/playwright.config.ts` has retries=0 + trace="on-first-retry" → trace never captured even on failure

- Severity: P2
- Category: artifact-upload
- Graph node: e2e_critical
- File(s): `tests/e2e/playwright.config.ts:12-18`
- What is wrong: `retries: 0` combined with `trace: "on-first-retry"` and no `video` setting at all means a failing onboarding/signoff spec produces only a screenshot. No trace zip, no video — postmortem on a flaky onboarding wizard step is reduced to "look at one PNG and guess".
- Why it matters: onboarding/signoff are buyer-critical (FOUNDEROS-CRITICAL-FLOWS.md §15 #1, "Onboard → company → first agent → first issue → approve"). The richer `e2e/playwright.config.ts:43-45` correctly configures `trace: "retain-on-failure"` + `video: "retain-on-failure"` in CI — `tests/e2e/` should match.
- Suggested fix: set `trace: "retain-on-failure"`, `video: "retain-on-failure"`, optionally `retries: process.env.CI ? 1 : 0`.
- Effort: small.
- Safe to fix now? yes.

### Finding 6 — Audit gap: billing-gate 402 response writes no `activity_log` row

- Severity: P1
- Category: audit-gap
- Graph node: audit_logs
- File(s): `server/src/middleware/billing-gate.ts:78-128`
- What is wrong: the gate computes `isActive`, then on inactive returns `res.status(402).json({ error: "subscription_inactive", ... })`. There is no `logActivity` call. Per FOUNDEROS-CRITICAL-FLOWS.md §12, "budget block" is explicitly listed as a known gap — this confirms it. Combined with Finding 1, a 402 leaves zero forensic trail (Sentry isn't fired either because 402 is not `instanceof Error`).
- Why it matters: when a founder reports "the agent stopped working", ops cannot replay from `activity_log` to confirm whether the gate fired and why. Buyer trust signal: an audit-grade product must record gate decisions, not just enforce them.
- Evidence: `rg -n "logActivity" server/src/middleware/billing-gate.ts` returns zero hits.
- Suggested fix: emit `logActivity(db, { actorType: "system", action: "billing.gate.blocked", entityType: "subscription", details: { reason: "inactive", actorUserId: actor.userId } })` before responding.
- Effort: small.
- Safe to fix now? yes.

### Finding 7 — Audit gap: agent pause/resume/terminate writes no `activity_log` row (pause cascade is the buyer-visible failure)

- Severity: P1
- Category: audit-gap
- Graph node: audit_logs
- File(s): `server/src/services/agents.ts:420-481`
- What is wrong: `pause()`, `resume()`, `terminate()` all `UPDATE agents SET ...` and return — none call `logActivity`. FOUNDEROS-CRITICAL-FLOWS.md §11 lists "pause cascade observed in UI within heartbeat tick" as a critical flow, and §12 explicitly names "pause cascade" in the gaps-to-verify list.
- Why it matters: when a company-wide pause cascades to N agents, there's no audit row for any of the N transitions. After a buyer support call asking "did you pause this agent at 14:32 or did the system?", there is no way to answer from `activity_log`.
- Evidence: `rg -n "logActivity" server/src/services/agents.ts` returns zero hits in pause/resume/terminate paths.
- Suggested fix: add `logActivity(db, { actorType: <resolved>, action: "agent.paused"|"agent.resumed"|"agent.terminated", entityType: "agent", entityId: id, details: { reason } })` after each successful update. For the company-pause cascade in `services/companies.ts`, emit one parent `company.paused` row plus one `agent.paused` row per cascaded child with `details.cascadedFromCompanyId` for replay.
- Effort: small.
- Safe to fix now? yes.

### Finding 8 — Audit gap: magic-link issuance writes no `activity_log` row

- Severity: P2
- Category: audit-gap
- Graph node: audit_logs
- File(s): `server/src/services/magic-link.ts` (no `logActivity` call anywhere)
- What is wrong: magic-link tokens (`mlt_<48 alnum>`) are issued/consumed via the service but the issuance and consumption flows do not write audit rows. FOUNDEROS-CRITICAL-FLOWS.md §12 lists "magic-link issuance" as a known gap.
- Why it matters: post-issuance forensics need to answer "who issued this approve_action link, when, from which IP, for which target". Today the only trace is the `magic_link_tokens` row itself + pino logs (which lack request correlation in cron paths — see Finding 1). Audit-grade replay requires `activity_log`.
- Evidence: `rg -n "logActivity|activity_log|writeActivity" server/src/services/magic-link.ts` returns zero hits.
- Suggested fix: emit `magic_link.issued` (with `purpose`, `target_ref_kind`, `target_ref_id`, `expires_at`) at issuance and `magic_link.consumed` at consume. Do NOT log the plaintext or hash — entityId is enough.
- Effort: small.
- Safe to fix now? yes.

### Finding 9 — Dead-code workflow `refresh-lockfile.yml` triggers on a non-existent `master` branch

- Severity: P3
- Category: env-validation (CI hygiene)
- Graph node: deployment_startup
- File(s): `.github/workflows/refresh-lockfile.yml:6, 10, 83`
- What is wrong: CLAUDE.md §"Branch + release model" states "**Never** commit to or target `master` — it doesn't exist. Any workflow referencing it is dead code." `refresh-lockfile.yml` is hardcoded to `branches: [master]` so the trigger never fires. The `.github/workflows/README.md` claims `release.yml` was removed for the same reason — `refresh-lockfile.yml` was missed.
- Why it matters: code rot signal — operators reviewing workflow inventory believe lockfile auto-refresh exists, but it never runs. Low priority because billing is anyway down so nothing runs.
- Evidence: `grep -n "master" .github/workflows/refresh-lockfile.yml` shows three occurrences in the trigger config + concurrency group + body text.
- Suggested fix: replace `master` with `main` in trigger, concurrency group, and body string. One change.
- Effort: small.
- Safe to fix now? yes (no behavioral risk — currently disabled by name).

### Finding 10 — `e2e/tests/critical-flows.spec.ts` has 7 conditional `test.skip` calls without linked issues or removal criteria in `docs/CI-KNOWN-FLAKES.md`

- Severity: P2
- Category: E2E-quarantine
- Graph node: e2e_critical
- File(s): `e2e/tests/critical-flows.spec.ts:30, 311, 330, 349, 368, 403, 404, 454, 541`; plus all six `e2e/tests/multi-company-deep.spec.ts` skips at 187, 229, 351, 477, 513, 555; plus all four `e2e/tests/client-readiness/*.spec.ts` skips.
- What is wrong: `docs/CI-KNOWN-FLAKES.md` documents 7 explicit quarantine entries (5 fixed, 2 active). The 17+ runtime conditional skips ("no companyCtx", "public-only profile", "seed missing entity") are NOT enumerated there. Some are correct policy choices (public-only mode skips mutation specs) but operators reviewing E2E coverage cannot tell which skips are policy vs flake vs broken.
- Why it matters: per CLAUDE.md "Tracked: linked issue + removal criterion" — quarantines without explicit criteria become permanent dead code. The tracker doc undercounts real quarantine breadth by ~3x.
- Evidence: `rg -c "test\.skip" e2e/tests/` shows 21 skips; `docs/CI-KNOWN-FLAKES.md` mentions 7.
- Suggested fix: add a "Conditional skips by design" section to `docs/CI-KNOWN-FLAKES.md` that lists each skip site, its trigger condition, and whether the skip is permanent (e.g. "public-only profile is the prod-safe default") or pending re-enablement. No code change.
- Effort: small (doc-only).
- Safe to fix now? yes.

## Env Validator Coverage

| Var | Validated at boot? | Severity if missing | Used by |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | yes | REQUIRED_IN_PROD | `server/src/services/oauth/state-store.ts:23` (load-bearing for OAuth state) |
| `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` | yes (paired) | WARN | `server/src/services/subscription.ts`, billing routes |
| `ANTHROPIC_API_KEY` | yes | WARN | adapter fallback |
| `COMPOSIO_API_KEY` | yes | WARN | composio v3 client |
| `COMPOSIO_V3_READY` | yes | INFO | route mounting |
| `FOUNDEROS_BYO_RUNNER_ENABLED` | yes | INFO | runner adapter registration |
| `SENTRY_DSN` | yes | WARN | `server/src/observability/sentry.ts:23` |
| `SUPABASE_WEBHOOK_SECRET` | yes | WARN | webhook signature verify |
| `EMAIL_UNSUBSCRIBE_SECRET` | yes | WARN | `email-unsubscribe-tokens.ts` (CAN-SPAM gate) |
| **`OPENAI_API_KEY`** | **NO** | should be WARN | `provider-credentials.ts:99`, embedder, codex-models adapter |
| **`RESEND_API_KEY`** | **NO** | should be WARN | `email-transport.ts:163`, `content-publish-tick.ts:32` |
| **`SUPABASE_URL`** | **NO** | should be REQUIRED_IN_PROD when `FOUNDEROS_AUTH_PROVIDER=supabase` | `index.ts:530-531`, `config.ts:251` |
| **`SUPABASE_ANON_KEY`** | **NO** | should be REQUIRED_IN_PROD when authProvider=supabase | `config.ts:252` |
| **`SUPABASE_SERVICE_ROLE_KEY`** | **NO** | should be WARN | `config.ts:253` |
| **`FOUNDEROS_BILLING_GATE_ENABLED`** | NO (intentional — flag-style) | n/a | billing-gate.ts |

See Finding 3 for the gap.

## Cron Job Audit

| Cron | Failure logging | Sentry | System actor injected? |
|---|---|---|---|
| `slack-daily-summary-cron.ts` | pino `log.error` (lines 162, 185) | NO | NO — naked `setInterval` (line 183) |
| `daily-digest-cron.ts` | pino `log.error` (lines 162, 185) | NO | NO — naked `setInterval` (line 183) |
| `decision-followup-cron.ts` | implicit | NO | NO — naked `setInterval` (line 81) |
| `hubspot-sync-cron.ts` | (assumed pino) | NO | NO |
| `linkedin-sync-cron.ts` | (assumed pino) | NO | NO — naked `setInterval` (line 109) |
| `notion-sync-cron.ts` | (assumed pino) | NO | NO — naked `setInterval` (line 108) |
| `slack-sync-cron.ts` | (assumed pino) | NO | NO — naked `setInterval` (line 108) |
| `weekly-wrap-delivery-cron.ts` | pino `log.error` (lines 299, 320) | NO | NO — naked `setInterval` (line 318) |
| heartbeat-tick (in `index.ts:716`) | pino + ALS | only via err handler if rethrown | YES (`runInCronContext`) |
| routine-scheduler-tick (`index.ts:729`) | pino + ALS | only via err handler if rethrown | YES |
| heartbeat-reap-orphans (`index.ts:742`) | pino + ALS | only via err handler if rethrown | YES |
| database-backup (`index.ts:804`) | pino + ALS | only via err handler if rethrown | YES |
| feedback-export-flush (`app.ts:588`) | pino + ALS | only via err handler if rethrown | YES |

Critical asymmetry: 7 of 13 schedulers run blind. See Finding 1 + Finding 2.

## E2E Quarantine Inventory

Scope: explicit `test.skip(true, ...)` and module-level guards (excluding parametric `test.skip(!ctx, ...)` boilerplate which appears 17+ times across `e2e/tests/`).

| Test | File:line | Linked issue | Removal criterion |
|---|---|---|---|
| Smoke happy path (local_trusted skip) | `tests/e2e/smoke/landing-to-dashboard.spec.ts:60` | none | run server in authenticated mode (today this skip never fires — see Finding 4) |
| Public-only profile guards (multi-company-deep) | `e2e/tests/multi-company-deep.spec.ts:187,229,351,477,513,555` | none | "authenticated profile" wired into CI |
| Public-only profile guards (client-readiness) | `e2e/tests/client-readiness/billing-gate-blocks-on-cancellation.spec.ts:49`, `runner-token-expires-and-rotates.spec.ts:43`, `workflow-actually-sends-email.spec.ts:50` | none | isolated staging environment with real Stripe + Resend |
| Critical-flow seed-data skips | `e2e/tests/critical-flows.spec.ts:30,311,330,349,368,403,404,454,541` | partial — `#16` fixed | seed presence + companyCtx; one is "no `<script src=...>` in HTML — likely ESM dev server" without trigger criterion |
| Route-smoke runtime guards | `e2e/tests/route-smoke.spec.ts:111,115,119,133` | none | seed completeness + authenticated profile |
| Active doc'd quarantine: `workspace-runtime.test.ts` flake | `server/src/__tests__/workspace-runtime.test.ts:1501` (vitest, not playwright) | yes — `CI-KNOWN-FLAKES.md #2` | shared HTTP services on ephemeral ports → isolated DB fixtures or `describe.sequential` |
| Active doc'd quarantine: `backup-lib.test.ts` FK round-trip | `packages/db/src/backup-lib.test.ts:136` | tracked — `CI-KNOWN-FLAKES.md #7` v1.1 | pg_dump→pg_restore composite-FK rewrite |

See Finding 10 for the documentation gap.

## Audit Log Gap Inventory

Per FOUNDEROS-CRITICAL-FLOWS.md §12 known-gap list — verified against code today:

- **Budget block:** GAP CONFIRMED. `server/src/middleware/billing-gate.ts:78-128` returns 402 with no `logActivity` call. Finding 6.
- **Pause cascade:** GAP CONFIRMED. `server/src/services/agents.ts:420-481` (pause/resume/terminate) — zero `logActivity` calls. Finding 7. Company-level cascade emitter not located in `services/companies.ts` either.
- **Forbidden action attempt:** GAP CONFIRMED. `rg -n "logActivity.*forbidden|forbidden.*logActivity|action.*denied" server/src/` returns zero hits. 403 paths in `require-company-access.ts` and `board-mutation-guard.ts` do not write audit rows.
- **Magic-link issuance:** GAP CONFIRMED. `server/src/services/magic-link.ts` has no `logActivity` import. Finding 8.
- **Runner token rotation:** OK. `server/src/routes/runner.ts:560,623,723` write `runner.token.issued`, `runner.token.revoked`, `runner.token.rotated` rows. This is the one bright spot in the gap list.

## CI Workflow Inventory

| Workflow file | Wired? | Notes |
|---|---|---|
| `ci.yml` | yes (broken — billing) | canonical PR check (typecheck, lint, test, migration-check, schema-drift, bundle-size, file-size). Branch protection target. |
| `pr-info.yml` | yes (broken — billing) | PR comment with diff stats; uses `pull_request_target` for forks. |
| `pr-lint.yml` | yes (broken — billing) | conventional commit + PR title lint. |
| `deploy-prod.yml` | yes (broken — billing) | `branches: [main]`. Per CLAUDE.md, this is the actual prod deploy path while `release-main.yml` is also wired but the GA billing-block hits both. `superfly/flyctl-actions/setup-flyctl@master` references the upstream action's branch — fine. |
| `release-main.yml` | yes (broken — billing) | version bump + container push + deploy. |
| `release-smoke.yml` | yes (broken — billing) | post-release smoke. |
| `e2e-ci.yml` | yes (broken — billing) | gated E2E. |
| `e2e-manual.yml` | yes (manual dispatch) | renamed from `e2e.yml` (per README). |
| `e2e-synthetic.yml` | yes (scheduled — billing affects) | synthetic monitoring. |
| `codeql.yml` | yes (broken — billing) | code scanning. |
| `gitleaks.yml` | yes (broken — billing) | secret scan. |
| `npm-audit.yml` | yes (broken — billing) | dependency audit. |
| `ossf-scorecard.yml` | yes (broken — billing) | supply-chain. |
| `docker.yml` | yes (broken — billing) | container build. |
| `uptime.yml` | yes (scheduled — billing affects) | uptime check. |
| `refresh-lockfile.yml` | **NO — dead code** | triggers on `branches: [master]`; `master` does not exist (CLAUDE.md). Finding 9. |

`pnpm --filter @founderos/db check:migrations` exists at `packages/db/package.json:scripts.check:migrations` (`tsx src/check-migration-numbering.ts`) and is gated by `ci.yml`'s `migration-check` job + `schema-drift` job (per `.github/workflows/README.md`). Also runs as a pre-step of `build` / `typecheck` / `migrate` / `generate` scripts.

## Recommended PR Slices

1. **PR-1: Cron context + Sentry** (Finding 1 + Finding 2) — wrap each domain cron's `setInterval` body in `runInCronContext("<name>", ...)` and add `captureServerError(err, { cron })` next to existing `log.error` branches. ~7 files, ~20 lines diff. Restores requestId/traceId correlation + Sentry visibility for buyer-critical schedulers (Slack daily-summary, daily-digest, weekly-wrap delivery).

2. **PR-2: Env validator extension** (Finding 3) — add `OPENAI_API_KEY` (WARN), `RESEND_API_KEY` (WARN), `SUPABASE_URL`/`SUPABASE_ANON_KEY` (REQUIRED_IN_PROD when authProvider=supabase, otherwise WARN), `SUPABASE_SERVICE_ROLE_KEY` (WARN). Single file change, additive only.

3. **PR-3: E2E `deploymentMode` migration** (Finding 4) — switch `tests/e2e/smoke/landing-to-dashboard.spec.ts` and `tests/e2e/signoff-policy.spec.ts` to read from `/api/health/bootstrap-state`. Two-line diff. Critical when CI billing returns.

4. **PR-4: Audit gap closure** (Finding 6 + Finding 7 + Finding 8) — add `logActivity` writes for `billing.gate.blocked`, `agent.paused/resumed/terminated`, `company.paused` cascade rows, and `magic_link.issued/consumed`. Wires the gaps explicitly listed in FOUNDEROS-CRITICAL-FLOWS.md §12. ~5 files, ~30 lines.

5. **PR-5: Doc + dead-code cleanup** (Finding 9 + Finding 10) — rename `master` → `main` in `refresh-lockfile.yml` and document the conditional E2E skips in `docs/CI-KNOWN-FLAKES.md`. Doc-only.

6. **PR-6: tests/e2e Playwright config** (Finding 5) — set `trace: "retain-on-failure"`, `video: "retain-on-failure"` to match `e2e/playwright.config.ts`. One-line change.

Sequence: PR-2, PR-5, PR-6 are zero-risk and ship today; PR-3 unblocks E2E parity for the day billing returns; PR-1 + PR-4 are the substantive observability + audit fixes and warrant a council review on the audit-row schema choices before merge.
