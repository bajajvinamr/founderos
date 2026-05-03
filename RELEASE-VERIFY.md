# Release Verification Checklist

Run after every `release-main.yml` to confirm a release actually deployed
both the API server (Fly) and the UI (Vercel). Catches silent deploy failures
that only surface when a buyer can't open the wizard or the agent runtime
keeps restarting.

## TL;DR

```bash
# 1. Check release pipeline result on the latest main commit:
gh run list --workflow=release-main.yml --limit 3 --json status,conclusion,headSha,createdAt \
  | jq -r '.[] | "\(.createdAt | split("T")[0]) \(.headSha[0:7]) \(.conclusion // .status)"'

# 2. If the latest run is `success`: smoke prod
bash scripts/verify-prod-deploy.sh

# 3. If the latest run is `failure`: investigate, then re-run
gh run rerun --failed <RUN_ID>
```

## Required environment

The smoke script reads two env vars (sensible defaults):

| Var | Default | Purpose |
|---|---|---|
| `FOUNDEROS_PROD_API_URL` | `https://founderos.fly.dev` | Fly server URL |
| `FOUNDEROS_PROD_UI_URL` | `https://founderos-bice.vercel.app` | Vercel UI URL |
| `MIN_VERSION` | `0.2.16` | Minimum acceptable server `version` from `/api/health` |

## What gets checked

`scripts/verify-prod-deploy.sh` runs three checks against prod:

1. **API health** (`/api/health`) — confirms the server is up, returns
   `status: "ok"`, and reports a `version` >= `MIN_VERSION`. A version
   mismatch usually means `release-main.yml` did not run on the latest main
   commit (billing block, hook failure, or manual cancel).

2. **UI shell** — confirms `${UI_URL}/onboarding` returns the SPA index HTML
   with `<div id="root">` and (best-effort) the hashed JS bundle reference.
   Catches a stale Vercel deploy that's still pointing at a previous build.

3. **Companies endpoint** — confirms `/api/companies` returns 200 (in
   `local_trusted` mode) or 401/403 (in `authenticated` mode). Either is fine
   — both prove the route is alive. A 5xx or 000 (unreachable) is a hard
   fail.

## What goes wrong

### `version` lower than `MIN_VERSION`
`release-main.yml` did not run on the latest main commit. Common causes:

- **GitHub Actions billing block** — the org/account hit a payment failure
  or spending limit. Settings → Billing & plans → resolve. Then:
  `gh run rerun --failed <RUN_ID>`.
- **The release commit was a `[skip ci]` chore** — these don't trigger
  `release-main.yml`. If a feature commit was skipped, push a no-op commit
  to re-trigger.
- **Pre-deploy hook failed** (typecheck, test, bundle-size) — read the run
  logs: `gh run view <RUN_ID>` then fix the underlying issue.

### `/api/health` unreachable

- **Fly machine in unhealthy state** — `fly status -a founderos` shows
  whether the machine is suspended or restarting.
- **Cold start after extended idle** — first request wakes the machine; the
  smoke script retries 3× with 3s backoff for this case.
- **DNS propagation issue** — uncommon but possible after a region change.

### UI HTML missing `#root` or hashed bundle

- Vercel's `vercel.json` rewrites are misconfigured.
- The build job in `release-main.yml` succeeded but the `vercel deploy` step
  silently uploaded an empty artifact.
- A previous deploy remained pinned via the Vercel dashboard.

## Standing operating procedure (post-merge)

After every PR merge to `main`, in order:

1. **Wait for `release-main.yml` to finish** (typically 8-12 minutes):
   ```bash
   gh run list --workflow=release-main.yml --limit 1
   ```
2. **If it succeeded**:
   ```bash
   bash scripts/verify-prod-deploy.sh
   ```
   On green, you're done. On any red, follow the "what goes wrong" section.

3. **If it failed**:
   ```bash
   gh run view <RUN_ID> --log-failed | head -100
   ```
   Identify the failure root cause:
   - **Billing**: surface to operator; this is a one-way door.
   - **Pre-deploy gate**: re-run after fixing the gate.
   - **Fly/Vercel deploy step**: re-run; usually transient.

4. **Always run `verify-prod-deploy.sh` even on a clean release** — proves
   the deploy actually took, not just that CI was green.

## Known good prod baseline (as of 2026-05-02)

| Component | Version / commit |
|---|---|
| Server | `0.3.1` (in `server/package.json`; bumped independent from root release tags) |
| Latest release tag | `v0.2.16` (root, at `31c4656`) |
| Last main commit | `82ca8e2` (PR #19 wizard fix) |
| `release-main.yml` on `82ca8e2` | **FAILED** (billing block — PR #19 not deployed) |
| Bootstrap status | `ready` (instance admin exists) |
| Deployment mode | `authenticated` (auth required for /api/companies) |

This baseline is the snapshot the smoke script asserts against. Update the
table when prod's known-good version changes.

## Adding new checks

When a release surfaces a regression that the smoke missed, add a new check
to `scripts/verify-prod-deploy.sh`. Keep it:

- **Fast** — one HTTP call, < 3s typical.
- **Quiet** — `green ""` on success, `red ""` on fail. No console noise.
- **Specific** — the failure message must name the exact symptom and the
  most likely root cause.

Anti-pattern: "smoke that walks the whole product" — that's what
`e2e/tests/route-smoke.spec.ts` is for. This script is the deploy gate, not
the regression suite.
