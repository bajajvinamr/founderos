# Supabase build-config — exact deploy procedure

This runbook fixes (and prevents recurrence of) the 2026-05-04 production
incident where the Vite SPA shipped with a literal `placeholder.supabase.co`
URL because the Fly Docker build never received the real
`VITE_SUPABASE_URL` as a build arg.

## Why this happened (one-paragraph postmortem)

Before 2026-05-03, Vercel built the SPA and injected `VITE_*` env vars
from its dashboard. The 2026-05-03 council pass collapsed UI deployment
to Fly (single-origin), but the `VITE_*` build-arg wiring did not get
ported into the `Dockerfile` or `flyctl deploy` command. The Vite build
ran with the env vars unset, the runtime fallback `https://placeholder.supabase.co`
in `ui/src/lib/supabase.ts` got embedded, and the bundle silently
shipped to prod for ~24 hours. The e2e suite missed it because
`FOUNDEROS_E2E_PROFILE=public-only` skips auth-mutation tests.

Defenses now stacked:
1. `ui/vite.config.ts` build-time guard hard-fails the build if VITE_*
   env vars are missing or contain the placeholder sentinel.
2. `ui/src/lib/supabase.ts` runtime guard captures structured Sentry
   errors + browser-console logs on any auth call against a misconfigured
   client.
3. `Dockerfile` declares `ARG VITE_*` + assigns them to `ENV` so Vite's
   build process inherits them.
4. `.github/workflows/deploy-prod.yml` passes them to `flyctl deploy
   --build-arg`. CI hard-fails if the GitHub secret is empty.
5. `scripts/ci/check-deployed-supabase.sh` curls every `<script src>`
   asset on the deployed origin and fails if any contains the placeholder
   string. Wired into the `smoke` job.

## Manual deploy — exact one-liner

```bash
fly deploy --app founderos --ha=false --remote-only \
  --build-arg "VITE_SUPABASE_URL=https://ggspsiexqppduvsqvpgy.supabase.co" \
  --build-arg "VITE_SUPABASE_ANON_KEY=$(op read 'op://Production/Supabase/anon_key' 2>/dev/null || echo "$VITE_SUPABASE_ANON_KEY")" \
  --build-arg "VITE_SENTRY_DSN=${VITE_SENTRY_DSN:-}" \
  --build-arg "VITE_BUILD_GIT_SHA=$(git rev-parse HEAD)" \
  --build-arg "VITE_BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

Replace the project ref `ggspsiexqppduvsqvpgy` if it has changed (see
the Supabase dashboard URL: `https://supabase.com/dashboard/project/<ref>`).

## What to set as a GitHub Secret

For automated deploys via `deploy-prod.yml`, set these in
`Settings → Secrets and variables → Actions`:

| Secret name | Value | Scope |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://ggspsiexqppduvsqvpgy.supabase.co` | Public (it's in every bundle) — but kept in secrets to centralize |
| `VITE_SUPABASE_ANON_KEY` | The `anon` key from Supabase dashboard → Project Settings → API | Public by design (RLS enforces access on the server side) |
| `VITE_SENTRY_DSN` | Browser DSN from Sentry project settings | Optional — leave empty to disable browser Sentry |
| `FLY_API_TOKEN` | Already exists | — |

The deploy workflow will refuse to start if either of the first two is
empty (see the guard at `.github/workflows/deploy-prod.yml`).

## Verifying the fix

After redeploying, confirm:

```bash
# Should print a real https://*.supabase.co host, NOT placeholder.supabase.co
curl -s https://founderos.fly.dev/ \
  | grep -oE 'src="[^"]*\.js"' \
  | head -1 \
  | sed -E 's/src="([^"]+)"/\1/' \
  | xargs -I{} curl -s "https://founderos.fly.dev{}" \
  | grep -oE 'https://[a-z0-9.-]*\.supabase\.co' \
  | sort -u

# Or the script we just shipped:
scripts/ci/check-deployed-supabase.sh https://founderos.fly.dev
# → "OK: deployed bundle does not contain the placeholder Supabase host."
```

Then test live auth:
1. Open https://founderos.fly.dev/auth in an incognito window
2. Click "Continue with Google" — should redirect to a real
   `*.supabase.co/auth/v1/authorize` URL, NOT `placeholder.supabase.co`
3. Try email signup with a fresh address — should succeed, not "Failed to fetch"

## DevTools self-service

The new `supabase.ts` exposes two globals on `window`:

```javascript
__authDebug()         // dumps current Supabase URL, key prefix, build SHA, online state
__authErrors()        // dumps the ring buffer of recent auth failures
__authBreadcrumbs()   // dumps the ring buffer of fetch breadcrumbs
```

When a user reports "I can't log in," the first ask is "open DevTools,
paste `__authErrors()` in the console, send the table." That's faster
than reproducing.

## If you ever delete this runbook

The build-time guard (`ui/vite.config.ts`) and the deploy-time check
(`scripts/ci/check-deployed-supabase.sh`) make this incident class
impossible to ship again — even if this doc is gone. Both will print
explicit fix instructions when they fire.
