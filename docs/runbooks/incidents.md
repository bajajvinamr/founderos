---
title: Incidents
summary: What to do when FounderOS breaks — login failures, stuck agents, cost spikes, DB drops
---

On-call playbook. Each section: symptom → root cause → fix. Assumes admin access to the instance. Not sure if you have that? See [Admin Guide → First-boot bootstrap](./admin-guide.md#first-boot-bootstrap).

---

## Login returns 403

**Symptom:** user hits `/auth`, enters valid credentials, gets a 403 (or a "CSRF check failed" / "trusted origin" error in server logs).

**Root cause:** Better Auth rejects the request because the incoming `Origin` header isn't in the trusted-origins list. This happens when `FOUNDEROS_ALLOWED_HOSTNAMES` or `BETTER_AUTH_URL` is missing, stale, or doesn't match the URL the user is actually hitting (e.g. Vercel renamed a preview, Fly URL changed, you added a custom domain).

**Fix:**

```sh
# Check current values
fly ssh console --app founderos-<slug> -C 'env | grep -E "ALLOWED_HOSTNAMES|BETTER_AUTH_URL|FOUNDEROS_PUBLIC_URL"'

# Set all three (adjust values)
fly secrets set \
  FOUNDEROS_ALLOWED_HOSTNAMES="founderos-<slug>.fly.dev,founderos.vercel.app,your-custom.com" \
  BETTER_AUTH_URL="https://founderos.vercel.app" \
  FOUNDEROS_PUBLIC_URL="https://founderos.vercel.app" \
  --app founderos-<slug>
```

Comma-separated list, no spaces, no protocol prefix for hostnames. `BETTER_AUTH_URL` IS the full URL with `https://`.

If the UI is on Vercel and the backend is on Fly: `BETTER_AUTH_URL` must be the **public-facing UI URL** (Vercel), not the Fly URL — because that's the origin the browser sends.

Fly restarts automatically after `secrets set`. Verify with:

```sh
curl -s https://founderos-<slug>.fly.dev/api/auth/config | jq .
```

---

## "Instance admin required" blocks everyone

**Symptom:** every page shows **"Instance setup required. No instance admin exists yet."** No one can log in past this screen.

**Root cause:** `authenticated` mode is on but no row exists in `instance_admin`. Usually because bootstrap was skipped, or the one admin was deleted.

**Fix A — rotate the bootstrap invite (if you have shell access):**

```sh
fly ssh console --app founderos-<slug> -C 'cd /app && pnpm founderos auth bootstrap-ceo'
```

Copy the `/board-claim/<token>?code=<code>` URL, paste into a browser, sign in (or create) a user → claim.

**Fix B — SQL promote an existing auth user:**

```sh
fly postgres connect --app <your-pg-app>
```

```sql
-- Find the user
SELECT id, email, created_at FROM "user" ORDER BY created_at DESC LIMIT 5;

-- Promote
INSERT INTO instance_admin (user_id, granted_at)
VALUES ('<user-uuid>', NOW())
ON CONFLICT (user_id) DO NOTHING;

-- Add as member to the default company
INSERT INTO company_member (user_id, company_id, role, granted_at)
SELECT '<user-uuid>', id, 'admin', NOW() FROM company LIMIT 1
ON CONFLICT DO NOTHING;
```

Reload the UI — gate drops.

---

## Tunnel dead / Vercel 502s

**Symptom:** Vercel UI loads but every `/api/*` call returns 502 or times out. Or Cloudflare tunnel URL returns "1033 Argo tunnel error".

**Root cause:** dev deploy uses a `cloudflared --url http://localhost:3100` ephemeral tunnel. It dies after ~8h idle, on laptop sleep, or on network change. Vercel's `FOUNDEROS_BACKEND_URL` still points at the dead tunnel.

**Fix:**

```sh
# 1. Restart tunnel locally
cloudflared tunnel --url http://localhost:3100
# copy the new https://<random>.trycloudflare.com URL

# 2. Update Vercel env
cd ~/Projects/founderos/ui
vercel env rm FOUNDEROS_BACKEND_URL production
vercel env add FOUNDEROS_BACKEND_URL production
# paste the new trycloudflare.com URL, hit enter

# 3. Redeploy
vercel --prod
```

Production Vercel picks up the new backend URL on the fresh deploy. Users need to hard-refresh (⌘⇧R) if they had an old `/api/*` response cached.

**Permanent fix:** move backend to Fly. See [DEPLOYMENT.md → When to move the backend to Fly.io](../../DEPLOYMENT.md#when-to-move-the-backend-to-flyio).

---

## Migration journal mismatch

**Symptom:** `pnpm typecheck` or CI fails with:

```
Migration journal/file count mismatch: journal has 47, files have 48
```

Or `Migration journal/file order mismatch at position N`.

**Root cause:** someone hand-added a `.sql` file to `packages/db/src/migrations/` without a journal entry, or committed a journal edit without the corresponding SQL file.

**Fix:**

```sh
cd /Users/vinamr/Projects/founderos
ls packages/db/src/migrations/*.sql | sort
jq '.entries | .[] | .tag' packages/db/src/migrations/meta/_journal.json
```

Compare the two lists. Whichever is missing is what you reconcile.

**If a SQL file is missing:** delete the orphan journal entry, OR add back the SQL. Usually the SQL got lost in a rebase — `git log --all -- packages/db/src/migrations/` will find it.

**If a journal entry is missing for an existing SQL file:**

1. Open `packages/db/src/migrations/meta/_journal.json`
2. Find the highest `idx` in `entries[]`
3. Append the new entry:

```json
{
  "idx": <next-idx>,
  "when": <unix-ms-timestamp>,
  "tag": "<sql-filename-without-.sql-extension>",
  "breakpoints": true
}
```

4. Also make sure `packages/db/src/migrations/meta/<idx>_snapshot.json` exists. If missing, regenerate:

```sh
# Nuclear option — regenerates journal + snapshots from schema + existing SQL
rm packages/db/src/migrations/meta/_journal.json
rm packages/db/src/migrations/meta/*_snapshot.json
pnpm --filter @founderos/db generate
```

Caveat: `drizzle-kit generate` may try to emit a new SQL file for drift it finds — review carefully before committing.

5. Verify:

```sh
pnpm --filter @founderos/db check:migrations
```

Must exit 0.

---

## Agent stuck in a loop

**Symptom:** one agent is burning heartbeats at max cadence, same issue, same action, never completing. Costs climbing fast.

**Root cause:** agent is caught on a contradictory goal, hit a retryable error it can't resolve, or has `autonomous` permission on a task it lacks context for.

**Fix — triage in order:**

```sh
# 1. Kill the current run (UI)
# Navigate to /<company>/agents/<id> → "Pause" button
# This stops the next heartbeat.

# 2. If the loop is already in-flight (agent mid-run):
```

```sql
-- Mark the active run as errored
UPDATE agent_run
SET status='error', error_message='admin kill — loop detected', ended_at=NOW()
WHERE agent_id='<uuid>' AND status='running';
```

```sh
# 3. Inspect why
# /audit-log filtered by entity_type=agent_run, entity_id=<agent-id>
# Look for: identical actions repeated, 429/5xx from adapter, empty response contents

# 4. Lower permission level
# UI → Agent → Edit → Permission level → drop from autonomous to suggest
# This forces the agent to ask before acting on the next wake.
```

**Root cause patterns:**

- Permission is `autonomous` on a task the user never fully specified → drop to `suggest`
- Agent is rewriting the same issue back and forth → rewrite the issue description with a concrete acceptance criterion
- Adapter is returning empty completions → check provider status (is Anthropic down?); switch adapter temporarily

---

## Costs spiking

**Symptom:** `/costs` shows 10x normal daily spend. Anthropic console shows usage climbing. Budget alerts firing.

**Possible causes — check in order:**

### 1. Leaked API key

Check Anthropic console → usage broken down by IP or by source. Any usage from IPs you don't recognize = leak.

```sh
# Rotate immediately
# Anthropic console → API keys → revoke leaked key → create new
# FounderOS UI → /instance/settings/providers → Anthropic → replace key → Test
```

Then audit: how did it leak? Check `.env.*` files committed to git, CI logs with secrets printed, screen shares, env var dumps in support tickets.

### 2. Runaway agent

```sh
# /costs → sort per-agent spend desc
# Top agent is usually the culprit.
# Navigate to /<company>/agents/<id> → "Pause"
# Then investigate: see "Agent stuck in a loop" above.
```

### 3. Heartbeat cadence too aggressive

Global instance env (if someone set this):

```sh
fly ssh console --app founderos-<slug> -C 'env | grep HEARTBEAT'
```

If `FOUNDEROS_HEARTBEAT_INTERVAL_MS` is set below 60000 (1min), that explains it. Reset:

```sh
fly secrets unset FOUNDEROS_HEARTBEAT_INTERVAL_MS --app founderos-<slug>
```

### 4. Audit log dive

For everything that hit the adapter in the spike window:

```sql
SELECT actor_id, actor_type, COUNT(*), MAX(created_at)
FROM activity
WHERE entity_type='agent_run'
  AND created_at BETWEEN '<start>' AND '<end>'
GROUP BY actor_id, actor_type
ORDER BY COUNT(*) DESC;
```

The noisiest actor = first suspect.

---

## Email not sending

**Symptom:** invites don't arrive. Password resets don't arrive. Logs show "email send skipped" or 4xx from Resend.

**Check in order:**

### 1. `RESEND_API_KEY` not set

Logs show: `email send skipped — RESEND_API_KEY not set`.

```sh
fly secrets set RESEND_API_KEY="re_xxxxx" --app founderos-<slug>
```

### 2. Sender domain unverified

Resend rejects sends from unverified domains with a 403. Default sender is `onboarding@resend.dev` (works without verification but has strict rate limits).

For production, verify your own domain:

1. [resend.com/domains](https://resend.com/domains) → **Add domain**
2. Add the SPF + DKIM DNS records it shows you (TXT + CNAME)
3. Wait for verification (usually < 15min)
4. Update sender:

```sh
fly secrets set FOUNDEROS_EMAIL_FROM="noreply@yourdomain.com" --app founderos-<slug>
```

### 3. 4xx/5xx from Resend

Check [resend.com/emails](https://resend.com/emails) — the dashboard shows every send attempt and the failure reason:

- 422 "validation_error" — bad `to` or `from` format
- 429 "rate_limit_exceeded" — you're over the free tier. Upgrade or throttle.
- 5xx — Resend outage; usually <30min

---

## DB connection drops

**Symptom:** server logs show `ECONNREFUSED`, `Connection terminated unexpectedly`, or `timeout exceeded when trying to connect` bursts. Requests intermittently 500.

**Check in order:**

### 1. Fly MPG status

```sh
fly postgres list
fly logs --app <your-pg-app> | tail -100
```

Look for OOM, disk-full, or CPU pegged.

```sh
fly status --app <your-pg-app>
```

Machine state should be `started`. If `stopped` or `starting` repeatedly — increase VM size:

```sh
fly scale vm shared-cpu-2x --app <your-pg-app>
```

### 2. Connection pool exhaustion

Default pool size is small. If FounderOS is holding too many open connections (agents + UI + heartbeats), Postgres refuses new ones.

```sh
# On the Fly app, check env:
fly ssh console --app founderos-<slug> -C 'env | grep -i pool'
```

Raise:

```sh
fly secrets set DATABASE_POOL_MAX=20 --app founderos-<slug>
```

(Verify the exact env var name in `server/src/db-client.ts` or similar — may be `PGPOOL_MAX` or `DB_POOL_SIZE` depending on wave.)

### 3. Long-running transactions

```sql
SELECT pid, now() - pg_stat_activity.query_start AS duration, query, state
FROM pg_stat_activity
WHERE (now() - pg_stat_activity.query_start) > interval '30 seconds'
  AND state != 'idle';
```

Any query running > 30s is suspicious. Kill it:

```sql
SELECT pg_terminate_backend(<pid>);
```

Then file an issue — something in the app is holding a txn too long.

### 4. DNS / network flap between regions

If Fly app and Fly Postgres are in different regions, cross-region hops add latency and occasional drops. Move them to the same region:

```sh
fly regions list --app founderos-<slug>
fly regions add <region> --app <your-pg-app>
# wait for replication, then remove the old region
```

---

## Escalation checklist

When you've tried everything in the relevant section and it's still broken:

- [ ] Capture current logs: `fly logs --app founderos-<slug> > incident-$(date +%Y%m%d-%H%M).log`
- [ ] Capture DB state: `pg_dump ... > incident-db-$(date +%Y%m%d-%H%M).dump`
- [ ] Screenshot the UI error (network tab open, console tab open)
- [ ] Note the exact time window, affected users, and suspected trigger (deploy? env change? external?)
- [ ] Post to the founder with all four attached

Do not guess-fix under pressure — the DB dump is cheap, the post-mortem is valuable.

---

## Next steps

- [Admin Guide](./admin-guide.md) — prevention-side work
- [User Guide](./user-guide.md) — what users expect when everything works
