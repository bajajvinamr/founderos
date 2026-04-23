# CONTINUE.md — FounderOS next-step source of truth

_Last updated: 2026-04-24 by Claude (forward plan locked)_

## 2026-04-24 — forward plan locked

- **Shipped:** `docs/PLAN-FORWARD-2026-04-23.md` (4-milestone 90-day plan) + ticket stubs 001–003 for M1. North Star: **10 paying companies @ $99+/mo by 2026-07-22**. Constraint: founder ≤30 hr/week. Excellence dims: self-serve <15 min, agent completion >90%.
- **Pending (tracked, now with ticket #s):** Composio v3 migration (`docs/tickets/001`), per-file DB fixtures for flakes (`docs/tickets/002`), CI file-size gate (`docs/tickets/003`). Plus debt carried from retro: 3 files >4000 lines (tickets 004–006 to be created when 003 lands).
- **Known issues:** 2–3 flaky tests per root run (covered by ticket 002), Composio v1 client still deprecated (covered by ticket 001).
- **Exact next step:** **Ticket 001 — Composio v3 client migration.** Fresh `/clear` session, open `docs/tickets/001-composio-v3-client-migration.md`, enter Plan Mode, write the ADR for SDK-vs-fetch, then execute TDD.

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
