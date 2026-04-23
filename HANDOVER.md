# FounderOS — Handover

State of the project as of this session. Read-in-10-minutes doc for you, your cofounder, or whoever picks this up next.

## One-liner

**An AI operating layer for solo founders.** 4 pre-briefed department agents, a Decision Inbox, Company Memory, Weekly Wrap, Monthly Review, Composio-backed integrations that actually *act* in Slack / HubSpot / Notion / LinkedIn, multi-tenant + auth + rate-limited + monitored.

## Where it runs

| Layer | URL / Location |
|---|---|
| UI (prod) | `https://founderos-bice.vercel.app` (Vercel static SPA) |
| Backend (prod) | `https://founderos.fly.dev` (Fly.io, lhr region, scale-to-zero) |
| Database | Fly Managed Postgres cluster `gjpkdonynwy0yln4` (lhr) |
| Auth | Supabase project `ggspsiexqppduvsqvpgy` (email+password + Google OAuth) |
| Error monitoring | Sentry projects `4511271233388544` (node) + `4511271318061056` (react) |
| Integrations | Composio workspace `vbseries245_workspace` / project `pr_o2eToZLqyd2b` |
| Demo (interview) | Cloudflare tunnel from local — `scripts/status.sh` shows the current URL |

## One-command status

```sh
./scripts/status.sh
```

Reports all URLs, HTTP health codes, local processes, demo data counts, recent commits, and user-action TODOs.

## What exists — by surface

### Product surfaces
- **Dashboard** (`/`) — Recent Runs ticker, pending outcomes banner, permission coach card, product tour on first visit
- **Decision Inbox** (`/decisions`) — agent-drafted decisions awaiting approval/rejection
- **Departments** (`/departments/{cos,growth,content,finance}`) — per-dept consoles
- **Agents** (`/agents/...`) — agent detail with live run status + cancel + retry
- **Weekly Wrap** (`/weekly`) — Friday 5pm cron auto-generates via CoS, posts to Slack + email
- **Monthly Review** — department grades with recommendations
- **Goals + Issues + Org chart** — project management primitives
- **Conversations** (`/conversations`) — paste transcript → LLM extracts insights → promote to Company Memory
- **Company Memory** — durable lessons surface
- **Integrations** (`/integrations`) — Slack, HubSpot, Notion, LinkedIn, PostHog (native OAuth) + Composio connect buttons
- **Settings → Members** (`/instance/settings/members`) — invite flow
- **Settings → Notifications** — digest on/off + hour + timezone
- **Audit Log** (`/audit`) — filterable event stream + CSV export
- **Legal** (`/legal/{terms,privacy}`) — public policy pages

### Agent skills (actions agents can invoke)
- `slack.post_message`
- `hubspot.create_contact`, `hubspot.log_note`, `hubspot.move_deal`
- `notion.create_page`, `notion.append_block`
- `agent.handoff` — inter-agent dispatch
- Every skill respects the **observe / draft / approve / autonomous** permission ladder
- When `COMPOSIO_API_KEY` is set and the user has connected the tool via Composio, skills auto-route through Composio instead of our native clients — fail-loud on Composio error (no silent dual-run)

### Automation
- **Daily morning digest email** — 15-min cron, timezone-aware, HMAC unsubscribe
- **Weekly Wrap auto-delivery** — Friday 5pm cron
- **Decision outcome follow-ups** — 6h cron, asks "what happened?" 14 days after approval
- **Permission autonomy coach** — Dashboard card suggests moving agents to autonomous based on approval history
- **MPG backups** — auto, every 20 min, documented restore in `docs/runbooks/admin-guide.md`

### CI/CD
- **PR gates** — typecheck, test+coverage, lint, migration-check, schema-drift, bundle-size (1.5MB gzip budget), auto PR summary comment
- **Deploy pipeline** — on main merge: preflight → fly deploy → vercel deploy → smoke → auto-rollback on fail → Slack notify
- **Uptime** — 15-min cron pings prod endpoints, opens an incident issue after 3 consecutive failures, auto-closes on recovery
- **Security** — Dependabot weekly, CodeQL security-extended, gitleaks with custom Anthropic/Supabase/Stripe rules, npm-audit, OSSF scorecard
- **Release** — conventional commits → version bump → tag → CHANGELOG → GitHub release → Sentry release marker + sourcemap upload
- **Repo hygiene** — CODEOWNERS, PR template, issue forms, pr-lint (semantic titles + size budget), CONTRIBUTING, CoC

## Secrets / env vars currently live

**Fly (server):**
```
DATABASE_URL                    — Fly Managed Postgres pgbouncer
FOUNDEROS_SECRETS_MASTER_KEY    — adapter key envelope encryption
FOUNDEROS_DEPLOYMENT_MODE=authenticated
FOUNDEROS_DEPLOYMENT_EXPOSURE=public
FOUNDEROS_AUTH_PROVIDER=supabase
FOUNDEROS_PUBLIC_URL=https://founderos-bice.vercel.app
FOUNDEROS_ALLOWED_HOSTNAMES=founderos-bice.vercel.app,founderos.fly.dev,...
FOUNDEROS_MIGRATION_AUTO_APPLY=true
BETTER_AUTH_SECRET              — legacy, still set for fallback path
SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
COMPOSIO_API_KEY                — activates the Composio routing layer
SENTRY_DSN                      — server-side error capture
```

**Vercel (UI build-time):**
```
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
VITE_SENTRY_DSN                 — browser-side error capture
VITE_SENTRY_ENVIRONMENT=production
VITE_FOUNDEROS_ONBOARDING_V2=true  — the 6-step founder onboarding
FOUNDEROS_BACKEND_URL           — for vercel.json rewrites
```

## What YOU still need to do

| # | Task | Why | Effort |
|---|---|---|---|
| 1 | `FLY_API_TOKEN` + `VERCEL_TOKEN` as GitHub repo secrets | Activates the push-to-main auto-deploy pipeline. Without them, deploy-prod.yml fails on first push. | 3 min |
| 2 | Enable branch protection on `main` | Stops anyone (including you) from merging past a failing CI check. See `docs/ops/branch-protection.md` for the exact checklist. | 5 min |
| 3 | Stripe account + keys | The scaffold returns 501 today. Paste `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and a price ID as Fly secrets; the `billing` service will light up. | 15 min once keys exist |
| 4 | Connect real Slack/HubSpot/Notion via Composio | Agents can't act in your real accounts until a user clicks Integrations → Connect via Composio. | 2 min per tool |
| 5 | `SLACK_DEPLOY_WEBHOOK_URL` as a GitHub secret (optional) | Enables deploy notifications in your Slack. | 5 min |
| 6 | `SENTRY_AUTH_TOKEN` as a GitHub secret (optional) | Sourcemap upload on release so Sentry stack traces deobfuscate. | 2 min |
| 7 | Resend paid tier | Free tier caps at 3k emails/mo, you'll hit it around 30 active users. | $20/mo |

## Things I explicitly did NOT do

- **Deleted Paperclip's legacy `master`-branch workflows** — left `pr.yml`, `docker.yml`, `refresh-lockfile.yml`, `release.yml` alone. They never fire on `main`, so they're dormant. Remove them if you want a clean Actions tab.
- **Pushed to a git remote** — this repo has no origin set up yet. `git remote -v` is empty. Add one: `git remote add origin git@github.com:your-org/founderos.git && git push -u origin main dev`.
- **Registered an OAuth app with each provider (Slack/HubSpot/Notion/LinkedIn)** — not needed once Composio handles it, and you haven't asked. If you want native OAuth as backup, register per-provider apps and set the `*_CLIENT_ID` / `*_CLIENT_SECRET` env vars.
- **Tested Composio with a real connected account** — requires you to click through the OAuth flow as a user. The scaffolding works end-to-end; the live assertion awaits.

## How to verify Sentry end-to-end

```sh
# Server side (throws a controlled error that Sentry will capture)
curl -s https://founderos.fly.dev/api/debug/sentry-canary
# Expect: 500 response. Check Sentry dashboard — the error should appear within 10s.

# Browser side (triggers a render-time exception once you wire a button)
# Visit https://founderos-bice.vercel.app, open DevTools console, run:
# throw new Error("Canary")
# Sentry's browser SDK will catch and ship it.
```

The `debug-canary` endpoint is instance-admin gated. If you're signed in as your cofounder (non-admin), it'll 403 instead of throwing.

## Incident response

See `docs/runbooks/incidents.md` for the top 8 incidents + recipes. Most likely failure modes:
- Fly cold-start timeout (normal — scale-to-zero): wait 10s, retry
- Supabase auth 403 after OAuth: Site URL drift — check `https://api.supabase.com/v1/projects/{ref}/config/auth`
- Deploy smoke fails: auto-rollback kicks in; then manual investigation. See `docs/ops/deploy-runbook.md`

## Where the code lives (quick map)

```
server/src/
├── routes/          — all Express routers
├── services/        — business logic per domain
│   └── skills/      — agent-invokable actions (Slack, HubSpot, Notion, handoff)
├── middleware/      — auth, rate-limit, Sentry, private-hostname guard
├── auth/            — Supabase JWKS verification + post-signup bootstrap
└── routines/        — cron jobs (digest, weekly-wrap, decision-followup)

packages/
├── db/              — Drizzle schema + migrations + embedded Postgres helpers
├── shared/          — types + constants used by UI and server
├── adapters/        — Claude / Codex / Cursor / Gemini adapters
├── templates/       — company templates (indie-saas, b2b-saas, ai-lab)
└── plugins/sdk/     — plugin SDK for external tool integrations

ui/src/
├── pages/           — route components
├── components/      — shared UI (sidebar, layout, agent cards)
├── components/onboarding/  — the 6-step founder flow
├── api/             — typed fetch wrappers per domain
└── context/         — Supabase auth, Company, Dialog, Breadcrumb

.github/workflows/   — CI/CD (see .github/workflows/README.md)
scripts/             — dev + CI tooling
docs/                — runbooks, deploy guides, interview demo script
```

Last updated: end of this session. Go sell it.
