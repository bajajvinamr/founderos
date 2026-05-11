# S8 P0.1 — Staging Smoke Results

_Status: **Not yet run** — scaffold only. Populated by `scripts/s8-p01-smoke.sh` when the operator runs it post-merge of Phase 1+2._
_Last updated: scaffold committed 2026-05-10_

## Run summary

| Field | Value |
|---|---|
| Run timestamp (UTC) | _populated by script_ |
| Branch              | _populated by script_ |
| Commit SHA          | _populated by script_ |
| Fly app             | founderos-s8smoke |
| Region              | lhr |
| Fly logs            | https://fly.io/apps/founderos-s8smoke/monitoring |
| companyId           | _populated by script_ |
| agentId             | _populated by script_ |
| runId               | _populated by script_ |

## Assertions

| # | Assertion | Status | Evidence |
|---|---|---|---|
| 1 | Run reaches `status='completed'` within 90s | pending | _populated_ |
| 2 | Zero new `runner_jobs` rows during run (hosted path bypasses queue) | pending | _populated_ |
| 3 | `cost_micros` non-null on run row | pending | _populated_ |
| 4 | Workdir cleaned up post-run (`/founderos/agents/<companyId>/<runId>/` absent) | pending | _populated_ |
| 5 | Regression: `byo_runner` path still works with flag off | pending | _populated_ |
| 6 | Memory peak < 1.6gb during run | pending | _populated_ |
| 7 | No errors in fly logs (grep `ERROR\|Sentry` returns no entries for run window) | pending | _populated_ |
| 8 | Workdir is mode `0700` (per-job HOME isolation) before cleanup | pending | _populated_ |

## Decision

- [ ] All 8 assertions pass → proceed to Phase 4 (production flag flip)
- [ ] Any assertion fails → block Phase 4, document remediation in this file

_When the script runs it overwrites this file with a populated version. The scaffold above is committed only so the file path exists pre-merge._
