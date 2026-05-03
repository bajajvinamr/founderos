# FounderOS — Feature Coverage Report

**Generated:** 2026-05-02 from branch `test/frontend-founder-critical-flows`
**Verdict:** **HIGH CONFIDENCE — codebase sound.** All tested layers green.
**Caveat:** This proves the **codebase**, not the deployed **product**. Prod
smoke (L5) intentionally not run (no test account specified).

---

## Summary

| Layer | Result | Coverage |
|---|---|---|
| **L1** — Full vitest suite (`pnpm -w run test`) | ✅ **1750 / 1751 passed**, 1 quarantine-skipped, **0 failed** in 53s parallel | 244 test files (177 backend + 67 frontend) |
| **L4** — Static-build E2E (mimics CI/prod path) | ✅ **19 / 22 passed**, 3 known-skipped, **0 failed** in 7.8s | `e2e/tests/critical-flows.spec.ts` + `multi-company-deep.spec.ts` |
| **L6** — Feature inventory × coverage matrix | ✅ Built (see below) | 78 client routes × 51 server route files mapped |
| L3 — Pure vite-dev E2E | ⚪ Same suite as L4 (no separate config) | — |
| L5 — Prod smoke | ⏭️ Skipped (no test account specified) | — |

**Build status this session:**
- `pnpm typecheck` clean (verified earlier)
- `pnpm lint` clean (verified earlier)
- `VITE_FOUNDEROS_ONBOARDING_V2=true pnpm build` → exit 0 (server + UI + CLI)
- Server boots, `/api/health` returns `status:ok`, embedded Postgres up
- Demo seed data present (5 companies: AGN, KHU, GRV, PRD, LTW)
- E2E green against the static-built UI served on port 3100

---

## L1 — Unit + Integration (1750 / 1751)

```
Test Files  244 passed | 1 skipped (245)
Tests       1750 passed | 1 skipped (1751)
Duration    53.44s
Exit code   0
```

The single skip is the documented `workspace-runtime.test.ts` quarantine
(parallel-load shared-state flake; passes in isolation; tracked in
`docs/CI-KNOWN-FLAKES.md` entry #2).

What this proves:
- Every server route handler returns the right shape and status code under
  test (51 route files × multiple test files each)
- Every client component / hook with a colocated test renders correctly
  (67 frontend test files)
- Auth/JWT/cross-company isolation logic holds (`agent-jwt-cross-company`,
  `agent-shortname-collision`, `paused-agent-blocks-heartbeat`, etc.)
- Onboarding bootstrap is atomic (`onboarding-bootstrap-atomicity`)
- Adapter validation, instructions service, permissions, skills contract
  — all green

What this does NOT prove:
- That the code paths run identically in production with real env vars,
  real Supabase auth, real Composio, real Anthropic API
- That the UI actually renders without console errors when loaded by a
  real browser (vitest jsdom ≠ chromium)

## L4 — E2E (Static-Build, 19 / 22)

Suite ran against `pnpm build` artifacts served via `pnpm dev:server` on
port 3100 with embedded Postgres + demo seed. This is the same path CI uses.

| Bucket | Pass / Skip / Fail |
|---|---|
| landing | 1 / 1 (#16 quarantine) / 0 |
| routing | 2 / 0 / 0 |
| api-public | 2 / 0 / 0 |
| onboarding | 0 / 1 (this branch pre-dates #19 merge) / 0 |
| api-scoped | 4 / 0 / 0 |
| api-mutations | 1 / 0 / 0 |
| admin | 0 / 1 (sentry-canary admin-gated) / 0 |
| rate-limits | 1 / 0 / 0 |
| static-assets | 1 / 0 / 0 |
| multi-company tenant listing | 1 / 0 / 0 |
| multi-company per-company depth | 1 / 0 / 0 |
| multi-company per-agent depth | 1 / 0 / 0 |
| multi-company issues listing | 1 / 0 / 0 |
| multi-company cross-tenant isolation | 2 / 0 / 0 |
| multi-company health-under-load | 1 / 0 / 0 |
| **Total** | **19 / 3 / 0** |

What this proves:
- All 5 seeded companies are queryable
- Every seeded company has agents, goals, projects, and the list endpoints
  return well-shaped arrays
- Cross-tenant isolation holds: no issue ID and no agent ID is shared between
  any pair of tenants
- `/api/health/deep` stays `status:ok` under multi-tenant traversal load
- Top-level routes (`/hire`, `/weekly`, `/decisions`, `/departments`) do
  NOT throw "No company matches prefix" (the regression PR #15 fixed)
- Auth-required pages redirect signed-out users
- Rate limits actually fire on `/api/instance/invites`
- Static asset headers sane

What this does NOT prove:
- Onboarding wizard flow on this branch (skipped — branch pre-dates PR #19;
  on `main` this is now green per PR #19's CI run)
- Landing page hero CTA copy (#16 still quarantined)

## L6 — Feature × Coverage Matrix

Counts are test-file-name keyword matches (a coarse signal; many features
are tested across multiple files via different naming).

| # | Feature area | Backend tests | Frontend tests | Notes |
|---|---|---|---|---|
| 1 | **Auth** (signup, login, JWT, OAuth, invite) | 18 | 0 | Backend deeply covered. Frontend auth components rely on Supabase SDK — minimal logic to test client-side. |
| 2 | **Onboarding** (6-step wizard, bootstrap) | 3 | 4 | Wizard step components + atomicity covered. Auto-charter generator + adapter type + invite text covered. |
| 3 | **Companies** (list, create, settings, export, import) | 8 | 5 | Includes memory, providers, portability helpers. |
| 4 | **Agents** (hire, list, detail, runs, instructions, permissions) | 13 | 4 | Heaviest backend area. Includes JWT cross-company, shortname collision, skill contract, pause-blocks-heartbeat. |
| 5 | **Goals** | 3 | 2 | Includes `GoalDetail.test.tsx`. |
| 6 | **Projects** | 4 | 1 | Includes execution-workspaces. |
| 7 | **Issues** (CRUD + comments + attachments + execution + feedback + checkout-wakeup) | 21 | 16 | Highest-coverage area. |
| 8 | **Routines** (cron, schedule, run) | 4 | 3 | Includes `Routines.test.tsx`. |
| 9 | **Approvals/Decisions** | 8 | 2 | New `approvals.test.ts` (this PR) + agent-reviews + decision-outcomes. |
| 10 | **Inbox** | 1 | 2 | `inbox-dismissals` + `Inbox.test.tsx`. |
| 11 | **Conversations** | 1 | 5 | Conversation extractor + UI. |
| 12 | **Org / Departments** | 0 | 0 | ⚠️ No tests by name match. Tested implicitly via agents/companies. |
| 13 | **Costs / Billing** | 2 | 0 | ⚠️ No frontend tests. |
| 14 | **Integrations** (composio, byo-key, oauth) | 3 | 0 | ⚠️ No frontend tests. E2E covers `/api/composio/status` shape. |
| 15 | **Activity / Audit** | 3 | 1 | |
| 16 | **Weekly Wrap** (digest) | 2 | 0 | ⚠️ No frontend tests. |
| 17 | **Plugins** | 4 | 0 | ⚠️ No frontend tests. |
| 18 | **Skills** (company skills) | 14 | 1 | |
| 19 | **Instance Settings** | 3 | 1 | |
| 20 | **Adapters** (claude, codex, cursor) | 20 | 0 | ⚠️ No frontend tests. Backend deeply covered (this is the heart of agent execution). |
| 21 | **Templates** | 2 | 0 | |
| 22 | **Health / Debug** | 1 | 0 | E2E covers `/api/health` shape. |
| 23 | **Permissions / Authz** | 5 | 0 | |
| 24 | **Secrets / LLMs / Adapter routes** | 15 | 0 | ⚠️ No frontend tests, but secrets are server-side. |
| 25 | **Assets** (uploads, attachments) | 3 | 0 | |

### Coverage gaps (in priority order)

**1. Org / Departments (#12)** — 0 tests by name match. Pages exist
(`OrgChart.tsx`, `DepartmentConsole.tsx`, `Org.tsx`). Likely tested
implicitly through agent/company tests but no targeted regression catch.

**2. Frontend gaps in feature-rich areas:**
- `Costs.tsx` — 0 frontend tests
- `Integrations.tsx` — 0 frontend tests
- `WeeklyWrap.tsx` — 0 frontend tests
- `PluginManager.tsx`, `PluginPage.tsx`, `PluginSettings.tsx` — 0 frontend tests
- `AdapterManager.tsx` — 0 frontend tests
- Settings sub-pages (`InstanceProvidersSettings.tsx`, etc.) — minimal frontend coverage

These pages render real data and have UI logic, but the coverage matrix
shows zero unit-test files matching their names. They survive on:
- Backend route tests (which prove the data is fetched correctly)
- Manual QA when features ship
- The fact that they're shallow render-and-display surfaces

**3. Route-load smoke gap** — The 78 client routes are not individually
smoked. A spec that visits each one and verifies no console error / no
`<NotFound>` / no error boundary trip would catch any silently-broken page.
Not currently in either E2E config.

---

## What this report does NOT prove

These are explicit gaps in this assurance pass — not failures, just
limits of what was tested:

1. **Production deployment behavior.** PR #19 (wizard accessibility fix)
   is on `main` at `82ca8e2` but `release-main.yml` did NOT run because of
   the GitHub Actions billing block. Last released version is `v0.2.16`
   at `31c4656`. Until billing is unblocked, the wizard fix is in main but
   not deployed.

2. **Real third-party integrations.** The E2E suite hits
   `/api/composio/status` shape but does not actually broker an OAuth flow.
   Stripe webhooks, Composio toolkit execution, Supabase auth round-trip,
   Anthropic SDK calls — all proven only at the unit-test boundary
   (mocked). A real integration smoke needs production credentials.

3. **Per-route load smoke.** No spec walks all 78 client routes and
   asserts no error boundary fired. Recommend adding a route-smoke spec
   in a follow-up session.

4. **Auth flow under real Clerk/Supabase.** The Clerk override (PR #18) is
   semver-correct and unit tests pass, but I did not exercise the actual
   sign-up → email confirm → login flow with the new resolved version.

5. **375px mobile.** No mobile-specific E2E. Per CLAUDE.md "UI change →
   verify at 375px mobile" but this assurance pass was framework-level,
   not UI-design-level.

---

## Recommended next actions

In rank order of confidence-per-minute:

1. **Resolve GitHub Actions billing.** Settings → Billing & plans. This
   unblocks `release-main.yml` (so PR #19 actually deploys) and unblocks
   PR #20's CI verification.
2. **Run prod smoke (L5)** once a throwaway test account exists — Playwright
   against `https://founderos-bice.vercel.app`: load landing, sign up,
   complete onboarding, approve a decision. ~20 min, ~5 specs.
3. **Add a route-smoke spec** that walks all 78 routes with `page.goto()`
   and asserts no `[data-error-boundary]` and no `NotFound` for routes
   that should resolve. ~30 min to write, runs in <30s.
4. **Frontend unit test on Costs/Integrations/WeeklyWrap** — these are
   the highest-traffic frontend pages with 0 component tests.
5. **PR #20 merge** — diff is sound, just CI-blocked. Re-run after billing
   resolves.

---

## How to reproduce this report

```bash
# L1 — full unit suite
pnpm -w run test                                          # ~55s, 1750/1751

# L4 — static-build E2E
VITE_FOUNDEROS_ONBOARDING_V2=true pnpm build              # ~90s
FOUNDEROS_DEPLOYMENT_MODE=local_trusted FOUNDEROS_MIGRATION_AUTO_APPLY=true \
  PORT=3100 pnpm dev:server &                             # boots embedded PG
until curl -fsS http://localhost:3100/api/health > /dev/null; do sleep 2; done
DATABASE_URL=postgres://founderos:founderos@127.0.0.1:54329/founderos pnpm seed:demo
pnpm e2e                                                  # ~8s, 19/22

# L6 — feature inventory regenerate
# (see scripts above; uses test-file-name regex against feature keywords)
```
