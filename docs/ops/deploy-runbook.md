# Production Deploy Runbook

How FounderOS gets to production, how to override the pipeline, what happens
when things go wrong, and how to respond.

Owner: platform.
Last changed: 2026-04-21 (Wave 22B).

---

## TL;DR

- Every merge to `main` triggers `.github/workflows/deploy-prod.yml`.
- The workflow runs: **preflight → deploy-fly → deploy-vercel → smoke → (rollback-on-fail) → notify**.
- If smoke fails, Fly auto-rolls-back to the previous release. Vercel is NOT
  rolled back (Vercel keeps the previous deployment alive + reachable via
  `vercel rollback` manually if needed).
- `.github/workflows/uptime.yml` probes production every 15 minutes. Three
  consecutive failures opens a de-duplicated `incident` issue. It auto-closes
  when probes recover.

---

## Pipeline

```
push to main
    │
    ▼
┌───────────────┐  typecheck + pnpm test:run. Fails fast.
│  preflight    │
└──────┬────────┘
       │
       ▼
┌───────────────┐  flyctl deploy --app founderos --ha=false --remote-only
│  deploy-fly   │  records image digest + previous release version
└──────┬────────┘
       │
       ▼
┌───────────────┐  npx vercel --prod --yes --token=$VERCEL_TOKEN
│ deploy-vercel │
└──────┬────────┘
       │
       ▼
┌───────────────┐  scripts/ci/smoke.sh hits 3 endpoints, 3 retries, exp backoff.
│    smoke      │
└───┬──────┬────┘
    │ pass │ fail
    │      │
    ▼      ▼
┌────┐  ┌──────────────────┐  flyctl releases rollback <previous>
│ ok │  │ rollback-on-fail │  + scripts/ci/rollback-verify.sh (re-smokes)
└────┘  └────────┬─────────┘  + posts GitHub deployment status "failure"
         │
         ▼
   ┌──────────┐  Slack webhook (if SLACK_DEPLOY_WEBHOOK_URL set).
   │  notify  │  GitHub deployment status update (success or rollback).
   └──────────┘
```

### Job dependencies

| Job                 | Needs                                    | Runs on            | Timeout |
|---------------------|------------------------------------------|--------------------|---------|
| `preflight`         | —                                        | ubuntu-latest      | 20 min  |
| `deploy-fly`        | `preflight`                              | ubuntu-latest      | 20 min  |
| `deploy-vercel`     | `deploy-fly`                             | ubuntu-latest      | 15 min  |
| `smoke`             | `deploy-fly, deploy-vercel`              | ubuntu-latest      | 10 min  |
| `rollback-on-fail`  | `deploy-fly, smoke` (only if smoke fails)| ubuntu-latest      | 15 min  |
| `notify`            | all above (always)                       | ubuntu-latest      | 5 min   |

### Endpoints hit by smoke

| URL                                              | What it proves                                                  |
|--------------------------------------------------|-----------------------------------------------------------------|
| `https://founderos.fly.dev/api/healthz`          | Fly backend process is up and serving.                          |
| `https://founderos-bice.vercel.app/`             | Vercel static SPA is reachable and returns the SPA shell.       |
| `https://founderos-bice.vercel.app/api/healthz`  | The Vercel→Fly `/api/*` proxy rewrite (`vercel.json`) is alive. |

Each must return `200` within 30s. Three attempts per URL, backoff `2s → 4s`.

---

## Required secrets

All configured at **repo → Settings → Secrets and variables → Actions**.

| Secret                        | Source                                 | Required? |
|-------------------------------|----------------------------------------|-----------|
| `FLY_API_TOKEN`               | `flyctl auth token`                    | yes       |
| `VERCEL_TOKEN`                | Vercel dashboard → Account → Tokens    | yes       |
| `SLACK_DEPLOY_WEBHOOK_URL`    | Slack incoming webhook for #deploys    | no        |

`VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` are hardcoded in the workflow from
`.vercel/project.json`. They are not secrets — the project is identified by
these IDs, but only the token actually authenticates. If the Vercel project
is ever swapped, update the `env:` block in `deploy-prod.yml`.

---

## Manual / emergency overrides

### Re-run a failed deploy

1. Go to the Actions tab → pick the failed run → **Re-run failed jobs**.
2. Concurrency group is `production` with `cancel-in-progress: false`, so a
   re-run waits for any in-flight deploy to finish.

### Deploy without the smoke gate (emergency only)

`workflow_dispatch` on `deploy-prod.yml` accepts `skip_smoke=true`. Only use
this when smoke is flaky but the backend is known-good (e.g. Fly API 503ing).

```
Actions → Deploy Prod → Run workflow → branch=main → skip_smoke=true
```

This skips step 4 AND step 5 (rollback). You own the risk.

### Deploy from a laptop

Fallback path — still supported:

```bash
flyctl deploy --app founderos --ha=false
npx vercel --prod --yes
scripts/ci/smoke.sh \
  --url https://founderos.fly.dev/api/healthz \
  --url https://founderos-bice.vercel.app/ \
  --url https://founderos-bice.vercel.app/api/healthz
```

The smoke script has no side effects — safe to run locally against any URL.

### Force a rollback without a failed deploy

```bash
flyctl releases list --app founderos        # find the version you want
flyctl releases rollback <version> --app founderos --yes
scripts/ci/rollback-verify.sh \
  --url https://founderos.fly.dev/api/healthz \
  --url https://founderos-bice.vercel.app/ \
  --url https://founderos-bice.vercel.app/api/healthz
```

For Vercel rollbacks:

```bash
npx vercel rollback <deployment-url> --token=$VERCEL_TOKEN
```

---

## Failure branches — what happens, what to check

### preflight fails (typecheck or tests red)

- No deploy runs.
- Fix locally, push another commit. No rollback needed.
- Check: PR CI (`.github/workflows/ci.yml`) should have caught this. If CI
  passed but main failed, suspect: flaky test, lockfile drift after squash,
  or a race with main.

### deploy-fly fails

- Vercel is **not** touched. The previous Fly release is still serving.
- Check: `flyctl logs --app founderos`, `flyctl status --app founderos`.
- Common causes: Docker build fail, migration error on boot, secret missing.
- No rollback needed — nothing changed.

### deploy-vercel fails

- Fly has new code, Vercel still serving old SPA.
- SPA calls `/api/*` which proxies to `founderos.fly.dev` — old UI will hit
  new backend. This is fine if API is backwards-compatible (it should be),
  risky if not.
- Fix: re-run the Vercel job. If it keeps failing, consider rolling Fly back
  manually (`flyctl releases rollback`) until Vercel can catch up.

### smoke fails

- `rollback-on-fail` runs automatically.
- Fly is rolled back to the previously recorded release version.
- `scripts/ci/rollback-verify.sh` re-runs smoke. If it's still red (exit 2),
  GitHub logs will contain the "ESCALATE" banner.
- Escalation order:
  1. Check Fly: `flyctl status --app founderos`, `flyctl logs --app founderos`.
  2. Check Vercel: Vercel dashboard → most recent prod deployment → logs.
  3. Check upstream: Fly Postgres, Supabase, any LLM provider.
  4. If old release is also broken, roll back further:
     `flyctl releases rollback <older-version> --app founderos`.

### rollback-verify fails (exit 2)

- The previous release is ALSO broken. Usually means infrastructure, not code.
- Open a war-room, page platform, do NOT auto-roll-back further.

---

## Responding to an uptime incident

The `uptime.yml` workflow runs every 15 minutes. On 3 consecutive failures,
it opens a GitHub issue titled **"Uptime: production endpoints failing"**
with the `incident` label. The issue comments on each subsequent failure
and auto-closes when probes recover.

Playbook:

1. Triage: the issue body links to the most recent workflow run. Open it.
2. Identify which endpoint is down. The smoke JSON artifact is attached to
   the run (`uptime-results-<run-id>`).
3. If Fly is down → follow "deploy-fly fails" or "smoke fails" above.
4. If Vercel proxy is down but Fly is up → check `vercel.json` rewrites, then
   redeploy Vercel only.
5. If all three are down → check GitHub Actions runner status, DNS, and
   whether it's actually a probe-side network issue. The `runbooks/` dir
   has infrastructure playbooks.
6. Comment on the issue with the root cause before closing it. Uptime will
   auto-close on recovery, but a manual comment is useful postmortem context.

---

## The smoke script: run it anywhere

```bash
scripts/ci/smoke.sh --url <url> [--url <url> ...] \
  [--retries 3] [--timeout 30] [--initial-delay 2] \
  [--expect 200] [--json results.json] [--quiet]
```

- Portable: works on macOS and Linux (needs `curl` + `python3` for
  millisecond-resolution latency; falls back to seconds without `python3`).
- No side effects: HTTP GETs only. Safe to run against prod.
- Stdout: summary table. Stderr: per-attempt chatter + failure repro info.
- Exit: 0 all-green, 1 one-or-more-failed, 2 bad invocation.

The rollback companion:

```bash
scripts/ci/rollback-verify.sh --url <url> [--url <url> ...]
```

- Waits 15s for Fly to route traffic after a rollback.
- Uses more generous retries (5x, initial 3s backoff, 45s timeout) because
  cold-started machines can be slow after an auto-stop period.
- Exit codes: 0 healthy, 2 still broken → escalate.

---

## Related

- `.github/workflows/ci.yml` — PR gate (typecheck + tests on every PR).
- `.github/workflows/deploy-prod.yml` — this pipeline.
- `.github/workflows/uptime.yml` — 15-minute uptime heartbeat.
- `scripts/ci/smoke.sh` — smoke harness.
- `scripts/ci/rollback-verify.sh` — post-rollback re-smoke.
- `scripts/fly-smoke.sh` — deeper functional smoke (templates, providers,
  spawn round-trip). Not wired into CI; useful for manual validation.
- `fly.toml` — Fly app config.
- `vercel.json` — Vercel config, proxy rewrites.
- `.vercel/project.json` — project/org IDs.
