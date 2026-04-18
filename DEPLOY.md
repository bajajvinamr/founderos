# FounderOS Deployment

Single-tenant deployment: one app per customer, each on their own Fly.io account (or yours, if you're running managed hosting). Designed to spin up in <10 minutes.

## Prerequisites

- `flyctl` installed and logged in (`fly auth login`)
- A Supabase project (or any Postgres 14+) for `DATABASE_URL`
- A Claude subscription (for `claude_local` agents) or an Anthropic API key

## First deploy (from this repo)

```bash
# 1. Launch the app without deploying yet
fly launch --no-deploy --copy-config --name founderos-yourco

# 2. Create the persistent volume (3 GB in the same region as the app)
fly volumes create founderos_data --region bom --size 3

# 3. Set secrets
fly secrets set DATABASE_URL="postgresql://postgres:<pw>@<host>:5432/postgres"

# Auth — set these to enable Clerk. Without them the app falls back to
# better-auth (legacy email/password) or, if FOUNDEROS_DEPLOYMENT_MODE is
# set to "local_trusted", a zero-auth dev mode.
fly secrets set CLERK_SECRET_KEY="sk_live_..."
fly secrets set CLERK_PUBLISHABLE_KEY="pk_live_..."

# Optional: one of these depending on how agents should auth
# Headless (CI-style) — a subscription token exported from `claude login` locally
fly secrets set CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat-..."
# Or direct API key
fly secrets set ANTHROPIC_API_KEY="sk-ant-..."

# Optional: for FounderOS's own local encrypted secrets store
fly secrets set FOUNDEROS_SECRETS_MASTER_KEY="$(openssl rand -base64 32)"

# 4. Deploy
fly deploy
```

The Dockerfile's multi-stage build produces a ~800 MB image (includes Claude Code, Codex, and OpenCode CLIs so any agent adapter works out of the box). Fly's build cache reuses layers across deploys.

## What happens on boot

1. `docker-entrypoint.sh` remaps the `node` UID/GID to match the volume's owner
2. The server starts and:
   - Runs pending Drizzle migrations (idempotent)
   - Initializes the local secrets store on the volume
   - Mounts the UI static dist at `/`
   - Mounts the API at `/api`
   - Begins the heartbeat scheduler for every enabled agent

Health check path: **`GET /api/health`** — returns 200 with deployment mode + bootstrap status.

## Updating a deployed instance

```bash
fly deploy
```

Drizzle migrations apply on boot; UI hot-swaps. No downtime unless a migration
takes a DDL lock.

## Rollback

```bash
fly releases
fly releases rollback <version>
```

## Scaling

- **Memory:** if agents run into OOM, bump the `[[vm]] memory` in fly.toml to `2gb`
- **Concurrency:** fine up to ~200 active users per 1 GB instance; scale horizontally by adding machines
- **DB:** Supabase's free tier is fine for <50K row writes/month; upgrade to Pro when you exceed

## Single-tenant vs multi-tenant

The current Dockerfile assumes **one FounderOS instance per customer** (a separate Fly app). To go multi-tenant, you'll need:

- Row-level security on every Drizzle query keyed by `tenantId`
- A root authentication layer above Better Auth
- Shared secrets store with per-tenant encryption keys

That's Phase 3 work; don't do it until you've sold 5+ customers.

## Environment variables summary

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection (Supabase session-pool works) |
| `CLERK_SECRET_KEY` | yes (prod) | Clerk secret — enables Clerk-backed auth |
| `CLERK_PUBLISHABLE_KEY` | yes (prod) | Clerk publishable — sent to browser for SignIn UI |
| `ANTHROPIC_API_KEY` | one-of | Direct Anthropic billing |
| `OPENAI_API_KEY` | one-of | Direct OpenAI billing |
| `GEMINI_API_KEY` | one-of | Direct Google AI billing |
| `CLAUDE_CODE_OAUTH_TOKEN` | one-of | Subscription-backed auth (no per-token billing) |
| `SENTRY_DSN` | optional | Server-side error tracking. If unset, no Sentry code runs. |
| `VITE_SENTRY_DSN` | optional | Browser error tracking. Set at **build time** (baked into the UI bundle). |
| `SENTRY_TRACES_SAMPLE_RATE` | optional | Defaults to `0.1`. Lower for high-traffic deployments. |
| `FOUNDEROS_SECRETS_MASTER_KEY` | recommended | Key for the local encrypted secrets store |
| `PORT` | no | Defaults to 3100 |
| `FOUNDEROS_DEPLOYMENT_MODE` | no | `authenticated` (default in Docker) or `local_trusted` for single-user |
| `SERVE_UI` | no | `true` in prod; server serves UI dist from the same port |

## Alternative deploys

- **Railway:** Dockerfile works as-is. Set the same env vars. No volume support below Hobby plan.
- **Render:** Docker deploy. Attach a persistent disk. Health check `/api/health`.
- **Self-hosted Docker:** `docker build -t founderos . && docker run -v founderos_data:/founderos -p 3100:3100 -e DATABASE_URL=... founderos`

## Cost floor

On Fly.io, **single-tenant cost ≈ $5–10/customer/month** at the shared-cpu-1x / 1gb tier with auto-stop. Scale-to-zero means paying customers who aren't actively using the product cost near $0.
