# Deployment — single-origin Fly canonical model

> **Status:** Canonical as of 2026-05-03. Replaces the prior Vercel-static-SPA + Fly-backend split.
> The prior model is documented here only to prevent regressions — see §9.

---

## 1. TL;DR

Production FounderOS lives at **https://founderos.fly.dev**. The Fly app `founderos`
serves the API, the Vite-built SPA (under `SERVE_UI=true` via `express.static`), and
WebSocket upgrades on a single host. The legacy `https://founderos-bice.vercel.app`
hostname is now a 301 redirect to `founderos.fly.dev` (see `vercel.json`); it is kept
for bookmark continuity, not as a content host.

Production deploys are automated. Push to `main` triggers
`.github/workflows/deploy-prod.yml`, which runs preflight → Fly deploy →
Vercel-redirect deploy → smoke + readiness probe → auto-rollback on failure.

---

## 2. What lives where

| Component | Host | Notes |
|---|---|---|
| API + UI + WebSockets | Fly app `founderos` (region `lhr`, `shared-cpu-1x` / 1 GB) | Single Express server, single bundle. Serves `/api/*`, the SPA, and WS upgrades on `:3100`. |
| Application database | Fly Managed Postgres `gjpkdonynwy0yln4` | Co-located in `lhr`. `DATABASE_URL` provided via Fly secrets. |
| Auth identity | Supabase project `ggspsiexqppduvsqvpgy` | JWT issuer (ES256), OAuth providers, email confirm. App-side mirror in `public."user"` on Fly MPG; bridge is `runPostSignupBootstrap` in `server/src/auth/post-signup-hook.ts`. |
| Persistent volume | `founderos_data` (3 GB, mounted at `/founderos`) | Holds instance config, secrets master key, workspace files, agent session state. Survives deploys + restarts. |
| Legacy hostname | Vercel project `founderos-bice` | **Pure 301 redirect** per `vercel.json`. No SPA build, no API rewrite. Do NOT add Vercel-served content (see §9). |
| Container images | Fly registry `registry.fly.io/founderos` | Built remotely via `flyctl deploy --remote-only`. |

**Single-origin invariant:** API, UI, and WS share one origin. This eliminates the
cross-origin failure modes that bit the pre-2026-05-03 split — browsers cannot attach
`Authorization` headers to `new WebSocket(url)`; Safari ITP and SameSite drop
cross-origin cookies; CSP `connect-src` had to allowlist Fly from a Vercel-served UI.
All of those are gone now. Don't reintroduce them.

---

## 3. Deploy procedure

### Automated (preferred)

```text
push to main
  └─> release-main.yml      # bumps version, regenerates CHANGELOG
  └─> deploy-prod.yml
        ├── preflight        (typecheck + pnpm test:run)
        ├── deploy-fly       (flyctl deploy --remote-only --build-arg VITE_*)
        ├── deploy-vercel    (publishes the redirect-only vercel.json)
        ├── smoke            (scripts/ci/smoke.sh + bundle-placeholder check + /api/readyz)
        ├── trigger-auth-canary  (post-deploy auth round-trip via repository_dispatch)
        ├── rollback-on-fail (flyctl releases rollback to previous version)
        └── notify           (GitHub deployment status + optional Slack)
```

The `deploy-vercel` step exists only to keep the redirect deploy in sync with
`vercel.json`. It does not build or serve a SPA.

### Manual (developer machine)

```bash
fly deploy -a founderos --strategy immediate
```

Requires Fly CLI auth (`fly auth login`) and the four `VITE_*` build args. The
GitHub Actions path injects these via `flyctl deploy --build-arg`; for a manual
deploy, set them in your shell before running:

```bash
export VITE_SUPABASE_URL=https://ggspsiexqppduvsqvpgy.supabase.co
export VITE_SUPABASE_ANON_KEY=<from 1Password>
export VITE_SENTRY_DSN=<from Sentry>
export VITE_BUILD_GIT_SHA=$(git rev-parse HEAD)
export VITE_BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
fly deploy -a founderos --strategy immediate \
  --build-arg "VITE_SUPABASE_URL=$VITE_SUPABASE_URL" \
  --build-arg "VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY" \
  --build-arg "VITE_SENTRY_DSN=$VITE_SENTRY_DSN" \
  --build-arg "VITE_BUILD_GIT_SHA=$VITE_BUILD_GIT_SHA" \
  --build-arg "VITE_BUILD_TIME=$VITE_BUILD_TIME"
```

If `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` is missing, the Vite build-time
guard hard-fails with an explicit error — see `ui/vite.config.ts`. The CI smoke also
runs `scripts/ci/check-deployed-supabase.sh` to catch the 2026-05-04 incident class
where the bundle shipped with `placeholder.supabase.co`.

### Migrations

Schema migrations run via `release_command` (set in `fly.toml`) on a single
ephemeral VM **before** any rolling-deploy machine boots:

```toml
[deploy]
  strategy = "rolling"
  release_command = "node /app/packages/db/dist/migrate.js"
```

This eliminates the "old container vs new schema" race during rollover. The
boot-time `ensureMigrations()` in `server/src/index.ts` remains as an idempotent
safety net — Drizzle's migrator no-ops when at head. Belt and suspenders.

---

## 4. Required environment / secrets

### Fly secrets — set on the `founderos` app

The server's startup validator (`server/src/lib/env-validation.ts`) classifies env
into `REQUIRED_IN_PROD` (hard-fail at boot), `WARN` (degraded but boots), and
`INFO`. The list below is the buyer-facing minimum to bring up a healthy
production instance. Set with `fly secrets set -a founderos KEY=VALUE`.

| Secret | Severity | What it does | Where to get it |
|---|---|---|---|
| `DATABASE_URL` | Required | Fly Managed Postgres connection string for `gjpkdonynwy0yln4`. | Fly dashboard → Postgres → Connect. Set during `scripts/fly-provision.sh` if provisioning fresh. |
| `FOUNDEROS_SECRETS_MASTER_KEY` | Required | Master key for the per-company encrypted secrets store (Anthropic keys, Composio per-org auth, etc.). | Generate with `openssl rand -hex 48`. ⚠️ Verify with Vinamr: confirm the key currently set on Fly is the one in 1Password — losing this orphans every encrypted secret in the DB. |
| `FOUNDEROS_AGENT_JWT_SECRET` | Required | Signs internal agent JWTs (heartbeat, runner). PR #109 + #111 closed the null-fallback path; missing this hard-fails. | Generate with `openssl rand -hex 48`. Shared across worktree env files locally; canonical value lives in 1Password / Fly secrets. |
| `BETTER_AUTH_SECRET` | Required | Signs OAuth state on every integration connect (Slack/HubSpot/LinkedIn/Notion), even though Fly uses the Supabase auth provider. Misnamed historically. | Generate with `openssl rand -hex 48`. |
| `FOUNDEROS_NONCE_SECRET` | Required | HMAC key for the unauthenticated `/api/providers/validate-key` single-use nonce. Closes the IP-rotation bypass on the key checker. | Generate with `openssl rand -hex 48`. |
| `SUPABASE_URL` | Required (at provider=supabase) | Supabase project URL — JWKS base for ES256 JWT verification. Throws at boot when unset under `FOUNDEROS_AUTH_PROVIDER=supabase`. | Supabase dashboard → Project Settings → API. |
| `SUPABASE_ANON_KEY` | Required (at provider=supabase) | Supabase anon key — server-side reads of public tables. | Supabase dashboard → Project Settings → API. |
| `SUPABASE_SERVICE_ROLE_KEY` | Required (auth) | Supabase service-role key — server-side admin operations on `auth.users` (post-signup mirror, role grants). Read in `server/src/config.ts`. | Supabase dashboard → Project Settings → API → service_role. ⚠️ Verify with Vinamr: confirm this is currently set on Fly; it does not appear in `env-validation.ts` checks but is read at request time. |
| `SUPABASE_JWT_PUBLIC_KEY` | Required (auth) | ES256 public key for JWT verification. Required because Supabase symmetric `HS256` JWTs fail auth silently against edge functions / asymmetric verifiers. | Supabase dashboard → Project Settings → API → JWT signing keys. |
| `STRIPE_SECRET_KEY` | Warn (live keys deferred) | Stripe billing — checkout, subscription webhook signature verify. With it unset, `/api/billing/checkout` returns 503 and the webhook unmounts. | Stripe dashboard → Developers → API keys. **One-way door — see §7.** |
| `STRIPE_WEBHOOK_SECRET` | Warn (live keys deferred) | Verifies Stripe webhook signatures. Pair with `STRIPE_SECRET_KEY`. | Stripe dashboard → Developers → Webhooks → endpoint signing secret. **One-way door — see §7.** |
| `RESEND_API_KEY` | Warn | Resend transactional email transport (welcome, magic-link, daily digest, weekly wrap). Without it, all email sends silently no-op. | Resend dashboard → API Keys. |
| `EMAIL_UNSUBSCRIBE_SECRET` | Warn | HMAC signing for one-click unsubscribe tokens. CAN-SPAM/GDPR compliance gate; required before any customer-email send. | Generate with `openssl rand -hex 48`. |
| `SENTRY_DSN` | Warn | Server error tracking. Without it, server errors are only in pino logs, which production triage doesn't search. | Sentry dashboard → Project Settings → Client Keys (DSN). |
| `COMPOSIO_API_KEY` | Warn | Composio v3 OAuth + tool execution (Slack, Gmail, Drive, etc.). | Composio dashboard → API Keys. |
| `COMPOSIO_AUTH_CONFIG_<APP>` | Warn (per integration) | Per-toolkit `auth_config.id` (slack, gmail, github, googlecalendar, googlesheets, googledrive, notion, linkedin live on prod). Pre-create in Composio dashboard. | Composio dashboard → Auth Configs. |
| `COMPOSIO_V3_READY` | Info | Set to `1` to enable Composio v3 routes. | Operator flag. |
| `ANTHROPIC_API_KEY` | Warn | Server-level Claude fallback. Founders BYO their own key per-company — this only catches agents that haven't configured a per-company key. | Anthropic Console. |
| `OPENAI_API_KEY` | Warn | Codex adapter host-level fallback. | OpenAI Platform → API keys. |
| `FOUNDEROS_BILLING_GATE_ENABLED` | Info (opt-in) | Set to `1` to enable the 402 hard-fail on inactive subs at `/agents/:id/wakeup` + `/heartbeat/invoke`. **Default OFF for soft rollout.** Flip only AFTER 24h of clean test-mode webhook telemetry — see §7. | Operator flag. |
| `FOUNDEROS_BYO_RUNNER_ENABLED` | Info | Set to `1` to register the `byo_runner` adapter and `/api/runner/*` routes. ADR-011. | Operator flag. |
| `SUPABASE_WEBHOOK_SECRET` | Warn (audit-only) | Verifies Supabase `user.created` webhook signature. Audit-only after the email-squatting fix; bootstrap deferred to first authenticated request. | Supabase dashboard → Database → Webhooks. |

### GitHub Actions secrets — for CI/CD

Set under repo Settings → Secrets and variables → Actions:

| Secret | Used by | Purpose |
|---|---|---|
| `FLY_API_TOKEN` | `deploy-prod.yml` | `flyctl deploy`, `flyctl releases rollback`. Generate with `fly tokens create deploy -a founderos`. |
| `VITE_SUPABASE_URL` | `deploy-prod.yml` | Baked into the SPA bundle at build time. Same value as the Fly secret. |
| `VITE_SUPABASE_ANON_KEY` | `deploy-prod.yml` | Baked into the SPA bundle. Anon key is safe to ship to a public client per Supabase RLS — but sourced from a secret to keep it out of the repo. |
| `VITE_SENTRY_DSN` | `deploy-prod.yml` | Baked into the SPA bundle for browser-side Sentry. Optional. |
| `VERCEL_TOKEN` | `deploy-prod.yml` | Publishes the redirect-only `vercel.json`. The token can be removed once the legacy hostname is fully retired. |
| `SLACK_DEPLOY_WEBHOOK_URL` | `deploy-prod.yml` (optional) | Posts deploy outcome to Slack. If unset, the notify step skips silently. |
| `SENTRY_AUTH_TOKEN` | recommended, not currently set | Required for sourcemap upload on each deploy. ⚠️ Verify with Vinamr: confirm whether this should be added. |

---

## 5. Health checks

| Endpoint | Auth | Use case |
|---|---|---|
| `/api/healthz` | public | Fly liveness probe (every 5s). Cheap process-health only — no DB call. Set in `fly.toml`. |
| `/api/readyz` | public | Fly readiness probe (every 30s) **and** the canonical CI deploy gate. Returns `200 "ready"` if DB reachable + auth bootstrapped, `503` otherwise. Use this for oncall pings and uptime monitoring. |
| `/api/health` | public | Returns `{status, version}` only. Use to confirm a specific build is live. |
| `/api/health/bootstrap-state` | public | Returns deployment posture: `deploymentMode`, `authReady`, `bootstrapStatus`, `bootstrapInviteActive`. Used by the SPA shell. |
| `/api/health/deep` | admin (instance_admin role) | Deep diagnostics — DB latency, Stripe connectivity, Composio status, etc. Hit with an instance-admin credential from oncall dashboards. **Do not use as a CI gate** (returns 401/403 without auth, would auto-rollback every deploy). |
| `/api/health/diagnostics` | admin (instance_admin role) | Returns `deploymentExposure`, enabled features, dev-server info. |

---

## 6. Rollback

### Code rollback (reverts the offending commit)

```bash
gh pr revert <num>            # opens a revert PR
# merge the revert PR; deploy-prod.yml ships it the same way as any other commit.
```

### Fly image rollback (faster — re-points to the prior release)

```bash
fly releases list -a founderos                    # find the previous version
fly releases rollback <version> -a founderos --yes
```

The auto-rollback in `deploy-prod.yml` already does this on smoke or readiness
failure — `rollback-on-fail` reads the pre-deploy version from an artifact and
runs `flyctl releases rollback`, then re-runs the smoke harness against the
restored release.

### One-shot redeploy from a known-good image digest

```bash
fly deploy --image registry.fly.io/founderos:<digest> -a founderos --strategy immediate
```

Image digests are recorded in each `deploy-prod.yml` run output (the `deploy-fly`
job sets `image_digest` and `fly_version` outputs).

---

## 7. One-way doors (BUYER MUST EXECUTE PERSONALLY)

These are operations that change real-money or real-customer state and are
irreversible without manual intervention. Do not delegate to an agent.

1. **Stripe live key flip.** Follow `docs/ops/design-partner-onboarding-kit.md` §2
   step-by-step. Pre-flight checklist must all pass before touching live keys.
   Witnessed by buyer + at least one engineer for the first 60 minutes.
2. **Enable the billing gate in prod.** Run `fly secrets set -a founderos
   FOUNDEROS_BILLING_GATE_ENABLED=1` ONLY after 24h of clean live-mode webhook
   telemetry from step 1. Flips behavior for all customers from soft-fail to
   hard-402 on inactive subscriptions.
3. **Enable GitHub branch protection on `main`.** Follow
   `docs/ops/branch-protection.md`. Once enabled, force-pushes and missing CI
   gates are blocked at the GitHub layer.
4. **Decommission the legacy Vercel hostname.** Once analytics confirm zero
   direct traffic to `founderos-bice.vercel.app` for a full week, the project can
   be torn down. Until then, keep the redirect alive — bookmarks, old emails, and
   prior PR comments still point at it.

---

## 8. Cross-references

This file is the canonical entry point for production deploy. Buyer-facing and
operator-facing depth lives in dedicated documents:

- Buyer onboarding (pricing, Stripe flip script, outreach, first-week timeline,
  escalation): `docs/ops/design-partner-onboarding-kit.md`
- Branch protection setup: `docs/ops/branch-protection.md`
- Release / version-bump automation: `docs/ops/release-process.md`
- Deploy runbook (pipeline diagrams, smoke harness internals, incident replay):
  `docs/ops/deploy-runbook.md`
- BYO Runner smoke (founder-laptop runner setup): `docs/runbooks/byo-runner-smoke.md`
- Stripe webhook smoke: `docs/runbooks/stripe-webhook-smoke.md`
- Sentry alert configuration: `docs/runbooks/sentry-alert-config.md`
- Auth canary (post-deploy): `docs/runbooks/auth-canary.md`
- Supabase configuration: `docs/runbooks/supabase-config.md`
- Incident response: `docs/runbooks/incidents.md`
- ADRs (architectural decision records): `docs/adr/`
- Project handover (always current): `CONTINUE.md`

---

## 9. What NOT to do (regression list)

The pre-2026-05-03 dual-host model created an entire class of failures that
single-origin Fly fixed in one collapse. Re-introducing any of these undoes the
fix.

- **DON'T re-add a Vercel-served UI build.** The single-origin collapse killed
  cross-origin auth (browsers can't attach `Authorization` to
  `new WebSocket(url)`), cookie loss (Safari ITP + SameSite drop cookies on
  cross-origin XHR), and the WS upgrade handshake that Vercel rewrites do not
  proxy (`vercel.json` rewrites are HTTP-only).
- **DON'T add `connect-src` allowlists for Fly to a Vercel CSP.** The UI is on
  Fly now — there is no cross-origin XHR from Vercel-served pages. Adding back
  CSP allowlists implies a host split.
- **DON'T set `FOUNDEROS_BACKEND_URL` anywhere.** That env var was the
  Vercel-rewrite proxy target. It has no consumer in the current model. If you
  see code or docs referencing it, that is dead — delete it.
- **DON'T bake a separate `VITE_API_ORIGIN` into the SPA.** The SPA makes
  same-origin `/api/*` calls. Build-time origin baking was a symptom of the
  split; it is not needed and creates a redeploy-on-host-change footgun.
- **DON'T set `min_machines_running=0` while expecting <5s cold starts.** The
  current `0` (set in `fly.toml`) is acceptable for design partners — first hit
  after idle pays a ~3-5s cold-start tax. At ~1000 active users this becomes
  customer-visible latency; bump to `1` (or higher) before that scale.
- **DON'T put microservices in front of Fly.** A separate API gateway, an edge
  function in front of `/api`, or a Cloudflare Worker that proxies to Fly were
  all considered and rejected in the 2026-05-03 council. The single-origin model
  is structurally simpler than any of them and removes failure modes the
  alternatives reintroduce.
- **DON'T promote a redirect-host change without the production rebuild.**
  `vercel.json` redirect changes only activate on the next push to the Vercel
  production branch. Editing the file on a feature branch and merging the PR
  triggers the production rebuild — but until that push lands on `main`, the
  legacy hostname keeps serving the previous redirect config.
- **DON'T dual-host UI on Fly + Vercel for "redundancy".** The two would drift
  on every deploy because the SPA bundle bakes `VITE_*` build args; a
  Vercel-built bundle and a Fly-built bundle of the same commit are not
  byte-identical. Pick one host. The choice is Fly.
