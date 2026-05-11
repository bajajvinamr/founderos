# S8 P0.1 — Staging Smoke Runbook (operator-facing)

This runbook tells the **operator** (you, post-merge) how to run the staging smoke for the S8 P0.1 hosted-agent-execution sprint. The script itself is `scripts/s8-p01-smoke.sh` — the source of truth for the assertions. This document is a checklist; if something here disagrees with the script, the script wins.

## When to run

Run after **Phase 1 + Phase 2 PRs are merged** into `release/s8-p01-hosted-execution`, and **before** the Phase 4 production flag flip.

## Pre-flight checklist

Confirm each item before `--execute`. The script will refuse to run if any of the env vars are missing, but it will not warn about scope or cost.

- [ ] On branch `release/s8-p01-hosted-execution` or `main` (or `chore/s8-p01-staging-smoke` for the dry-run rehearsal).
- [ ] `flyctl` installed and authenticated (`fly auth whoami` returns your account).
- [ ] `psql` installed (used by assertion #2 against `STAGING_DB_URL`). If absent, the runner-jobs assertion is skipped and must be verified manually from the Fly Postgres console.
- [ ] `jq` installed (used to parse onboarding/run JSON responses).
- [ ] `FLY_API_TOKEN` exported — token must be scoped to the org that will own `founderos-s8smoke`.
- [ ] `ANTHROPIC_API_KEY` exported — a **test** key, not your production key. The first onboarded smoke company will use this. Source: 1Password "FounderOS / smoke-keys".
- [ ] `STAGING_DB_URL` exported — Postgres URL for the staging DB the smoke app will point at. Format `postgres://user:pass@host:5432/db?sslmode=require`. **Must be a staging DB** — the script writes a smoke company + agent there.
- [ ] (Optional) `FOUNDEROS_SECRETS_MASTER_KEY` exported. If unset, the script generates one and prints it once. Save it to 1Password if you want to re-run cleanly.
- [ ] (Optional) `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` — forwarded as `--build-arg` to `fly deploy`. Not needed for the API surface the smoke exercises but they are baked into the SPA build.

## Cost estimate

Provisioning `founderos-s8smoke` will create:

| Resource | Spec | Approx. monthly cost (lhr) |
|---|---|---|
| Fly machine | shared-cpu-2x, 2gb (matches prod fly.toml) | ~$5–8 (auto-stop when idle) |
| Fly volume `founderos_data` | 3gb, lhr | ~$0.45 |
| Fly Postgres | bring-your-own (`STAGING_DB_URL`) | n/a — pre-existing |

Total: **<$10/mo if left running**. Tear down with `--cleanup` after smoke to drop to $0.

The script does not provision a new Postgres cluster — `STAGING_DB_URL` is expected to point at an existing staging DB you already pay for.

## The four commands

All commands run from the repo root.

### 1. Dry run (always do this first)

```bash
bash scripts/s8-p01-smoke.sh --dry-run
```

Prints every `fly`, `curl`, and `psql` command the script will execute, without running any of them. No env vars required. **Read the output.** If anything looks wrong (wrong app name, wrong region, unexpected secret name), stop and edit the script.

### 2. Execute

```bash
export FLY_API_TOKEN="fo1_..."
export ANTHROPIC_API_KEY="sk-ant-..."
export STAGING_DB_URL="postgres://..."
bash scripts/s8-p01-smoke.sh --execute
```

The script:

1. Validates env + branch.
2. Provisions the Fly app + volume (idempotent; re-runs skip if present).
3. Sets secrets and deploys.
4. POSTs to `/api/onboarding/bootstrap` with the test Anthropic key.
5. POSTs to `/api/agents/<id>/wakeup` and polls `/api/agents/<id>/runs/latest` (5s interval, 90s timeout).
6. Runs the 8 assertions (see below).
7. Writes `.planning/PHASE-S8-P01/SMOKE-RESULTS.md` with pass/fail evidence.

Expected runtime: 5–8 minutes (most of it deploy + first run).

### 3. Inspect results

```bash
git diff .planning/PHASE-S8-P01/SMOKE-RESULTS.md
fly logs -a founderos-s8smoke --no-tail | tail -100
```

The script writes a structured markdown table with one row per assertion, plus the `companyId` / `agentId` / `runId` so you can correlate against logs.

### 4. Cleanup (after success)

```bash
bash scripts/s8-p01-smoke.sh --cleanup
```

Prompts for `destroy` confirmation, then runs `fly apps destroy founderos-s8smoke --yes`. Drops monthly cost to $0. Skip if you want the staging app left up for follow-on debugging.

## The 8 assertions

| # | Assertion | What pass means | What failure means |
|---|---|---|---|
| 1 | Run reaches `status='completed'` within 90s | Hosted execution path completed end-to-end. | Either the heartbeat didn't fire, the adapter chooser didn't pick `claude_local`, or the run errored. Inspect Fly logs. |
| 2 | Zero new `runner_jobs` rows during run | Hosted path correctly bypasses the BYO queue. | Hosted runs are leaking into the queue. Check `adapter-resolver.ts` family routing. |
| 3 | `cost_micros` non-null on run row | Cost telemetry wiring is intact. | Sonnet/Haiku token accounting is silently dropping. Block Phase 4. |
| 4 | Workdir cleaned up post-run | Per-run `/founderos/agents/<companyId>/<runId>/` is removed. | Disk leak — over time the volume fills. Check the `finally` block in the workdir lifecycle. |
| 5 | Regression: `byo_runner` path still works with flag off | Customers who deployed with `byo_runner` are unaffected. | S8 P0.1 broke the legacy path. Block Phase 4. |
| 6 | Memory peak < 1.6gb during run | Hosted execution fits in the 2gb machine spec. | Memory regression — risk of OOM under concurrent agents on prod. |
| 7 | No `ERROR`/`Sentry` markers in recent logs | Run was clean. | Some boundary error fired and got swallowed by retry logic. Inspect. |
| 8 | Workdir is mode `0700` before cleanup | Per-job HOME isolation prevents cross-tenant FS leakage. | Permission regression — block Phase 4 (security boundary). |

## Failure escalation

If any assertion fails:

1. **Do not proceed to Phase 4.** The flag flip is gated on a clean staging smoke.
2. Paste the full `SMOKE-RESULTS.md` table + Fly logs link into the Phase 4 PR thread.
3. Reference `.planning/PHASE-S8-P01/COUNCIL-R1.md` for the original risk surface — most failures map to a flagged risk.
4. Open a `fix/s8-p01-<failing-assertion>` branch and remediate. Re-run `--execute` after the fix lands.
5. Only the operator who ran the smoke should mark the Phase 4 gate green — do not let CI auto-promote.

## Rollback (if smoke passes but production deploy regresses)

This runbook is staging-only. For production rollback see `.planning/PHASE-S8-P01/IMPLEMENTATION-PLAN.md` § "Risk + rollback":

```bash
fly secrets set FOUNDEROS_HOSTED_AGENTS_ENABLED=0 -a founderos
# Then the documented one-time SQL to flip stuck agents back to byo_runner.
```

## References

- Implementation plan: `.planning/PHASE-S8-P01/IMPLEMENTATION-PLAN.md` (origin/docs/s8-p01-architecture-plan)
- Council review: `.planning/PHASE-S8-P01/COUNCIL-R1.md`
- BYO runner reference smoke (different path, same shape): `docs/runbooks/byo-runner-smoke.md`
- Fly app: https://fly.io/apps/founderos-s8smoke (after first `--execute`)
