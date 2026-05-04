# DevOps + Observability Plan — diagnose anything in <60 seconds

_Drafted 2026-05-04 in response to the `placeholder.supabase.co` P0 — a
misconfig that lived undetected in production for 24+ hours. The bug
itself is now fixed; this plan codifies the system so the next class of
bug doesn't have the same shelf life._

## North star

For any user-visible failure, the founder should be able to answer
**"why did it fail?"** in under one minute, with one URL and zero log-in
required, by quoting a `requestId`.

## What we have today (post-fix)

| Capability | Status | Where |
|---|---|---|
| Server-side requestId propagation | ✅ Phase 0 (2026-05-03) | `lib/request-context.ts` AsyncLocalStorage, every API JSON error echoes `requestId` |
| Pino mixin auto-injects request context | ✅ | `middleware/logger.ts` |
| Sentry server-side scope enrichment | ✅ | `observability/sentry.ts` |
| Browser Sentry (opt-in via `VITE_SENTRY_DSN`) | ✅ | `ui/src/observability/sentry.ts` |
| Auth-call breadcrumbs + structured logs | ✅ This PR | `ui/src/lib/auth-logger.ts`, `ui/src/lib/supabase.ts` |
| `window.__authDebug() / __authErrors() / __authBreadcrumbs()` | ✅ This PR | DevTools self-service |
| Build-time placeholder guard | ✅ This PR | `ui/vite.config.ts` |
| Post-deploy bundle scan | ✅ This PR | `scripts/ci/check-deployed-supabase.sh` |
| Health check (`/api/health`) | ✅ | shallow — version, mode, authReady, bootstrapStatus |
| Deep health check (`/api/health/deep`) | ⚠️ Unauthenticated, leaks DB latency | `routes/health.ts` |
| Fly metrics (`fly logs`, `fly status`) | ✅ — but only via CLI | — |

## Gaps (in priority order — fix top-down)

### G1 — No SLO / no alerts (highest impact, lowest effort)
**Problem:** A broken auth route can serve 500s for 24+ hours and the
founder finds out only when someone tells them in person.

**Fix (1–2 hr):**
- Wire up Sentry alerts on:
  - `auth-error.config-error` (any occurrence → page founder immediately)
  - 5xx error rate > 1% over 5 min (warn)
  - 5xx error rate > 5% over 5 min (page)
- Wire up Fly Better Stack monitor (or Cronitor) on:
  - `GET /api/health` every 60s, alert on 2 consecutive failures
  - Synthetic auth flow: `POST /api/auth/test-roundtrip` (new endpoint
    that round-trips a no-op signup) every 5 min, alert on 1 failure
- Public status page: status.founderos.fly.dev (UptimeRobot or BetterStack
  free tier)

### G2 — Deep health endpoint is unauthenticated
**Problem:** `/api/health/deep` leaks DB latency, active run counts,
actor state, Composio platform health, Sentry status. Pre-existing P1
from the 2026-05-03 council, still unfixed.

**Fix (~1 hr):**
- Gate behind `instance_admin` role OR a shared bearer secret
  (`HEALTH_DEEP_TOKEN` env var, header `Authorization: Bearer <token>`)
- Keep the unauthenticated `/api/health` for public uptime monitors.

### G3 — No frontend error capture by default
**Problem:** `VITE_SENTRY_DSN` is opt-in. Every founder running their
own deploy starts blind. The auth-logger ring buffer is in-memory only.

**Fix (~2 hr):**
- Build a server-side error-collection endpoint: `POST /api/client-errors`
  accepts `{ source, message, stack, breadcrumbs, buildSha, ts }` and
  writes to a `client_errors` table (or just structured Pino logs that
  Sentry's log forwarder can pick up).
- Auth-logger flushes the ring buffer to that endpoint on `beforeunload`
  and on explicit user action ("Send error report").
- Founder gets every browser-side auth failure correlated by `buildSha`
  even without a Sentry account.

### G4 — Auth synthetic-monitor missing from CI
**Problem:** The 2026-05-04 incident slipped past CI because
`FOUNDEROS_E2E_PROFILE=public-only` skips auth-mutation tests.

**Fix (~3 hr):**
- New CI job: `e2e-auth-synthetic.yml` (runs hourly + on every prod deploy):
  - Spins up an ephemeral Supabase test project (or uses a long-lived
    test project with seeded throwaway accounts)
  - Runs Playwright that signs up a fresh `auth-test-${timestamp}@founderos.dev`
    address, confirms email via Supabase admin API, signs in, hits one
    authed API endpoint, deletes the user
  - Fails the deploy + pages founder if any step fails
  - Captures + uploads HAR file as artifact
- This is the canonical "the live auth flow is alive" gate.

### G5 — No structured-logs aggregation beyond Fly
**Problem:** `fly logs` is good for grep-by-requestId but doesn't aggregate
across regions or retain >7 days. No graphs of error rate over time.

**Fix (~4 hr — choose one stack):**
- **Cheap path:** Fly logs → Vector → Better Stack (or Axiom or Logtail).
  ~$10/mo for our volume. Adds full-text search, time-series graphs,
  alerting on log patterns.
- **Free path:** Fly logs → S3 archive (Fly logs natively can ship to
  S3); query with Athena. No real-time alerting, but cheap.

### G6 — No deploy-time canary / no bundle diff
**Problem:** A bad bundle (broken auth, broken UI render) ships to 100%
of users immediately on deploy. No staged rollout.

**Fix (~6 hr):**
- Two Fly machines per region; deploy to one first, run synthetic auth
  smoke against `<machine-id>.founderos.fly.dev`, promote if green.
- Bundle diff: GitHub Action that diffs `ui/dist` between the deploying
  SHA and the previous green deploy, posts the size delta as a PR
  comment. Catches accidental 5x bundle bloat.
- Fly's blue/green strategy is a one-line change in `fly.toml`
  (`strategy = "bluegreen"`) — but requires the deep-health gate from G2
  before promote, otherwise we're trading rolling-deploy migration risk
  for blue/green migration risk.

### G7 — No real-user metrics (RUM)
**Problem:** We have no idea what the actual P95 page-load is, or how
many users are seeing the auth-broken page, or which routes are slow on
slow 3G in India.

**Fix (~3 hr):**
- Drop in `web-vitals` lib in `main.tsx`, ship metrics to a
  `POST /api/rum` endpoint (rate-limited, no PII, requestId-correlated)
- Surface in the deep-health response or a separate `/api/admin/rum`
  page (instance_admin gated)
- Nothing fancy — even just "P95 LCP for the last hour" is more than zero.

### G8 — Secrets handling has no rotation discipline
**Problem:** `BETTER_AUTH_SECRET`, `STRIPE_WEBHOOK_SECRET`, the new
`VITE_SUPABASE_ANON_KEY` (which is technically public but should still
be rotatable), Composio API keys, Anthropic API keys — all live as Fly
secrets, but no expiry / rotation runbook.

**Fix (~2 hr):**
- `docs/runbooks/secret-rotation.md` listing each secret, where it lives,
  how to rotate it, and the user-visible blast radius of getting it wrong
- Calendar reminder every 90 days to rotate the high-value ones (Stripe,
  Anthropic, Better Auth)
- 1Password vault `Production/FounderOS` mirroring the Fly secrets so
  rotation has a trustworthy source of truth, not a "what was the old
  value?" problem.

### G9 — No latency budget / no perf gate
**Problem:** A bad migration or a runaway query can degrade P95 to 2s and
nobody sees it until support tickets arrive.

**Fix (~4 hr):**
- Add `pg_stat_statements` extension (Supabase has it on by default — just
  not surfaced in our app). Cron daily snapshot of top-20 slow queries
  into a `slow_queries.csv` artifact uploaded by GitHub Action.
- Tag every Express route with `req.timing.ttfb` in pino logs; alert when
  P95 over 5 min > 500ms for any route.

### G10 — No "what is deployed RIGHT NOW" surface
**Problem:** The only way to know what version is on prod is `fly status`
or `curl /api/health | jq .version`. The build SHA is now embedded in
the bundle (this PR adds `VITE_BUILD_GIT_SHA`) but nothing surfaces it
in the UI.

**Fix (~30 min):**
- Footer link "v0.3.1 · sha:abc123 · deployed 2026-05-04T17:30Z"
  (gated to instance_admin if you don't want it public). Click → opens
  a small modal with full health snapshot.
- Already 80% there: `SUPABASE_BUILD_META` is exported from
  `supabase.ts`. Add a similar `BUILD_META` for the app overall, render
  in a footer.

## Sequencing — first 3 sprints

| Sprint | Deliverables | Why first |
|---|---|---|
| **S1 — alerts + synthetic** (1 wk) | G1 + G4 + G10 | Catches the next P0 in <5 min, not 24 hrs. Synthetic gate is the single biggest "you'd have caught the placeholder bug" lever. |
| **S2 — observability surface** (1 wk) | G2 + G3 + G5 | Founder + early users can self-debug. Auth issues become 1-min triage, not 1-hr triage. |
| **S3 — perf + canary + RUM** (1.5 wks) | G6 + G7 + G9 | Pre-customer scaling — these are "before you have 100 customers" investments, not "before you have 5" investments. Worth queuing but don't block on. |
| **Always-on** | G8 (rotation runbook) | Should land in S1 as a 2-hour task, doesn't need its own sprint. |

## Cost envelope

Free / near-free:
- Sentry browser + server (already integrated; needs DSN)
- Better Stack monitors (free for 5 monitors)
- UptimeRobot status page (free for 50 monitors)
- Fly logs → S3 → Athena (basically free for our volume)

Optional / paid (~$30–50/mo total):
- Better Stack / Axiom / Logtail for log search ($10–20/mo)
- Sentry Team plan if we exceed free errors/month ($26/mo)
- 1Password Business if not already on it ($8/seat/mo)

The full plan above lands the diagnostic experience inside <60s for
~$30/mo all-in. That's cheap insurance against another `placeholder.supabase.co`
incident burning 24h of trust.

## What this plan deliberately omits (and why)

- **APM / distributed tracing (e.g. Honeycomb):** overkill for one
  Express service. Defer until we have ≥3 services.
- **Custom metrics dashboards (Grafana):** Fly + Better Stack has enough
  charts for our scale. Adding Grafana is a tax we'd pay 6 months later
  for marginal benefit.
- **PagerDuty:** the founder is the only on-call. Sentry → email → phone
  is enough. PagerDuty only earns its keep with a rotation.

## Tracking

Each gap above gets a `BYO-OPS-NN` ticket in CONTINUE.md. The synthetic
auth job (G4) is the single most valuable addition — schedule it in S1.
