# Forward Plan — FounderOS · 2026-04-23

Locked after the 2026-04-23 retrospection pass. Source of truth for the next 90 days.

## North Star

- **Outcome (90 days, by 2026-07-22):** 10 paying companies @ $99+/mo
- **Constraint:** Founder time ≤30 hr/week — anything requiring white-glove dies
- **Excellence dimensions:** (1) self-serve onboarding <15 min to first working agent, (2) agent task completion >90% or graceful root-caused failure

## What the retro actually told us

1. **Accretion, not compounding.** Features shipped; gates didn't. Repo is getting cheaper to add to, more expensive to change.
2. **Implication next 30–90 days:** Optimize cost-per-feature, not feature count. Every PR must retire as much debt as it creates. Enforceable gates > ADRs.
3. **Blind spot:** Zero load today = false calm. Composio v1 / flakes / heartbeat.ts bloat are latent landmines. The first 10 users detonate them simultaneously.

## Milestones

### M1 — Foundation-hardening · target 2026-05-07

- **Deliverable:** Composio v3 migration, per-file DB fixtures (flakes fixed at root cause), CI file-size gate (warn ≥1500, fail ≥2500 lines).
- **Success:** `pnpm -w run test` exits 0 on 5 consecutive runs; `composio.executeTool()` returns `ok:true` on live Slack send; CI fails on any new file ≥2500 lines.
- **Verification:** `for i in 1 2 3 4 5; do pnpm -w run test || exit 1; done && curl -sf https://founderos.fly.dev/api/health/deep | jq -e '.status=="ok"'`
- **Effort:** human ~4 days / CC ~6 hours
- **Blast radius:** Composio break → integration silent failures; rollback = revert commit + redeploy. No existing connected accounts in prod.
- **One-way door?** No. All reversible.
- **Dependencies:** Composio API key (have it).

### M2 — Self-serve + billing live · target 2026-05-28

- **Deliverable:** Stripe live keys wired ($99/mo), PostHog funnel on onboarding, time-to-first-agent-run dashboard, 375px mobile path tested.
- **Success:** P50 signup → first-agent-run ≤15 min over last 20 signups; Stripe test→live verified with real $1 charge + refund; PostHog funnel shows per-step drop-off.
- **Verification:** `pnpm --filter @founderos/server test src/__tests__/billing-*.test.ts && gh api /repos/:owner/:repo/actions/workflows/e2e-ci.yml/runs --jq '.workflow_runs[0].conclusion' | grep success`
- **Effort:** human ~7 days / CC ~12 hours
- **Blast radius:** Real money flows. Mandatory `/codex` adversarial review on billing code.
- **One-way door?** **YES — Stripe live keys + webhook.** Rollback = disable webhook secret + refund any charge via dashboard. Pre-flight: test-mode signup + charge + refund + cancel all working first.
- **Dependencies:** M1 complete. GitHub repo secrets for `STRIPE_WEBHOOK_SECRET`.

### M3 — Agent reliability + support deflection · target 2026-06-25

- **Deliverable:** `task_completions` table + per-agent success rate UI, stuck-task auto-detection + alerts, runbooks for top 10 failure modes, first 3 paying customers onboarded personally (LAST white-glove investment). Includes synthetic load test against 10 concurrent signups.
- **Success:** Aggregate task completion rate ≥90% over last 7 days; stuck-task alert <5 min after detection links to runbook; 3 paying customers, each ≥10 tasks run, ≥100% 14-day retention.
- **Verification:** `psql $DATABASE_URL -c "SELECT AVG(CASE WHEN status='completed' THEN 1 ELSE 0 END) FROM tasks WHERE created_at > NOW() - INTERVAL '7 days'"` ≥0.90
- **Effort:** human ~10 days / CC ~18 hours
- **Blast radius:** Medium. New DB table — additive only, no destructive migrations.
- **One-way door?** Partial — schema. Mitigation: additive columns only.
- **Dependencies:** M2 live.

### M4 — Scale 3 → 10 paying · target 2026-07-22

- **Deliverable:** Zero founder-in-loop paths. Public pricing page. Referral hook (inviter + invitee get 1 mo free). Support ≤5 tickets/week hard cap.
- **Success:** 10 paying @ MRR ≥$990 by 2026-07-22; 14-day retention ≥80%; founder support time ≤3 hr/week.
- **Verification:** `stripe customers list --limit 15 | jq '[.data[] | select(.subscriptions.data[0].status=="active")] | length'` ≥10
- **Effort:** human ~10 days / CC ~15 hours
- **Blast radius:** Low on code, high on emotional load (churn hurts when you know every customer).
- **One-way door?** No.
- **Dependencies:** M3 complete.

## Quality gates (every milestone before "done")

| Gate | Command |
|---|---|
| Tests pass (5 consecutive runs from M1+) | `pnpm -w run test` |
| Typecheck clean | `pnpm typecheck` |
| Lint + tokens | `pnpm lint && pnpm check:tokens` |
| Bundle budget ≤1.5 MB gzipped | `pnpm --filter @founderos/ui build && pnpm ci:bundle-size` |
| Time-to-first-agent-run ≤15 min (M2+) | PostHog API query (not dashboard) |
| Agent task completion ≥0.90 over 7d (M3+) | `psql` query named in M3 |
| SAST + secret scan green | `.github/workflows/codeql.yml` + `gitleaks.yml` latest = success |
| `/codex` adversarial on billing/auth/I/O/schema | Mandatory on `server/src/routes/billing*`, `composio-client*`, `auth-session*`, `packages/db/src/migrations/*.sql` |
| File-size gate | CI job `file-size-check` (wired in M1) |
| CONTINUE.md updated | Every merged PR appends an entry |
| PR merged by human | Non-negotiable. Human clicks merge. |

## Process guarantees

| Gate | Trigger | Skill / Command |
|---|---|---|
| Pre-feature | Every ticket | Fresh `/clear` session, Plan Mode, TDD inversion |
| Pre-merge | Every PR | `/review` + CI green + fresh-session read |
| Adversarial | Billing / auth / external I/O / schema | `/codex` challenge mode |
| Post-deploy | Every main merge | `/canary` 15-min monitor (Fly logs + Sentry) |
| Weekly | Friday | `/retro` |
| Bi-weekly | Every 2 weeks | `/plan-ceo-review` on next milestone |
| Quarterly | End of quarter | `/retrospect-project` (next: 2026-07-23) |

## Output standard — what "excellent" means for THIS project

- Every customer-impacting feature ships with a **measurable-in-PostHog** metric named in its PR.
- Every new route / service contributes to `/api/health/deep`, runs <200ms, fails loudly.
- Every schema change ships with a rollback migration tested locally on PGlite.
- Every agent action emits a structured audit-log event with `actor`, `companyId`, `cost_cents`, `outcome`.
- No new file authored >2500 lines. Warning at 1500.
- Every paying customer's first week is instrumented: P50 time-to-first-agent-run, # stuck tasks, # support messages. All ≤ SLO.

## Anticipated drift

- **Workflow sprawl.** Every new gate is easier to add than to merge. Mitigation: quarterly `/retrospect-project` enforces hard cap of 20 workflow files.
- **Large-file recompounding.** `heartbeat.ts` grew 1 line at a time. Mitigation: CI warn at 1500 lines (M1); every PR touching a flagged file must include ≥1 extraction PR.
- **White-glove creep.** Helping the first 3 paying customers feels right. Mitigation: 30-hr/wk constraint is the explicit tiebreaker. Post-M3, zero founder-initiated support.
- **PostHog metric rot.** Dashboards decay silently. Mitigation: milestone verification scripts hit the PostHog API directly (not "check the dashboard"); if the query fails, milestone can't ship.

## Kill criteria

- **M1 not shipped by 2026-05-21** (2× estimate) → estimate off, replan in fresh session.
- **Any PR introduces file >2500 lines** → CI blocks; if override used ≥3× in a calendar month, gate is failing and needs redesign.
- **Weekly founder support time >5 hr for 2 consecutive weeks post-M3** → violating constraint. Freeze features, invest in deflection.
- **First 3 paying customers have <70% 30-day retention** → positioning or core value problem, not polish. Pivot before M4.
- **Composio v3 migration reveals schema-level incompatibility** → halt, consult, do not plow through.

## Calendar

- **Next weekly retro:** 2026-05-01 (Friday)
- **Next bi-weekly plan review:** 2026-05-07 (M1 target)
- **Next full retrospect-project:** 2026-07-23
- **90-day outcome check:** 2026-07-22 — did we hit 10 paying?

## First three tickets

- `docs/tickets/001-composio-v3-client-migration.md` — M1 sub-step 1
- `docs/tickets/002-per-file-db-fixtures.md` — M1 sub-step 2
- `docs/tickets/003-ci-file-size-gate.md` — M1 sub-step 3

## Auto-resume

`CronCreate` scheduled to fire `<<autonomous-loop>>` in a fresh session at a daily cadence. Continuation reads `CONTINUE.md` → picks unblocked ticket → executes to the next one-way door. `CronDelete` to cancel.
