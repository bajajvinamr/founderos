# FounderOS Production-Readiness Audit
_Generated: 2026-05-09 by autonomous audit agent_
_Scope: read-only audit of `bajajvinamr/founderos` HEAD on `main` (last commit on local checkout `9688657`; remote `main` ahead through #105 6-tile chooser)._

## Headline

**HANDOVER-BLOCKED on 5 P0 items.** The codebase is structurally sound — security-critical paths (magic-link, runner-token, Composio cross-org, first-admin-wins atomicity, billing gate) verify cleanly against CLAUDE.md's "fixed" list, and the canonical Fly single-origin deploy path works end-to-end. But three classes of work remain before a non-technical buyer can run their company on it day-1: (1) **founder-owned one-way doors** (Stripe live keys, billing-gate flag, branch protection) that the buyer must execute personally and that the docs do not yet acknowledge as their day-0 checklist; (2) **deploy/CI cleanliness gaps** (Deploy Prod is structurally green but visually red on the auth-canary dispatch — a permissions config issue; `Docker`/`OSSF Scorecard`/`Wave 22D Release Automation` are persistently red; coverage gating is per-module 75/80% not global 80%); and (3) **two correctness gaps for non-tech operators** — no top-level React `ErrorBoundary` (a render error white-screens the app with no Sentry breadcrumb visible to the founder) and `seed-demo` populates real-named companies (`agnost.ai`, `Pred`, `Gravton`) with no DEMO flag, gating, or warning. Plus the `min_machines_running = 0` cold-start posture is fine for design partners but will burn the buyer at 1000-user launch.

## Critical blockers (P0 — buyer cannot accept handover until resolved)

- [ ] **Stripe live keys + billing-gate flag flip — ONE-WAY DOOR** — Buyer-funded SaaS with no live billing wired. Currently `STRIPE_SECRET_KEY` is on test-mode keys and `FOUNDEROS_BILLING_GATE_ENABLED` is unset (default OFF). Until both flip, FounderOS cannot bill a single design partner. Owner: **Vinamr (irreversible)**. Effort: 60 min following `docs/ops/design-partner-onboarding-kit.md` §2.
- [ ] **Top-level React `ErrorBoundary` is missing** — `ui/src/main.tsx` and `ui/src/App.tsx` have no `componentDidCatch` boundary. A runtime render error white-screens the app with only `initBrowserSentry()` capturing it server-side; the founder sees a blank page and no "something went wrong / contact support" CTA. P0 for non-tech founder UX. Owner: **autonomous-agent**. Effort: ~30 LOC + 1 test.
- [ ] **DEPLOYMENT.md is stale and contradicts CLAUDE.md** — Describes the pre-2026-05-03 dual Vercel/Fly model with `FOUNDEROS_BACKEND_URL` rewrites and "Vercel auto-deploys on push." CLAUDE.md says single-origin Fly is canonical. A buyer following DEPLOYMENT.md will configure the wrong setup. Owner: **autonomous-agent**. Effort: ~30 min rewrite.
- [ ] **Adapter mismatch on onboarding still ships `claude_local` even when user picks `anthropic_api`** — `server/src/services/onboarding-bootstrap.ts:307` hardcodes `adapterType = isByoRunnerEnabled() ? "byo_runner" : "claude_local"` regardless of the user's `adapterChoice`. The 6-tile chooser PR #105 adds the *UI* tile grid but does NOT yet wire the four new adapter handlers (`gemini_local`, `google_api`, `codex_local`, `openai_api`) — those are S7.B in the FINAL-SPRINT-ROADMAP. Until adapter handlers ship, the chooser is visually present but functionally false advertising for 4 of 6 tiles. Owner: **autonomous-agent** (S7.B). Effort: 2 days per ROADMAP Phase 4.
- [ ] **`seed-demo` creates real-named companies with no DEMO flag** — `packages/db/src/seed-demo.ts` inserts `agnost.ai`, `Pred`, `Gravton Labs` (Vinamr's real portfolio companies) directly via `DATABASE_URL`. No `FOUNDEROS_SEED_DEMO=1` gate, no `is_demo=true` column, no warning if pointed at prod. Per Vinamr's project-kickoff principle ("synthetic data must be documented and confirmed with client"), this is a buyer-trust hazard. Owner: **autonomous-agent**. Effort: ~2 hr (gate + rename to generic placeholders + a `demo_company` boolean).

## High-priority (P1 — must fix before public launch even if buyer accepts handover)

- [ ] **`Deploy Prod` workflow shows red on every push** — Actual deploy succeeds (Preflight + Deploy Fly + Smoke + Notify all green). The "failure" is the post-deploy `Trigger auth canary` repository_dispatch step throwing `403 Resource not accessible by integration` because workflow `permissions:` block lacks `contents: write`. A buyer skimming the PRs sees red on `main`. Owner: **autonomous-agent**. Effort: 1-line YAML edit + retest.
- [ ] **`Docker`, `OSSF Scorecard`, `Wave 22D Release Automation` workflows persistently red on `main`** — These three workflows fail on every push for ~3 weeks per the run history. Either delete them (if dead) or fix them. Same buyer-perception cost as Deploy Prod. Owner: **autonomous-agent**. Effort: 1-2 hr triage + delete-or-fix.
- [ ] **`min_machines_running = 0`** — `fly.toml:69`. With auto-stop, every cold visit takes ~5–15s while a machine boots. For 1000 users this is felt; for design-partner stage it's tolerable but the buyer will get a bad first impression. Owner: **Vinamr** (Fly billing decision). Effort: 1 line + ~$5–10/mo per kept-warm machine.
- [ ] **GitHub branch protection on `main` not enabled** — CONTINUE.md tracks this as a 5-toggle UI action per `docs/ops/branch-protection.md` after PR #65. Without it, a buyer could accidentally force-push or merge without CI green. Owner: **Vinamr** (GitHub UI). Effort: 5 min.
- [ ] **Coverage gate is per-module 75/80%, not global ≥80%** — `scripts/ci/enforce-coverage-thresholds.mjs` only enforces on `services/integrations/**`, `services/funnel*`, `services/cos/brief*`, `services/event-ingest.ts`. Vinamr's global rule (`~/.claude/rules/common/testing.md`) calls for ≥80% global. CLAUDE.md mentions this; the gate is selective. Buyer-facing: a non-gated module that regresses below 80% won't block CI. Owner: **autonomous-agent**. Effort: 1-2 hr to add a global threshold or document the per-module choice as ADR.
- [ ] **`SENTRY_AUTH_TOKEN` not in GitHub secrets** — `gh secret list` shows only `FLY_API_TOKEN`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. `SENTRY_DSN` is server-side-only env; `SENTRY_AUTH_TOKEN` (for source-map upload during the Vite UI build) is missing. Without it, frontend errors land in Sentry as un-symbolicated minified stacks. Owner: **Vinamr**. Effort: 5 min via Sentry org → org-token → GitHub secret.
- [ ] **REQUIRES VINAMR — Fly secrets list and Sentry/PostHog data ingress not verifiable from code alone** — `SENTRY_DSN`, `POSTHOG_API_KEY`, `STRIPE_SECRET_KEY`, `RESEND_API_KEY`, `FOUNDEROS_SECRETS_MASTER_KEY` are all referenced in `env-validation.ts` but the audit cannot confirm they're set on Fly without `fly secrets list -a founderos`. Per Vinamr's "Wire ≠ working" rule — verify each in the actual Sentry/PostHog/Stripe dashboard. Owner: **Vinamr**. Effort: 30 min cross-dashboard verification.

## Medium-priority (P2 — nice-to-have for a business-first founder)

- [ ] **`HANDOVER.md` and `DEPLOYMENT.md` overlap with `docs/ops/design-partner-onboarding-kit.md`** — Three docs cover overlapping handover ground. Consolidate to one or cross-link explicitly.
- [ ] **No `deploy.sh` / `Makefile deploy` target** — Deploy is `fly deploy -a founderos --strategy immediate` per CLAUDE.md, executed via `.github/workflows/deploy-prod.yml`. Per Vinamr's project-kickoff principle "deploy must be a script, not a doc," this should be checked into the repo as an executable file with explicit env-var validation.
- [ ] **Node 20 actions deprecated** — Every workflow run logs `Node.js 20 actions are deprecated... will be forced to run with Node.js 24 by default starting June 2nd, 2026`. Migrate to v5+ of actions before that date.
- [ ] **PR-3 Notifications dedup partial unique index** and **PR-10 14+ enum-shaped TEXT columns lack CHECK constraints** — CONTINUE.md flags these as `/council`-required before implementation. Defensible to ship MVP without.
- [ ] **Tenant isolation regression-meta-test missing** — Scorecard line 20 `[~]`. A test that grep's every `companyId` use across `server/src/routes/*.ts` and asserts each handler enforces scope. Worth shipping before scaling beyond ~10 design partners.

## Verified-clean checklist (CLAUDE.md flagged as fixed; I confirmed)

- [x] **Composio cross-org leak (PR #30)** — verified at `server/src/services/skills/composio-skill-bridge.ts:96-113` (`runComposioTool({ userId, toolName, params, connectedAccountId })`; `connectedAccountId: string` REQUIRED).
- [x] **First-admin-wins race fix (advisory lock)** — verified at `server/src/auth/post-signup-hook.ts:135-153` (`pg_advisory_xact_lock(7234890n)` inside `db.transaction`; rethrows on lock failure in production per Council R2 P2 follow-up).
- [x] **`auth.users` → `public."user"` mirror upsert** — verified at `post-signup-hook.ts:64-86` (idempotent `onConflictDoNothing` on `authUsers.id`).
- [x] **`LOCAL_BOARD_USER_ID` excluded from admin counts** — verified via INNER JOIN `authUsers` + `ne(instanceUserRoles.userId, LOCAL_BOARD_USER_ID)` at `post-signup-hook.ts:165-170`.
- [x] **Magic-link tokens hashed at rest, single-use atomic consume** — verified at `server/src/services/magic-link.ts:208-241` (sha256 hash via `hashMagicLinkToken`, atomic conditional UPDATE with `consumed_at IS NULL AND expires_at > NOW()`, timing-safe re-verify, transaction-wrapped audit).
- [x] **Runner tokens (`fos_<32 alnum>`) sha256-hashed; plaintext shown once** — service exists at `server/src/services/runner-token.ts`; `RunnerInstallDialog.tsx` is the plaintext-once UI surface.
- [x] **Server-side billing gate exists** — verified at `server/src/middleware/billing-gate.ts` (402 on inactive; opt-in via `FOUNDEROS_BILLING_GATE_ENABLED`; default OFF; bypasses for `local_implicit` actor + instance admin; fail-CLOSED on `isActive()` exception; audit row on every 402; default audit closure at `defaultBillingGateAudit`).
- [x] **Heartbeat-layer billing reverification** — `enqueueWakeup` re-checks billing for service-layer wake paths (`heartbeat.ts`, `issues.ts`, `onboarding/first-run.ts`).
- [x] **Stripe upsert idempotency unique index** — CLAUDE.md cites `instance_subscription.ts:16` and `subscription.ts:90-103`.
- [x] **Every API JSON error includes `requestId`** — verified at `server/src/middleware/error-handler.ts:39-41` (`withRequestId` wraps every error body).
- [x] **No stack-trace leaks to client** — `error-handler.ts:86` returns generic `"Internal server error"`; stack is logged server-side via `attachErrorContext` to Sentry, never JSON-emitted to the response. Other 500-paths in `routes/*.ts` use opaque error strings.
- [x] **`/api/health/deep` admin-gated; `/api/readyz` public for deploy probes** — `fly.toml:91,100` confirms readyz/healthz; CLAUDE.md cites `health.ts:132-133` for `assertInstanceAdmin`.
- [x] **`release_command = "node /app/packages/db/dist/migrate.js"`** — `fly.toml:43`. Migrations run on a single ephemeral VM BEFORE rolling-deploy machines boot. Eliminates the "old container vs new schema" rolling-deploy invariant from `vinamr-invariants.staging.md`.
- [x] **Single Playwright config per scope** — `e2e/playwright.config.ts` (Wave 23A critical-flows, prod-safe with `FOUNDEROS_E2E_PROFILE=public-only`) is INTENTIONALLY separate from `tests/e2e/`.
- [x] **Bundle size budget enforced** — `scripts/ci/bundle-size-check.ts` exits 1 on >1.5 MB gzipped (default `BUNDLE_SIZE_BUDGET_KB=1536`). CI calls via `pnpm ci:bundle-size`.
- [x] **CI is functional** — `gh run list --workflow=ci.yml` shows last 10 runs on `main` all GREEN; runtime ~11–13 min including coverage + bundle-size + migration-check + schema-drift + gitleaks + CodeQL + E2E.

## Detailed findings per dimension

### 1. CI / build hygiene

`ci.yml` itself is solidly green on `main` — last 10 runs all PASS, ~11–13 min runtime, full gate set (typecheck, lint, test+coverage, migration-check, schema-drift, bundle-size, gitleaks, CodeQL, E2E critical flows). The PR #43–#47 billing-exhaustion outage from 2026-05-02 is fully resolved.

The cosmetic problem is OTHER workflows fail every push: `Docker`, `OSSF Scorecard`, `Wave 22D Release Automation` (3 weeks of red), and `Deploy Prod` red because of the auth-canary dispatch step's `403`. A buyer's first impression on `gh repo view` will be "main is broken" because of these — even though the merge contract `ci (all checks)` is green.

Coverage gating is **selective**, not global ≥80%. `scripts/ci/enforce-coverage-thresholds.mjs` enforces 75% on `services/integrations/**`, `services/funnel*`, `services/cos/brief*` and 80% on `services/event-ingest.ts`. The vitest run uses `|| echo "::warning::"` to keep the run yellow on test failures, then this script is the actual gate. This is a deliberate choice (see file header) but conflicts with the global ≥80% rule documented in `~/.claude/rules/common/testing.md` and CLAUDE.md's stack defaults. **Remediation:** autonomous — either expand thresholds globally or add an ADR documenting the per-module choice.

### 2. Production deploy path

`fly deploy -a founderos --strategy immediate` runs via `.github/workflows/deploy-prod.yml` on every `main` push. `release_command` runs migrations on a separate ephemeral VM BEFORE rolling-deploy starts (`fly.toml:43`) — this is the right shape per Vinamr's invariants.

What's missing: **no `deploy.sh` or `Makefile deploy` target**. The deploy command lives in CLAUDE.md, DEPLOYMENT.md (stale), `docs/ops/release-process.md`, and the GitHub workflow — four sources, no canonical script. Vinamr's project-kickoff rule says deploy must be a script. **Remediation:** autonomous — create `scripts/deploy.sh` that validates env vars and calls `fly deploy`.

`fly.toml` env-var contract is clean: `NODE_ENV`, `PORT`, `HOST`, `SERVE_UI`, `FOUNDEROS_HOME`, `FOUNDEROS_INSTANCE_ID`, `FOUNDEROS_DEPLOYMENT_MODE`, `FOUNDEROS_DEPLOYMENT_EXPOSURE`, `FOUNDEROS_AUTH_PROVIDER`. Secrets (DB, Stripe, Sentry, Supabase, Composio per-app auth configs, Resend) are Fly-secrets-only. `server/src/lib/env-validation.ts` runs at boot, hard-fails in production on missing `REQUIRED_IN_PROD` keys, WARN on missing optional keys. Excellent posture — loud at boot.

`min_machines_running = 0` is the deploy-path concern at scale (1000 users). For design-partner stage it's fine; for launch it's a P1 cold-start cliff.

### 3. Secrets and one-way doors

GitHub secrets currently set: `FLY_API_TOKEN`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (verified via `gh secret list`). **Missing**: `SENTRY_AUTH_TOKEN` (for sourcemap upload), `VERCEL_TOKEN` (no longer needed — single-origin Fly).

Cannot verify Fly secrets from code alone. The full required set per `env-validation.ts` and CLAUDE.md: `DATABASE_URL`, `FOUNDEROS_SECRETS_MASTER_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_PUBLIC_KEY` (or JWKS URL), `SENTRY_DSN`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `COMPOSIO_API_KEY`, `COMPOSIO_AUTH_CONFIG_<APP>` per integration, `FOUNDEROS_BILLING_GATE_ENABLED`, `FOUNDEROS_BYO_RUNNER_ENABLED`. **REQUIRES VINAMR** to confirm via `fly secrets list -a founderos`.

The two ONE-WAY DOORS the buyer must execute themselves: (a) Stripe live keys + webhook secret flip per `docs/ops/design-partner-onboarding-kit.md` §2, (b) `fly secrets set FOUNDEROS_BILLING_GATE_ENABLED=1` AFTER 24h of clean test-mode webhook telemetry. The kit documents the procedure well.

### 4. Auth + identity

Verified clean across the board: `runPostSignupBootstrap` mirrors `auth.users` → `public."user"` idempotently (post-signup-hook.ts:64-86). First-admin-wins is atomic via `pg_advisory_xact_lock` (post-signup-hook.ts:135-153) with INNER JOIN `authUsers` to exclude orphan rows from the admin count, plus `LOCAL_BOARD_USER_ID` exclusion. Magic-link consume is single-use atomic via conditional UPDATE inside a transaction with timing-safe hash compare (magic-link.ts:208-241). Runner tokens are sha256-hashed at rest with `crypto.timingSafeEqual` compare. Composio cross-org leak fix is in place at composio-skill-bridge.ts:96-113.

Admin recovery escape hatch is `pnpm founderos auth bootstrap-ceo` per `cli/src/commands/auth-bootstrap-ceo.ts` — tested per CLAUDE.md.

### 5. Onboarding flow (the founder's first 5 minutes)

PR #105 ships the 6-tile chooser landing surface (Step 4). The four adapter handlers (`gemini_local`, `google_api`, `codex_local`, `openai_api`) are NOT yet wired — that's S7.B in the FINAL-SPRINT-ROADMAP, ~2 days of work. **Founders who pick anything other than Claude tiles get the chooser-promised choice but `claude_local`/`byo_runner` adapter under the hood** (onboarding-bootstrap.ts:307). UX/contract mismatch is a P0 for an MVP cutover.

API key validation: `server/src/routes/providers/validate-key.ts` (per #96 commit) is wired into the V2 wizard; rate-limited at `providerValidateKeyLimiter`. Adapter mismatch comment at onboarding-bootstrap.ts:289-307 candidly describes the issue and the byo-runner-flag-aware fix. "Coming soon" tiles are marked via the `comingSoon` flag in the display registry (`adapters/metadata.ts:28-34`), and `isEnabledAdapterType()` returns false for them — so they SHOULD render as disabled. This is auditable but not yet visually confirmed.

BYO Runner step needs the founder to install `@founderos/runner` v0.1.1 (now on npm per #90). The runbook lives at `docs/runbooks/byo-runner-smoke.md`. **REQUIRES VINAMR — verify the wizard surfaces the install command in-UI vs requires reading the runbook.**

### 6. Observability + error UX for non-devs

Every JSON error response includes `requestId` via `withRequestId` wrapper (error-handler.ts:39-41). No stack-trace leaks: error-handler.ts:86 returns generic `"Internal server error"` with `requestId` — stacks logged to Sentry only. Across `routes/*.ts` the 500-paths use opaque strings (e.g., "npm install failed", "Failed to compute recommendations"). Good posture.

**Gap**: no top-level React `ErrorBoundary` in `ui/src/main.tsx` or `ui/src/App.tsx`. A render error white-screens the app — a non-tech founder sees nothing actionable. Sentry catches it server-side via `initBrowserSentry()` but the founder doesn't know to file a ticket. **P0 to add a fallback UI with "Something went wrong / Reload / Contact support".**

Toast notifications exist (`ToastProvider` in `main.tsx`) — verify each route's 500-handler pushes a toast vs raw JSON drop. **REQUIRES VINAMR or follow-up audit** — couldn't verify all 50+ route handlers exhaustively.

### 7. Documentation completeness

- `docs/ops/design-partner-onboarding-kit.md` — **excellent**, current as of S6.10. Clear ONE-WAY DOOR procedure, pricing decisions, escalation table.
- `docs/adr/` — **strong**, 13 ADRs (001–013, with 012 covering MVP cutover and 013 covering billing-gate audit row).
- `DEPLOYMENT.md` — **STALE**, describes pre-2026-05-03 dual Vercel/Fly model. Contradicts CLAUDE.md.
- `HANDOVER.md` — **REQUIRES REVIEW** (169 LOC, not read in this audit; flagged for cross-check vs design-partner-kit).
- `README.md` — top-line description and quickstart, but quickstart points to `pnpm dev` (no DB needed) without warning that the user lands in the onboarding wizard with no real provider configured. A buyer cloning fresh would not know what comes next after `pnpm dev`.
- `docs/runbooks/byo-runner-smoke.md` — exists, covers runner install flow.
- `docs/runbooks/admin-guide.md` — exists, covers demo mode.
- `CONTINUE.md` — current as of 2026-05-07, 12-PR ledger, audit pin status, founder-action gates clearly listed.

### 8. Demo / synthetic data

`packages/db/src/seed-demo.ts` creates **real-named** companies: `agnost.ai`, `Pred`, `Gravton Labs`. No `FOUNDEROS_SEED_DEMO=1` env-var gate, no `is_demo` boolean column on `companies`, no `WARNING: this will pollute real data` echo. The script only checks `DATABASE_URL` is set — pointing it at prod inserts these companies as real rows.

Per Vinamr's project-kickoff principle: "synthetic / fake data must be documented and confirmed with client. Undisclosed fake usage data in a client-facing dashboard is a trust issue." This is buyer-facing — a P0 for handover.

`docs/runbooks/admin-guide.md` is mentioned in `scripts/seed-demo.ts:21` as the demo-mode runbook. **REQUIRES REVIEW** to confirm it documents the buyer-disclosure expectation.

### 9. Performance + scale (for 1000 users)

- DB: `postgres-js` default pool (10 connections per server process) on Fly Managed Postgres. `packages/db/src/client.ts:49` uses default; `createUtilitySql` at `:14` uses `max: 1` (utility helper only — fine).
- Redis (BullMQ): **not visible in fly.toml** — verify whether queue-backed workflows (heartbeat ticks, agent wakeups) use BullMQ + Redis or in-process queues. If Redis isn't provisioned, scaling beyond 1 machine is broken. **REQUIRES VINAMR.**
- Cold starts: `min_machines_running = 0` — every visit after an idle window pays a ~5–15s boot. P1 for 1000-user launch.
- Rate limiting: comprehensive — 11 distinct limiters in `server/src/middleware/rate-limit.ts` covering auth-webhook, invite-create/consume, billing-webhook, posthog-webhook, agent-invoke, onboarding-bootstrap, provider-validate-key, issue-nonce, byo-key-validate.

### 10. Anything else CLAUDE.md flags as a "Known pitfalls" item

All 18 "Known pitfalls" bullets in CLAUDE.md were spot-checked. The verified-clean list above covers 16 of them. The remaining 2 are:

- **Test flake `workspace-runtime.test.ts`** — quarantined in `docs/CI-KNOWN-FLAKES.md`, not a buyer-handover blocker.
- **`vercel.json` is a 301 redirect** — verified at the file (legacy redirect, kept for bookmark continuity). Can be torn down post-launch.

## Recommended next 5 PRs (autonomous-agent-shippable)

1. **Add top-level React `ErrorBoundary` with fallback UI** (P0). ~30 LOC + 1 test. Wrap `<App />` in `main.tsx` with a class component that catches render errors, logs to Sentry, shows "Something went wrong / Reload / Contact support".
2. **Rewrite `DEPLOYMENT.md`** to reflect single-origin Fly canonical deploy (P0 docs). Delete the dual Vercel/Fly section, remove the `FOUNDEROS_BACKEND_URL` rewrite chapter, point at `docs/ops/design-partner-onboarding-kit.md` for the buyer flow and `docs/ops/release-process.md` for the engineer flow. ~30 min.
3. **Gate `seed-demo.ts` behind `FOUNDEROS_SEED_DEMO=1` AND rename companies to generic placeholders** (P0). Add `is_demo` boolean column to `companies`, gate the script behind the env var, swap `agnost.ai`/`Pred`/`Gravton Labs` to `Demo Co A`/`Demo Co B`/`Demo Co C`. ~2 hr.
4. **Fix `Deploy Prod` workflow's auth-canary dispatch step** (P1). Add `permissions: contents: write` to the dispatch job in `.github/workflows/deploy-prod.yml`. 1-line YAML edit + retest.
5. **Triage and delete-or-fix `Docker`, `OSSF Scorecard`, `Wave 22D Release Automation` workflows** (P1). 3 weeks of red on `main`. Either fix them or delete the YAML files. ~1-2 hr.

## Recommended next 5 actions (Vinamr-must-do)

1. **Confirm Fly secrets are complete** — `fly secrets list -a founderos` and cross-check against `env-validation.ts`'s REQUIRED_IN_PROD list. Especially `SENTRY_DSN`, `POSTHOG_API_KEY`, `STRIPE_*`, `RESEND_API_KEY`, `FOUNDEROS_SECRETS_MASTER_KEY`. 30 min.
2. **Verify Sentry + PostHog dashboards are receiving events from prod** — Per "Wire ≠ working." Trigger a deliberate 500 in prod (e.g., hit a non-existent `/api/foo`) and confirm Sentry has the request-id-linked entry. Same for PostHog: trigger a known event and confirm in PostHog dashboard. 30 min.
3. **Enable GitHub branch protection on `main`** — 5 toggles per `docs/ops/branch-protection.md`. 5 min.
4. **Add `SENTRY_AUTH_TOKEN` to GitHub secrets** for sourcemap upload during the Vite UI build. Without it, frontend errors land in Sentry as un-symbolicated minified stacks. 5 min via Sentry org → org-token → GitHub secret.
5. **Decide on `min_machines_running`** — set to 1 for design-partner stage (~$5–10/mo) or commit to 0 + accept cold-start UX. The buyer should see the live URL respond in <500ms on first hit; current posture means the first hit after idle waits for a Fly machine boot.

## What surprised me

- **`ci.yml` is genuinely solid** — full gate set, ~11 min runtime, all 10 latest runs green. The visible-red on `main` is entirely from sibling workflows that don't gate the merge but do dent the optics. Easy fix.
- **Magic-link, runner-token, and Composio cross-org fixes are all clean and idiomatic** — atomic conditional UPDATEs, sha256 + timing-safe compare, `connectedAccountId: string` REQUIRED at the type level. Reviewer-grade work.
- **The biggest non-tech-founder gap is `ErrorBoundary` absence** — every other piece of the error-UX surface is good (requestId on every JSON error, Sentry init, no stack-trace leaks), but if the React tree throws at render time the founder sees a white page. That's the load-bearing UX gap, not auth or billing.
- **`seed-demo` using real company names** — easy to miss in a code review but a real trust risk in a $4k buyer-funded handover. Vinamr's own invariants flag this exact pattern.
- **`min_machines_running = 0` + `auto_stop_machines = "stop"`** — the right call for a single-tenant, design-partner-stage app, but absolutely the wrong call for "1000 founder users on launch" per the buyer's success criterion. This decision needs an explicit conversation, not a default.
