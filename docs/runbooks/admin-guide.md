---
title: Admin Guide
summary: Running a FounderOS instance — deploy modes, invites, backups, migrations, upgrades
---

For the person who hosts the instance. For day-to-day use, see the [User Guide](./user-guide.md). When things break, see [Incidents](./incidents.md).

## Demo mode

Spin up an interview-ready demo with three canonical portfolio companies (agnost.ai, Pred, Gravton Labs) plus an experimental 4th (Little Wins). Run against a local or staging Postgres — never prod.

```sh
# One-liner — seeds companies, 90 days of agent activity, decision inbox,
# company memory, and connected integrations (Slack, HubSpot, PostHog).
DATABASE_URL=postgres://founderos:founderos@127.0.0.1:54329/founderos \
  pnpm seed:demo
```

The demo seed runs three layers in order:

1. `packages/db/src/seed-demo.ts` — the 3 canonical portfolio companies, ~23 agents, goals, projects, live issues.
2. `packages/db/src/seed-demo-depth.ts` — 90 days of heartbeat_runs, cost_events, approvals, budget_incidents, extended activity_log.
3. `packages/db/src/seed-demo-narrative.ts` — company_memory (insider lessons), expanded Decision Inbox, connected integrations + cached sync data; also appends Little Wins as an experimental 4th company.

To wipe and re-seed (requires explicit confirmation):

```sh
# Interactive prompt
DATABASE_URL=… pnpm seed:demo:reset

# Non-interactive (CI / scripts)
DATABASE_URL=… SEED_DEMO_RESET_YES=1 pnpm seed:demo:reset
```

Reset matches companies by name (`agnost.ai`, `Pred`, `Gravton Labs`, `Little Wins`) and deletes all cascading rows. Anything outside those 4 names is untouched.

Live demo UI typically runs at `http://localhost:3003`.

## Deployment modes

Two orthogonal dimensions: auth model + network exposure. Pick per deploy.

### Mode: `local_trusted` vs `authenticated`

| Mode | Auth | Use when |
|---|---|---|
| `local_trusted` | No login. Auto-user. | Running on your laptop for yourself. Single-operator dev. |
| `authenticated` | Email+password via Better Auth. | Anyone else will ever touch this instance. Always for cloud. |

Set via `FOUNDEROS_DEPLOYMENT_MODE=authenticated`.

### Exposure: `private` vs `public`

Only matters in `authenticated` mode.

| Exposure | Bind | Reached via | Use when |
|---|---|---|---|
| `private` | `loopback` / `lan` / `tailnet` | Tailscale, VPN, LAN | Team-only access, no public URL needed |
| `public` | `loopback` (behind proxy) or `lan` | Public Fly/Vercel URL | Customer-facing, anyone on internet with URL |

Set via `FOUNDEROS_DEPLOYMENT_EXPOSURE=public` and `FOUNDEROS_PUBLIC_URL=https://founderos-<slug>.fly.dev`.

### Recommended combos

```sh
# Local dev (default)
FOUNDEROS_DEPLOYMENT_MODE=local_trusted

# Team on Tailscale
FOUNDEROS_DEPLOYMENT_MODE=authenticated
FOUNDEROS_DEPLOYMENT_EXPOSURE=private
FOUNDEROS_BIND=tailnet

# Cloud-hosted for the buyer + their customers
FOUNDEROS_DEPLOYMENT_MODE=authenticated
FOUNDEROS_DEPLOYMENT_EXPOSURE=public
FOUNDEROS_PUBLIC_URL=https://founderos-acme.fly.dev
```

Full matrix in [deploy/deployment-modes.md](../deploy/deployment-modes.md).

---

## First-boot bootstrap

When a fresh `authenticated` instance comes up, it has no admin user. Every route is gated by `BootstrapPendingPage` which says **"Instance setup required"**. Two ways to resolve:

### Option A — CLI bootstrap invite (recommended)

From inside the instance:

```sh
pnpm founderos auth bootstrap-ceo
```

Prints a one-time `/board-claim/<token>?code=<code>` URL. The first signed-in user who visits this URL becomes the instance admin. After claim:

- That user is promoted to instance admin
- The auto-created local board admin is demoted
- The user is added as active member on all seeded companies

### Option B — SQL promote (emergency)

If the CLI isn't reachable (container running, no shell) you can promote an existing auth user directly. **Only do this if you know what you're doing.**

```sql
-- 1. Find the user
SELECT id, email FROM "user" ORDER BY created_at DESC LIMIT 5;

-- 2. Promote to instance admin
INSERT INTO instance_admin (user_id, granted_at)
VALUES ('<user-uuid>', NOW())
ON CONFLICT (user_id) DO NOTHING;

-- 3. (If needed) add to a company as member
INSERT INTO company_member (user_id, company_id, role, granted_at)
VALUES ('<user-uuid>', '<company-uuid>', 'admin', NOW())
ON CONFLICT DO NOTHING;
```

Reload the page — the gate drops.

---

## Inviting teammates

Wave 12B ships invite-based onboarding. Path: **Instance Settings → Members** (`/instance/settings/members`).

### Flow

1. Admin → **Invite user** → enters email
2. System generates `/invite/<token>` and mails it (if `RESEND_API_KEY` is set) or shows it inline
3. Recipient visits link → creates account → lands on dashboard, auto-added to default company

### Revoking / auditing

On the same page:

- **Pending** — invites not yet accepted. Revoke to invalidate the token.
- **Active** — users currently signed up. Removing them drops company membership but keeps the `user` row (audit trail).

Invites expire after 7 days. Re-issue if stale.

---

## Managing instance API keys

Adapter API keys (Anthropic, OpenAI, Gemini) are encrypted at rest using `FOUNDEROS_SECRETS_MASTER_KEY` (AES-256-GCM envelope encryption).

### Where keys live

- **UI:** `/instance/settings/providers` — paste, test, save. Reveals presence but never the raw value after save.
- **DB:** `instance_secret` table. Rows are `{ref, ciphertext, nonce}`. Plaintext is never stored.
- **Agent env:** injected as env vars only at agent process spawn time.

### Rotating a key

```sh
# 1. Revoke at provider (Anthropic console → API keys → revoke old)
# 2. Create new key at provider
# 3. In FounderOS UI: Providers → Anthropic → replace key → Test
```

Agents pick up the new key on their next heartbeat (no restart needed).

### Strict mode

Set `FOUNDEROS_SECRETS_STRICT_MODE=true` to reject raw env-var keys and force everything through the UI/DB vault. Recommended for production.

---

## Rotating `BETTER_AUTH_SECRET`

`BETTER_AUTH_SECRET` signs all session cookies. Rotating = every active session is invalidated — **users must log in again**.

### When to rotate

- Suspected leak (e.g. ex-contractor had env access)
- Quarterly hygiene
- After any incident where envs may have been exposed

### How

```sh
# 1. Generate new secret
openssl rand -base64 32

# 2. Set on the instance (Fly example)
fly secrets set BETTER_AUTH_SECRET="<new-base64>" --app founderos-<slug>

# 3. Fly restarts the machine automatically. All users logged out.
# 4. Broadcast to users: "You'll need to log in again."
```

**Gotcha:** do not rotate `FOUNDEROS_SECRETS_MASTER_KEY` the same way — that one decrypts adapter keys. Rotating it orphans every stored API key. If you must rotate the master key, export and re-enter every adapter key from `/instance/settings/providers` after.

---

## Backups

### Fly Managed Postgres (automated)

MPG takes continuous backups out of the box: full snapshots, incremental WAL, and differentials. Verify they're running:

```sh
fly mpg backup list <cluster-id>
```

You should see recent `full`, `incr`, and `diff` entries with status `completed`.

### Restore to a point in time

```sh
# List available backups
fly mpg backup list <cluster-id>

# Create a new cluster restored from a specific backup
fly mpg restore <cluster-id> --backup-id <backup-id> --name founderos-restore-test

# Attach the restored cluster to a test app and verify schema + data
fly mpg connect <restored-cluster-id>
```

**Always test restore into a scratch cluster at least quarterly.** Untested backups aren't backups.

### Manual pg_dump (defense in depth)

```sh
pg_dump "postgresql://user:pass@host:5432/founderos" \
  --no-owner --no-acl --format=custom \
  > founderos-$(date +%Y%m%d-%H%M).dump

pg_restore --no-owner --no-acl --clean --if-exists \
  -d "postgresql://user:pass@host:5432/founderos" \
  founderos-20260421.dump
```

### Cadence recommendation

| Frequency | Keep for | Store where |
|---|---|---|
| Daily automated dump | 14 days | Same region object storage (S3/R2) |
| Weekly full dump | 90 days | Cross-region object storage |
| Before every migration | Until confirmed stable | Local + object storage |

Don't forget the persistent volume (`/founderos` on Fly) — it holds the secrets master key file. If you lose the volume AND the env var, every stored adapter key is unrecoverable. Back up the master key separately (1Password / secret manager).

---

## Migrations

FounderOS uses Drizzle ORM. Migrations live at `packages/db/src/migrations/*.sql` with a journal at `packages/db/src/migrations/meta/_journal.json`.

### Running migrations

Migrations run automatically on server boot. To run manually:

```sh
pnpm --filter @founderos/db migrate
```

### Adding a new migration (if you patch the schema)

```sh
# 1. Edit schema in packages/db/src/schema/*.ts
# 2. Generate
pnpm --filter @founderos/db generate

# 3. Check it — ALWAYS run this after generate
pnpm --filter @founderos/db check:migrations
```

### The journal gotcha

**Critical:** if you drop a new `.sql` file into `packages/db/src/migrations/` without a matching entry in `meta/_journal.json`, the typecheck `check:migrations` will fail with:

```
Migration journal/file count mismatch: journal has N, files have M
```

Always use `pnpm --filter @founderos/db generate` — it writes both the `.sql` file AND updates the journal. Never hand-drop a SQL file. If you did, fix:

1. Open `packages/db/src/migrations/meta/_journal.json`
2. Add the missing entry: `{"idx": <next-idx>, "when": <timestamp>, "tag": "<filename-without-.sql>", "breakpoints": true}`
3. Make sure snapshots in `meta/<idx>_snapshot.json` exist — regenerate if missing

Full reconciliation steps in [Incidents → Migration journal mismatch](./incidents.md#migration-journal-mismatch).

---

## Audit log

Every state-changing action writes to the `activity` table. View at `/audit-log` (`AuditLog` page).

### What gets logged

- Agent lifecycle: created, paused, deleted, permission changed
- Decisions: requested, approved, rejected
- Issues: created, transitioned, deleted
- Integrations: connected, removed, synced
- Company memory: written, edited
- Instance admin: granted, revoked
- Adapter keys: saved, tested, removed (ciphertext only, never plaintext)

### Filters

- **Entity type** — `agent`, `issue`, `integration`, `company_memory`, etc.
- **Actor** — which user or which agent caused it
- **Time range**

For forensics on a cost spike or unauthorized change, filter to the suspect time window and sort by entity.

### Retention

Currently unbounded (grows forever). Plan a quarterly `DELETE FROM activity WHERE created_at < NOW() - INTERVAL '180 days'` once the table exceeds ~1M rows.

---

## Disabling adapters for users

You may want to force users onto a single provider (cost control, compliance). Two ways:

### Env-var lockdown

```sh
# Only Anthropic enabled
FOUNDEROS_ENABLED_ADAPTERS=claude_local
```

(Name-check the exact env var against `server/src/config.ts` if it drifts.)

### Admin UI

`/instance/settings/adapters` (AdapterManager). Flip the toggle per adapter. Disabled adapters disappear from user-facing agent config dropdowns and return an error if referenced by existing agents.

When disabling an adapter that agents currently use: those agents will fail on next heartbeat with "adapter disabled". Either reassign them to a different adapter first, or pause them.

---

## Billing

Currently **scaffolded, not shipped**. See [docs/billing/README.md](../billing/README.md) for the full stub state.

TL;DR of what's wired today:

- `instance_subscription` table exists
- `/api/billing/status` returns `{active: true, plan: "free"}` unconditionally
- `/api/billing/checkout` returns 501
- `/api/billing/webhook` returns 501

Don't rely on billing gates for production. When Wave 12C+ ships the full Stripe integration, this section updates.

---

## Upgrading FounderOS

### Standard upgrade (Fly deploy)

```sh
# 1. Snapshot DB first (see Backups above)
pg_dump ... > pre-upgrade-$(date +%Y%m%d).dump

# 2. Pull latest code
cd ~/Projects/founderos
git fetch origin
git checkout main
git pull

# 3. Verify it builds + typechecks locally
pnpm install
pnpm typecheck
pnpm test:run

# 4. Deploy
fly deploy --app founderos-<slug>

# 5. Smoke test
./scripts/fly-smoke.sh founderos-<slug>
```

Migrations run on boot — don't need a manual step.

### Vercel UI upgrade

If the backend is on Fly but the UI is on Vercel:

```sh
# After pushing to main, Vercel auto-deploys.
# If FOUNDEROS_BACKEND_URL changed (Fly instance re-provisioned, tunnel cycled):
cd ui
vercel env rm FOUNDEROS_BACKEND_URL production
vercel env add FOUNDEROS_BACKEND_URL production
# paste new URL
vercel --prod
```

Details in [DEPLOYMENT.md](../../DEPLOYMENT.md).

### Rollback

Fly keeps the previous release:

```sh
fly releases --app founderos-<slug>
fly releases rollback <version> --app founderos-<slug>
```

If a migration broke something, rollback the release AND restore the pre-upgrade DB dump. Never try to hand-un-migrate.

---

## Resetting a user's password

Self-serve reset isn't wired (no email token flow yet). Do it manually:

```sh
# 1. Confirm the user exists
psql "$DATABASE_URL" -c "SELECT id, email FROM \"user\" WHERE email='victim@example.com';"

# 2. Generate a new random password, hash via better-auth's hasher
# Easiest: delete the user and re-invite
DELETE FROM "account" WHERE user_id='<uuid>';
DELETE FROM "user" WHERE id='<uuid>';

# 3. Re-invite from /instance/settings/members
```

Full self-serve reset flow is on the roadmap.

---

## Monitoring (Sentry error tracking)

Unhandled exceptions in the backend and frontend are automatically captured to **Sentry** when configured.

### Configuration

Set these secrets/env vars in your deployment:

| Variable | Type | Purpose |
|----------|------|---------|
| `SENTRY_DSN` | Secret | Sentry error tracking DSN for backend. Generate at [sentry.io](https://sentry.io). |
| `VITE_SENTRY_DSN` | Env | Sentry error tracking DSN for frontend (browser). Can be same as backend or separate. |
| `SENTRY_ENVIRONMENT` | Env | Sentry environment label (e.g. `staging`, `production`). Defaults to `NODE_ENV`. |

**Example (Fly.io):**
```bash
fly secrets set SENTRY_DSN="https://key@sentry.io/project" --app founderos-acme
fly config set VITE_SENTRY_DSN="https://key@sentry.io/project" --app founderos-acme
fly config set SENTRY_ENVIRONMENT="production" --app founderos-acme
fly deploy --app founderos-acme
```

### What gets captured

- **Backend**: Unhandled exceptions during request processing, boot failures, service errors
- **Frontend**: JavaScript errors, promise rejections, React component errors (if `@sentry/react` integration is active)

Both are captured *before* being returned as HTTP 500 errors or logged.

### Finding errors

Once configured, errors appear in your Sentry dashboard:
- **Recent Issues** — list of errors grouped by type/message
- **Releases** — errors tied to specific app versions
- **Search** — filter by URL, user, error type, environment

### If not configured

If `SENTRY_DSN` and `VITE_SENTRY_DSN` are not set, Sentry is disabled (no-op). Errors still log locally and return HTTP 500 to clients.

---

## Security quick-checks

Before handing an instance to a customer:

- [ ] `FOUNDEROS_DEPLOYMENT_MODE=authenticated`
- [ ] `BETTER_AUTH_SECRET` is long (32+ bytes) and unique per instance
- [ ] `FOUNDEROS_SECRETS_MASTER_KEY` is backed up to a secret manager
- [ ] `FOUNDEROS_ALLOWED_HOSTNAMES` matches your public URL
- [ ] HTTPS everywhere (Fly gives this, Vercel gives this — check custom domains)
- [ ] First-admin bootstrap completed; no leftover `/board-claim` URL is active
- [ ] Backups tested — restore into a scratch DB at least once
- [ ] Adapter keys set via UI vault, not raw env vars (if `STRICT_MODE` is on)

---

## Next steps

- [Incidents](./incidents.md) — what to do when something breaks
- [Self-host on Fly](../deploy/self-host-fly.mdx) — initial provisioning
- [Deployment modes](../deploy/deployment-modes.md) — detailed mode reference
- [Environment variables](../deploy/environment-variables.md) — full env var table
