# Deployment — two-environment model

Two separate instances so the cofounder can test a stable build while we keep shipping on dev.

| Env | UI | Backend | DB | Purpose |
| --- | --- | --- | --- | --- |
| **Prod** | Vercel static SPA (`founderos.vercel.app`) | Fly.io single-tenant (or tunnel fallback) | Fly Managed Postgres | Stable URL for cofounder + customers. Only promote when verified on dev. |
| **Dev** | `pnpm dev` local + Cloudflare tunnel (ephemeral) | Same dev server | Embedded Postgres | Our continuous iteration. New code lands here first. |

## Repo layout

- `main` branch → prod. Vercel auto-deploys on push. Fly auto-deploys on push (when wired).
- `dev` branch → dev. Tunnel + local dev server. No auto-deploy needed.

Promote = merge `dev` → `main`. We only do this when a feature has been eyeballed on dev.

---

## One-time Vercel setup (you, ~3 minutes)

```bash
cd ui
vercel link        # picks the scope + project name, creates .vercel/ directory
vercel env add FOUNDEROS_BACKEND_URL production
# enter: https://prediction-corpus-fan-approximately.trycloudflare.com
#   (or your Fly URL when it exists)
vercel env add FOUNDEROS_BACKEND_URL preview
# enter: same for now, or a separate staging backend
```

Then the first deploy:

```bash
vercel --prod
```

You get a URL like `https://founderos.vercel.app` or `https://founderos-<you>.vercel.app`. That's the stable prod link for your cofounder.

Every subsequent `git push origin main` redeploys automatically.

## Ongoing

- **Dev work**: stays on current flow — `pnpm dev` + `cloudflared tunnel --url http://localhost:3100`. Tunnel URL changes when restarted; that's fine, it's dev.
- **Promote to prod**: `git checkout main && git merge dev && git push`. Vercel picks it up.
- **Backend URL change**: if the tunnel dies and you start a fresh one (or you swap to Fly), update Vercel env:
  ```bash
  vercel env rm FOUNDEROS_BACKEND_URL production
  vercel env add FOUNDEROS_BACKEND_URL production
  # paste the new URL
  vercel --prod  # redeploy
  ```

## Vercel routing

`ui/vercel.json` does two things:

1. **`/api/*` rewrites** to `$FOUNDEROS_BACKEND_URL/api/*` — the UI makes relative `/api` calls; Vercel transparently proxies them to the backend. The cofounder's browser sees a single `founderos.vercel.app` origin; cookies work; no CORS.
2. **SPA fallback** — all non-asset paths serve `/index.html` so client-side routing works.

The backend URL is **not** baked into the bundle. It's a server-side rewrite target resolved at request time. Changing the env var and redeploying swaps the target without a code change.

## When to move the backend to Fly.io

The tunnel model is fine for small-group testing but:

- Tunnel URLs expire after ~8 hours of idle
- Your laptop has to stay online
- First-time visitors hit a small cold-start delay

Switch to Fly when:
- Cofounder tests regularly (not just once)
- You're onboarding a design partner / early customer
- You want a URL that works when your laptop is closed

To switch:

```bash
# 1. Provision Fly (one-time, you run this since it triggers billing)
fly mpg create --name founderos-db --region bom --plan basic --volume-size 10 --pg-major-version 17
./scripts/fly-provision.sh founderos --db-url <attach url from above>

# 2. Update Vercel env
vercel env rm FOUNDEROS_BACKEND_URL production
vercel env add FOUNDEROS_BACKEND_URL production
# enter: https://founderos.fly.dev

# 3. Redeploy UI
vercel --prod
```

The prod UI now proxies to the Fly backend. Dev stays on the tunnel.

## Safety checks before every `git push main`

1. `pnpm typecheck` passes across all workspaces
2. `pnpm test:run` green
3. Quick Playwright smoke (optional): `pnpm test:smoke`
4. Verified on dev tunnel

The GitHub Actions workflow in `.github/workflows/ci.yml` runs 1 + 2 on every PR — don't merge red.
