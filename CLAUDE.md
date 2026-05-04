# CLAUDE.md — FounderOS project context

_Session-time behavior file. Full contributor guide lives in `AGENTS.md`._

## What this is

FounderOS: a control plane for AI-agent "companies" — founders plug in LLM agents (CoS, Growth, Content, Finance), wire integrations, and run their startup ops through an Inbox + Goals + Projects UI. Paperclip MIT fork. $4k buyer-funded.

Current deploys:
- **Canonical (server + UI)**: https://founderos.fly.dev (Fly region `lhr`, Managed Postgres `gjpkdonynwy0yln4`). Fly serves the SPA under `SERVE_UI=true` via `app.use(express.static(uiDist))` (server/src/app.ts). Single-origin: API + UI + WS all on the same host, eliminating the cross-origin auth/cookie/WS-handshake failure modes from the 2026-05-03 council.
- **Legacy redirect**: https://founderos-bice.vercel.app — pure 301 redirect to founderos.fly.dev as of 2026-05-03 (see `vercel.json`). Kept for bookmark continuity; safe to tear down once analytics confirm zero direct traffic.
- Supabase project `ggspsiexqppduvsqvpgy` (auth + JWKS)

## Stack

- **Monorepo:** pnpm workspaces. `pnpm -w run <script>` from root.
- **Server:** Node 24 + Express + Drizzle ORM. Entry `server/src/index.ts`.
- **UI:** React 19 + Vite + Tailwind + shadcn. Entry `ui/src/main.tsx`.
- **Shared:** `packages/shared` (types + validators + API path constants), `packages/db` (schema + migrations), `packages/adapters` (Claude/Codex/Cursor adapters), `packages/plugins`.
- **DB:** Postgres (Supabase prod, Fly MPG for API); embedded PGlite locally when `DATABASE_URL` unset.
- **Validation:** Zod at every boundary → `z.infer` for types. No hand-written request types.

## Commands you'll actually run

| What | Command |
|---|---|
| Install | `pnpm install` |
| Dev | `pnpm dev` (uses embedded PGlite if no `DATABASE_URL`) |
| Typecheck all | `pnpm typecheck` |
| Test all | `pnpm -w run test` (NOT `pnpm test` — that's a workspace script) |
| Lint | `pnpm lint` |
| Bundle size check | `pnpm --filter @founderos/ui build && pnpm ci:bundle-size` |
| Migrations check | `pnpm --filter @founderos/db check:migrations` |
| Fly deploy | `fly deploy -a founderos --strategy immediate` |

## Branch + release model

- Work on feature branches off `main`. `dev` is legacy — do not base new work on it.
- Conventional Commits required (`feat:`, `fix:`, `chore:`, `feat(wave-N):` for big sprints).
- `main` triggers `release-main.yml` (bumps version, pushes container, deploys).
- **Never** commit to or target `master` — it doesn't exist. Any workflow referencing it is dead code.

## CI gates (required checks)

`ci.yml` runs on every PR: typecheck, lint, test+coverage, migration-check, schema-drift, bundle-size (<1.5 MB gzipped UI), aggregated into `ci` job. See `.github/workflows/README.md` for the full map. Known flakes are quarantined in `docs/CI-KNOWN-FLAKES.md` — check there before assuming red CI is your bug.

## Known pitfalls

- **Router prefix parsing:** `ui/src/lib/company-routes.ts` has a `BOARD_ROUTE_ROOTS` set. When adding a new top-level route (`/settings`, `/weekly`, `/departments`), add its slug there or the router will mistake the route root for a company prefix.
- **Adapter choice on onboarding:** `claude_local` + `skip` don't need an API key. Only `anthropic_api` requires + validates a key. Server route `onboarding/bootstrap` enforces this — don't re-add a blanket key requirement.
- **Composio client is v3.** `composio-client.ts` targets `/api/v3/tools/execute/{slug}`, `/api/v3/connected_accounts`, `/api/v3/connected_accounts/{id}`. Per-toolkit `auth_config.id` must be pre-created in the Composio dashboard and dropped into `COMPOSIO_AUTH_CONFIG_<APP>` Fly secrets (slack, gmail, github, googlecalendar, googlesheets, googledrive, notion, linkedin live on prod). `COMPOSIO_V3_READY=1` enables the routes.
- **Test flakes:** 1/1570 tests flakes under parallel load — `workspace-runtime.test.ts` (shared HTTP services on ephemeral ports, not embedded PG). Documented in `docs/CI-KNOWN-FLAKES.md`. Not your bug if you see it red.
- **Single-origin from 2026-05-03 onward — Fly serves both API and UI.** `vercel.json` is a 301 redirect; do NOT re-introduce a Vercel build that serves SPA content. The collapse eliminates a cluster of cross-origin failure modes (WS handshake auth dies because browsers can't attach `Authorization` to `new WebSocket()`; cookies dropped by SameSite + Safari ITP; CSP `connect-src` had to allowlist Fly; build-time `VITE_API_ORIGIN` had to be baked at deploy time). All of those are gone now — **don't add them back** by splitting UI back onto Vercel/Cloudflare/anywhere else without redoing the auth model first. Microservices was rejected in the same council pass as a worse direction.
- **`LOCAL_BOARD_USER_ID = "local-board"` is a synthetic principal**, not a human admin. Any code that counts `instance_admin` role rows for "is the instance bootstrapped?" must exclude this row, or the system will report "ready" before the first real admin exists. See `server/src/routes/health.ts` after the 2026-05-03 fix.
- **Onboarding adapter mismatch:** `server/src/services/onboarding-bootstrap.ts:201` hardcodes `claude_local` even when the user picks `anthropic_api`. Founder passes Anthropic key validation in `routes/onboarding.ts:291`, then gets local CLI agents that don't run on Fly. Fix the slot mapping when touching this path.
- **`release-main.yml` is blocked by GitHub Actions billing.** The actual prod deploy path is `.github/workflows/deploy-prod.yml`. CLAUDE.md (this file) and CONTINUE.md still misname this — incident response will misroute. Treat `deploy-prod.yml` as the source of truth until billing unblocks.
- **`/api/health/deep` is unauthenticated** and leaks DB latency, active run counts, actor state, Composio platform health, Sentry status. Gate to instance-admin or board auth before any wider deployment exposure.
- **Billing gate is client-only.** `ui/src/components/BillingGate.tsx` polls `/api/billing/status`; no server-side enforcement on protected routes or agent loops. `subscription.ts` `findFirst()` lacks `orderBy` and webhook upserts target a `defaultRandom()` id (never conflict) — every Stripe retry creates a duplicate row. Council verdict 2026-05-03: BLOCK until middleware-level enforcement + unique index on `stripeSubscriptionId` lands.
- **Composio cross-org leak:** `server/src/services/skills/composio-skill-bridge.ts` calls `runComposioTool({ userId, ... })` without `connectedAccountId`. Multi-org users get arbitrary connection selection — agent in Org A can post to Org B Slack. Thread `route.composioConnectionId` through every skill call site.
- **Every API JSON error response now includes `requestId`** as of 2026-05-03 council Phase 0. When investigating user-reported issues, ASK FOR THE REQUEST ID FIRST — `fly logs | grep <requestId>` and Sentry filter on `tag:requestId` both bind every log line, span, and exception for that single request. Same ID is in the `x-request-id` response header and in the JSON `{ error, requestId }` body. Without it you're grepping by timestamp + user agent and missing background-task spans entirely.
- **Single Playwright config per scope:** `e2e/playwright.config.ts` (Wave 23A critical-flows, prod-safe with `FOUNDEROS_E2E_PROFILE=public-only`) is INTENTIONALLY separate from `tests/e2e/` (onboarding/signoff with its own webServer). Don't merge them — `e2e/` runs against deployed origins and skips auth-mutation; `tests/e2e/` boots a local server. Two configs, two lifecycles.
- **`vercel.json` redirect changes only activate on the next push to the Vercel-configured production branch.** Editing the file on a feature branch and pushing the PR does NOT change the production hostname's behavior — Vercel preview deployments use the file from the PR snapshot but the production domain keeps serving the previous main's config until merge. If you ship a redirect cutover, expect a window where `https://<vercel-host>/...` is still serving the old SPA until the next main push fires the rebuild.
- **`server/src/lib/request-context.ts` runs ALL request-scoped code under `runWithRequestContext`.** Any background task spawned from a request handler (queue jobs, fire-and-forget promises, setTimeout callbacks) inherits the ALS context automatically — but a background task scheduled at boot (cron schedulers, plugin coordinator) runs OUTSIDE any request context. If you `getRequestContext()` from a cron tick, it returns `undefined`. Inject explicit `actor: { type: 'system' }` for background-originated work or the Sentry scope tags will be empty.

- **BYO Runner adapter (`byo_runner`) is a no-op spawn — execution happens in the runner package, not the server.** `server/src/services/adapter-resolver.ts` returns the byo_runner family from the same map as `claude_local` / `anthropic_api` but the resolved adapter only enqueues into `runner_jobs`; the local `claude` CLI is invoked by `@founderos/runner` running on the founder's laptop. If you add a code path that assumes "the adapter spawns the binary" (run logs, exec timing, exit-code interpretation), it must branch on `byo_runner` or it'll see all jobs as instantly returning. The full smoke is documented at `docs/runbooks/byo-runner-smoke.md`.

- **Runner tokens (`fos_<32 alnum>`) are sha256-hashed at rest — DB stores hash only.** Plaintext is shown in the UI exactly once via `RunnerInstallDialog`. Server-side: `crypto.timingSafeEqual` compare in `runner-auth.ts`; do NOT add a code path that reconstructs plaintext from the DB. If a founder loses a token, issue a new one and revoke the old.

- **`runner_tokens.lastSeenAt` is what powers the pill liveness, not a heartbeat row.** The runner-auth middleware updates `lastSeenAt = now()` on every authenticated request. "Online" = `lastSeenAt < 30s ago`. Don't add an explicit heartbeat endpoint; long-poll traffic IS the heartbeat.

## Where things live

- ADRs: `docs/adr/` (10 entries as of 2026-04-23)
- PRDs: `docs/prds/` (3 active)
- Retros: `docs/retros/`
- QA checklists: `docs/qa/`
- Runbooks: `docs/runbooks/`
- Deploy config: `DEPLOYMENT.md` + `docs/ops/branch-protection.md`
- Project handover (always current): `CONTINUE.md`

## Deferred / human-only next steps

Tracked in `CONTINUE.md`. Summary: Stripe live keys, `FLY_API_TOKEN` + `VERCEL_TOKEN` + `SENTRY_AUTH_TOKEN` as GitHub secrets, `main` branch protection, Resend paid tier.
