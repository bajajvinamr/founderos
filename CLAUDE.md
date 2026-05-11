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
- **DB:** Postgres — Fly Managed Postgres for canonical app data; Supabase for auth identity (`auth.users` JWT issuer + OAuth + email confirm); embedded PostgreSQL locally when `DATABASE_URL` unset (auto-selected via `packages/db/src/runtime-config.ts`).
- **Validation:** Zod at every boundary → `z.infer` for types. No hand-written request types.

## Commands you'll actually run

| What | Command |
|---|---|
| Install | `pnpm install` |
| Dev | `pnpm dev` (uses embedded PostgreSQL if no `DATABASE_URL`) |
| Typecheck all | `pnpm typecheck` |
| Test all | `pnpm -w run test` (NOT `pnpm test` — that's a workspace script) |
| Lint | `pnpm lint` |
| Bundle size check | `pnpm --filter @founderos/ui build && pnpm ci:bundle-size` |
| Migrations check | `pnpm --filter @founderos/db check:migrations` |
| Fly deploy | `fly deploy -a founderos --strategy immediate` |

## Branch + release model

- Work on feature branches off `main`. `dev` is legacy — do not base new work on it.
- Conventional Commits required (`feat:`, `fix:`, `chore:`, `feat(wave-N):` for big sprints).
- `main` triggers `deploy-prod.yml` (Fly-builder-based deploy; preflight → deploy-fly → smoke → post-deploy auth canary). See `DEPLOYMENT.md`.
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
- **CI is functional as of 2026-05-07.** The 2026-05-02 GitHub Actions billing exhaustion has been resolved — `ci.yml` PR gates run end-to-end again (typecheck ~2m, test+coverage ~10m, lint, audit, bundle-size, migration-check, schema-drift, gitleaks, CodeQL, E2E all execute and produce real signal). Prior outage signature ("install + cache" 9-15s with empty `steps[]`, log blob 404, all workflows red simultaneously) is gone; verified across PRs #43/#44/#45/#47 over 2026-05-06→07. **Both gates apply on every merge:** `ci (all checks)` aggregate is the merge contract, while `deploy-prod.yml` remains the prod deploy path. Two pre-existing test bugs that surfaced after billing was restored (telemetry test missing CI env-var guards; v1.1 backup-lib `pg_dump` round-trip) were resolved in PR #47 (commit `97398c5`); see `docs/CI-KNOWN-FLAKES.md` §7 for the quarantine record.
- **`/api/health/deep` is admin-gated** (closed 2026-05-03 council; verified 2026-05-05 at `health.ts:132-133` via `assertInstanceAdmin`). For deploy probes use `/api/readyz` (public, returns 200 "ready"). For oncall dashboards, hit `/api/health/deep` with an instance-admin credential. **Task #139 closed 2026-05-06** (commit `cc1d891`): `/api/health` ROOT is now `{status, version}` only; `deploymentMode/authReady/bootstrapStatus/bootstrapInviteActive` moved to public `/api/health/bootstrap-state`; `deploymentExposure/features/devServer` moved to admin-gated `/api/health/diagnostics`. UI consumers updated atomically (single-origin Fly deploy, no backwards-compat dance).
- **Server-side billing gate exists** (closed 2026-05-03 council via PR #35). `server/src/middleware/billing-gate.ts` enforces 402 on inactive subs at `/agents/:id/wakeup` + `/heartbeat/invoke`. **Plus heartbeat-layer defense in depth** (council #132, 2026-05-05) — `enqueueWakeup()` re-checks billing for all service-layer wake paths (issue assignment, approval, comment, plugin-internal). Both gates are OPT-IN via `FOUNDEROS_BILLING_GATE_ENABLED=1`; default OFF for soft rollout. Stripe upsert targets `instanceSubscription.stripeSubscriptionId` (verified at `subscription.ts:90-103`) with unique index at `instance_subscription.ts:16` — no more duplicate rows on retry. **Flip the flag in prod** (`fly secrets set FOUNDEROS_BILLING_GATE_ENABLED=1`) once Stripe webhook telemetry is clean.
- **Composio cross-org leak is closed** (PR #30, verified 2026-05-05 at `composio-skill-bridge.ts:96-113`). `runComposioTool({ userId, toolName, params, connectedAccountId })` now requires `connectedAccountId: string`; threaded through 6 skill call sites. Agent in Org A can no longer post to Org B Slack. The pitfall to know: when adding a NEW skill that calls Composio, you MUST resolve `connectedAccountId` from the per-org route decision before invoking — TypeScript will refuse compile if you forget.
- **Every API JSON error response now includes `requestId`** as of 2026-05-03 council Phase 0. When investigating user-reported issues, ASK FOR THE REQUEST ID FIRST — `fly logs | grep <requestId>` and Sentry filter on `tag:requestId` both bind every log line, span, and exception for that single request. Same ID is in the `x-request-id` response header and in the JSON `{ error, requestId }` body. Without it you're grepping by timestamp + user agent and missing background-task spans entirely.
- **Single Playwright config per scope:** `e2e/playwright.config.ts` (Wave 23A critical-flows, prod-safe with `FOUNDEROS_E2E_PROFILE=public-only`) is INTENTIONALLY separate from `tests/e2e/` (onboarding/signoff with its own webServer). Don't merge them — `e2e/` runs against deployed origins and skips auth-mutation; `tests/e2e/` boots a local server. Two configs, two lifecycles.
- **`vercel.json` redirect changes only activate on the next push to the Vercel-configured production branch.** Editing the file on a feature branch and pushing the PR does NOT change the production hostname's behavior — Vercel preview deployments use the file from the PR snapshot but the production domain keeps serving the previous main's config until merge. If you ship a redirect cutover, expect a window where `https://<vercel-host>/...` is still serving the old SPA until the next main push fires the rebuild.
- **`server/src/lib/request-context.ts` runs ALL request-scoped code under `runWithRequestContext`.** Any background task spawned from a request handler (queue jobs, fire-and-forget promises, setTimeout callbacks) inherits the ALS context automatically — but a background task scheduled at boot (cron schedulers, plugin coordinator) runs OUTSIDE any request context. If you `getRequestContext()` from a cron tick, it returns `undefined`. Inject explicit `actor: { type: 'system' }` for background-originated work or the Sentry scope tags will be empty.

- **BYO Runner adapter (`byo_runner`) is a no-op spawn — execution happens in the runner package, not the server.** `server/src/services/adapter-resolver.ts` returns the byo_runner family from the same map as `claude_local` / `anthropic_api` but the resolved adapter only enqueues into `runner_jobs`; the local `claude` CLI is invoked by `@founderos/runner` running on the founder's laptop. If you add a code path that assumes "the adapter spawns the binary" (run logs, exec timing, exit-code interpretation), it must branch on `byo_runner` or it'll see all jobs as instantly returning. The full smoke is documented at `docs/runbooks/byo-runner-smoke.md`.

- **Runner tokens (`fos_<32 alnum>`) are sha256-hashed at rest — DB stores hash only.** Plaintext is shown in the UI exactly once via `RunnerInstallDialog`. Server-side: `crypto.timingSafeEqual` compare in `runner-auth.ts`; do NOT add a code path that reconstructs plaintext from the DB. If a founder loses a token, issue a new one and revoke the old.

- **`runner_tokens.lastSeenAt` is what powers the pill liveness, not a heartbeat row.** The runner-auth middleware updates `lastSeenAt = now()` on every authenticated request. "Online" = `lastSeenAt < 30s ago`. Don't add an explicit heartbeat endpoint; long-poll traffic IS the heartbeat.

- **Two-database split: Supabase = auth identity, Fly Postgres = app data.** Supabase manages `auth.users` (JWT issuer, OAuth providers, email confirmation). Fly Managed Postgres holds `public."user"` (the app-side mirror) plus everything else. The two are NOT the same DB — `auth.users` is unreachable from Fly MPG. The bridge is `runPostSignupBootstrap` in `server/src/auth/post-signup-hook.ts`, which upserts into `public."user"` on the first authenticated request before granting roles. Pre-2026-05-04, the upsert was missing — Supabase signups never mirrored into `public."user"`, and an orphan `instance_user_roles` row bricked production onboarding. The mirror upsert + FK + ON DELETE CASCADE on `instance_user_roles.user_id` is the structural fix; see `docs/adr/` if you need to revisit. Anything that joins on `public."user"` (board API key auth, weekly wraps, daily digests, welcome emails) depends on this mirror existing — don't bypass it.

- **Admin recovery escape hatch: `pnpm founderos auth bootstrap-ceo`.** When onboarding is gated by `INSTANCE_ADMIN_REQUIRED` and the founder can't get past first-user-wins (e.g., orphan admin row pre-2026-05-04, or someone else already promoted), use the CLI to issue a single-use invite URL that bypasses first-user-wins entirely. Format `pcp_bootstrap_<48hex>`, sha256-hashed at rest, default 72h TTL, plaintext printed once. The `/invite/<token>` path consumes the invite and grants `instance_admin` deterministically (no race, no orphan blindness). Implementation at `cli/src/commands/auth-bootstrap-ceo.ts`. Refuses if an admin already exists unless `--force`. The CLI requires `DATABASE_URL` env or a config file — when running via `fly ssh` you can replicate the INSERT directly against `invites` table since the container doesn't ship the CLI config.

- **Embedded-pg test fixture API (in `@founderos/db`): `startEmbeddedPostgresTestDatabase(prefix: string)` returns `{ connectionString, cleanup }`** — NOT `{ db, stop }` and NOT `{ db: testDb.db }`. Tests must instantiate Drizzle from `connectionString` themselves (or use the `EmbeddedPostgresTestDatabase` type re-export to wrap it) and call `await testDb.cleanup()` in `afterEach`. Several S2.6 ingest tests were written against the imagined `{ db, stop }` shape and silently broke at module-load time; they're now `describe.skip` pending rewrite (task #125). Same applies to `db.execute()` — Drizzle's `execute()` takes a `sql\`\`` template literal, NOT `(rawSqlString, paramsArray)`.

- **Event-ingest singleton initialization in tests:** production code calls module-level `ingestEvent(input)` from `server/src/services/event-ingest.ts`, which closes over a singleton initialized via `initEventIngest(db)`. Tests that mock `db` and pass it to upstream services (e.g., `runPostHogPoll(mockDb)`) MUST also call `initEventIngest(mockDb)` in `beforeEach` — otherwise the singleton is uninitialized and any `ingestEvent()` call throws "event-ingest not initialized." Failure looks like a regression from the stub→real swap (commit 109cd22) but the test was always misconfigured for the singleton shape (task #128).

- **Synthetic dedup-key contract for cross-source ingestion:** the `events` table requires `dedup_key NOT NULL` (council R2 PASS, 2026-05-05). Sources without a natural id must compute a synthetic key. Established patterns: Slack messages → `${channelId}:${ts}` (channel-scoped uniqueness); PostHog events when `event.id` is missing → `synth:${eventName}:${timestamp}:${distinctId ?? "anon"}`; HubSpot/LinkedIn → use the source's id directly. Don't pass `null` or `""` — `event-ingest.ts` runtime-guards both and throws.

- **Magic-link tokens (`mlt_<48 alnum>`) are sha256-hashed at rest with atomic single-use consume** (S6.7, 2026-05-06). Same security pattern as `runner_tokens`: plaintext shown once at issuance, only the hash lives in `magic_link_tokens.token_hash`. `consume()` is a single conditional UPDATE — `WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > NOW() RETURNING ...` — which is TOCTOU-safe under concurrent requests (the second click sees zero rows updated and throws "consumed or expired"). Do NOT add a SELECT-then-UPDATE code path; it reintroduces the race. The schema also enforces `(purpose='approve_action' OR target_ref_kind IS NOT NULL)` via CHECK, so issuing a non-approval link without a ref kind fails at the DB.

- **Onboarding drafts use a partial UNIQUE on `(user_id) WHERE completed_at IS NULL`** (S6.8, 2026-05-06). This permits one in-progress draft per user but allows re-onboarding after completion (the completed row's `completed_at` is non-NULL, so it's outside the partial index). `getOrCreate()` handles the race via try-insert → catch-on-conflict → re-read; do NOT replace it with a SELECT-or-INSERT pattern (TOCTOU window). PUT-without-prior-GET returns `409 no_active_draft` deliberately — the wizard MUST call GET on mount to create or surface the draft before any save.

- **Notifications dedupe on `(user_id, kind, ref_kind, ref_id)` while `read_at IS NULL`** (S6.6, 2026-05-06). Calling `create()` twice with the same target is a no-op — it returns the existing unread row. Once read, a new identical notification CAN be created (intentional: re-fire after acknowledgement). `markRead` is tenant + user scoped; cross-user mark-read returns 404 (NOT 403) to prevent notification-ID enumeration. Pair-invariant CHECK `((ref_kind IS NULL) = (ref_id IS NULL))` enforces "both null or both set" at the DB.

- **`company_memory.category` is CHECK-constrained at the DB** (S6.4, 2026-05-06). TS union types erase at compile time, so raw SQL inserts and migrations bypass the type. The CHECK enforces the enum at the runtime backstop — same pattern as `events.source`. When adding a new memory category, update both the validator (`memoryCategorySchema` in `packages/shared`) AND the CHECK constraint in a migration.

- **MVP cutover decision is ADR-012 + design partner onboarding kit** (S6.10, 2026-05-06). `docs/adr/012-mvp-cutover-doubtbuddy.md` is the cutover decision record (6-sprint scope, deferred-to-v1.1 list, alternatives considered). `docs/ops/design-partner-onboarding-kit.md` is the buyer-facing handover — pricing, the **Stripe live key flip ONE-WAY DOOR procedure**, outreach template, first-week-of-customer timeline, escalation table. Both are the canonical surfaces for buyer/operator hand-off; keep them aligned with reality if you change pricing or the billing gate.

## Where things live

- ADRs: `docs/adr/` (10 entries as of 2026-04-23)
- PRDs: `docs/prds/` (3 active)
- Retros: `docs/retros/`
- QA checklists: `docs/qa/`
- Runbooks: `docs/runbooks/`
- Deploy config: `DEPLOYMENT.md` + `docs/ops/branch-protection.md`
- Project handover (always current): `CONTINUE.md`
- Code review practices (distilled from autoloop's lived record): `docs/code-review-practices.md`

## Deferred / human-only next steps

Tracked in `CONTINUE.md`. Summary: Stripe live keys, `FLY_API_TOKEN` + `VERCEL_TOKEN` + `SENTRY_AUTH_TOKEN` as GitHub secrets, `main` branch protection, Resend paid tier.
