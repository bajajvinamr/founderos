# LONG_RUNNING_PROMPT — FounderOS 7-Day Continuous Run to Client-Ready

_Authored 2026-05-05 by Vinamr's directive: "complete till sprint 6, verify everything is there as promised in the doubtbuddy prd, run e2e testing, ensure 100% completion and ready to give to client to play around without any fear." Amended same day: "ensure no hard halt for all issues that happen record them for my eyes in the morning."_

_Window: **2026-05-05 → 2026-05-12** (7 calendar days). Operates in `/loop` dynamic mode with self-paced `ScheduleWakeup`. Authorized to run autonomously. **The loop never halts on issues** — every issue is logged to `.planning/MORNING-REPORT-<date>.md` for Vinamr to triage at sunrise. The ONLY halts are truly irreversible one-way doors (live Stripe flip, real customer data destruction, DNS transfer, force-push to main, rm-rf on user data) — see "Hard halts" section._

_This file SUPERSEDES `LONG_RUNNING_PROMPT.md` for the next 7 days. The original LRP remains as fallback._

---

## Why this exists (load-bearing context)

Council on **2026-05-05** returned **BLOCK** verdict on the question "is BYO Runner shippable as-is for the $4k buyer?" — see `~/.gstack/projects/bajajvinamr-founderos/decisions.md` → entry `2026-05-05: BYO Runner adversarial retrospective`.

The verdict surfaced **4 P1 findings** that must be closed before ANY further sprint work proceeds. Sprint 4 Wave 2 (S4.2/S4.6/S4.7/S4.9) was just merged onto `feat/trust-closure` but the lifecycle CRM templates **fake delivery** — they invoke a `Log intent only` placeholder then mark `completed`. To the founder UI: workflow succeeded. To the customer's inbox: nothing arrived. **That kills the demo.**

The 7-day run starts by closing the BLOCK, then proceeds through S5 + S6 + PRD verification + E2E gating + client handover.

---

## Day-by-day plan

| Day | Date | Goal | Exit criteria |
|---|---|---|---|
| **1** | 2026-05-05 | **Wave 0 — close 2026-05-05 council BLOCK** | All 4 P1s closed + fresh `/council` on the diff = PASS |
| **2** | 2026-05-06 | S4 Wave 3 + Wave 4 (incl. council on S4.8) | S4.3, S4.4, S4.8 (DEMO TICKET — mandatory council), S4.10 shipped; S4 phase exit criteria met |
| **3** | 2026-05-07 | S5 Finance + scenario modeling | All 10 S5 tickets shipped; revenue cockpit + churn forecast + LTV/CAC + what-if engine verified |
| **4** | 2026-05-08 | S6 first half (Ops, permissions, audit) | S6.1–S6.5 shipped; permissions matrix + agent memory + workflow templates |
| **5** | 2026-05-09 | S6 second half (mobile brief, Slack summaries, polish) | S6.6–S6.10 shipped; bug bash pass 1 |
| **6** | 2026-05-10 | E2E suite + staging smoke + bug bash pass 2 | `e2e/` + `tests/e2e/` + new `client-readiness/*.spec.ts` all green; staging deploy clean |
| **7** | 2026-05-11 | PRD verification + handover docs + final smoke | `.planning/PRD-VERIFICATION.md` written; `CONTINUE.md` has `CLIENT HANDOVER 2026-05-12` section |

Day 7+ (2026-05-12): buffer day. Final review by Vinamr; client handover.

If any day overruns by >50%, agent updates ROADMAP.md with new dates and surfaces overrun reason in CONTINUE.md.

---

## THE PROMPT (paste this in a fresh session, or use as `/loop` argument)

```
You are continuing the FounderOS 7-day autonomous build authorized by Vinamr on 2026-05-05.

Mandate: complete Sprints 4 (finish), 5, 6 + verify against DoubtBuddy PRD + run E2E + make the product client-ready by 2026-05-12. Run continuously in /loop dynamic mode using ScheduleWakeup for self-pacing.

═══════════════════════════════════════════════════
RESUME PROTOCOL — execute every session start
═══════════════════════════════════════════════════

Read these files in order before any other action:

1. /Users/vinamr/Projects/founderos/LONG_RUNNING_PROMPT-7DAY.md
   (this file's "Day-by-day plan" + "Wave 0" sections — figure out current day by date)
2. /Users/vinamr/Projects/founderos/.planning/PROJECT.md
   (north star, MVP promise, key metric)
3. /Users/vinamr/Projects/founderos/.planning/ROADMAP.md
   (sprint table — find the next not_started or in_progress sprint)
4. /Users/vinamr/Projects/founderos/CONTINUE.md
   (most recent state; HALT if a STOP or HALT line is present)
5. /Users/vinamr/.gstack/projects/bajajvinamr-founderos/decisions.md
   (council ledger — read the LATEST 3 entries; 2026-05-05 BLOCK is the active gate)
6. /Users/vinamr/Projects/founderos/CLAUDE.md
   (production gotchas — apply silently)

After loading, run in parallel:
- `git log --oneline -5`
- `git status --short`
- `ls .planning/PHASES/`

Then announce in 4 lines:
- Today's date / day-of-7
- Next milestone (Wave 0, sprint, or PRD verify)
- Whether next item needs /council before merge (yes if touches auth/payment/migration/RBAC/security/agent-autonomy)
- ETA for first commit (in minutes)

═══════════════════════════════════════════════════
WAVE 0 — HARD GATE (must close before any S5/S6 work)
═══════════════════════════════════════════════════

Source: ~/.gstack/projects/bajajvinamr-founderos/decisions.md → 2026-05-05 entry.

Do NOT start any S5 or S6 ticket until ALL FOUR Wave-0 fixes are committed AND a fresh /council on the diff returns PASS.

W0.1 — Wire route handler → executor (P1 from council)
  Problem: server/src/routes/workflows.ts:380 creates a workflow_run row and returns 201.
           services/workflows.ts:328 has executeWorkflowTemplate() but it's only called from tests.
           Founder sees "succeeded" without execution dispatch. Tests pass because they call the
           dispatcher directly — they don't exercise the live route.
  Fix:
    a. After createWorkflowRun() in the POST handler, invoke executeWorkflowTemplate(db, workflow, run)
       wrapped in a fire-and-forget that catches and routes failures to setRunStatus("failed", reason).
       OR enqueue a BullMQ job (preferred — survives crashes and retries cleanly).
    b. Add integration test:
       - POST /companies/:id/workflows/:id/runs
       - Assert the run row exists AND a downstream side-effect is recorded (activity_log entry,
         email-stub fixture call count, OR BullMQ job enqueued — whichever transport is wired)
    c. Re-run all workflow tests; they must still pass without test-only direct dispatcher invocation.

W0.2 — Replace "Log intent only" with real delivery (P1 from council)
  Problem: templates/onboarding-emails.ts:187, activation-nudge.ts:307, upsell.ts:188 are stubs
           that mark status="completed" without sending. Buyer-trust break.
  Fix:
    a. For email actions: integrate Resend (RESEND_API_KEY env var, library @resend/node).
       - Send via resend.emails.send({ from, to, subject, html, text })
       - Persist message_id from response in workflow_run.actions[i].message_id
       - Mark "queued" on send, "completed" only when Resend webhook confirms delivery
       - On send error: mark "failed" with reason, do NOT collapse to completed
    b. For Slack/HubSpot actions: use existing Composio runComposioTool({ userId, toolName, params,
       connectedAccountId }) — connectedAccountId MUST be threaded per CLAUDE.md PR #30 invariant
    c. Add Resend webhook receiver at server/src/routes/webhooks/resend.ts (signature-verified)
       that updates workflow_run.actions[i].status on delivery events
    d. Integration test using a Resend test inbox fixture: assert email body actually arrived
       at the fixture, not just that the row says "completed"

W0.3 — Token TTL + rotation (P1 from council, also #135 backlog)
  Problem: runner_tokens schema has no expires_at. Lost laptop = permanent backdoor.
  Fix:
    a. New migration: packages/db/src/migrations/00XX_runner_tokens_ttl.sql (use next free idx)
       ALTER TABLE runner_tokens
         ADD COLUMN expires_at timestamptz,
         ADD COLUMN rotated_from_token_id uuid references runner_tokens(id),
         ADD COLUMN device_fingerprint text;
       UPDATE runner_tokens SET expires_at = created_at + interval '60 days' WHERE expires_at IS NULL;
       ALTER TABLE runner_tokens ALTER COLUMN expires_at SET NOT NULL;
    b. server/src/middleware/runner-auth.ts: reject when expires_at < now(); error 401 with
       reason="token expired", include hint to call POST /api/companies/:id/runner-tokens/rotate
    c. server/src/routes/runner.ts: token issue endpoint accepts ttl_days (default 60, max 365)
    d. New endpoint POST /api/companies/:id/runner-tokens/:id/rotate — issues new token, sets
       rotated_from_token_id pointer, revokes old after 24h grace period
    e. UI: ui/src/components/RunnerInstallDialog.tsx — show expiration date in token list

W0.4 — Env-var fix in install snippet (P1 from council)
  Problem: RunnerInstallDialog.tsx:208 emits FOUNDEROS_API_URL but config.ts:35 reads
           FOUNDEROS_RUNNER_URL. Anyone following install snippet can't connect.
  Fix:
    a. ui/src/components/RunnerInstallDialog.tsx:208 — change FOUNDEROS_API_URL to FOUNDEROS_RUNNER_URL
    b. docs/runbooks/byo-runner-smoke.md:72 — same change
    c. CONTRACT TEST: ui/src/components/RunnerInstallDialog.test.tsx — add a test that:
       - Renders the dialog
       - Extracts the install-snippet text content
       - Parses the env-var lines
       - Asserts FOUNDEROS_RUNNER_URL is present and FOUNDEROS_API_URL is NOT present
       This is the test that should have caught it the first time.

After all 4 Wave-0 fixes commit:
1. Run `pnpm -w run test` (full server + UI + db packages). On failure: record per Issue
   Recording Protocol, retry up to 3x. If still red after 3 → record HIGH, skip the failing
   suite, continue to step 2.
2. Run /council on the Wave-0 diff (focus: did fixes introduce new regressions?)
3. PASS → proceed to Day 2 (S4 Wave 3+4)
4. PASS WITH CONDITIONS → address conditions inline before Day 2; record MED with what was addressed
5. BLOCK → record HIGH in MORNING-REPORT with the BLOCK reasons, apply the council's
   recommended fix as best-effort wip commit, then proceed to Day 2 anyway. Vinamr reads the
   morning report and decides whether the BLOCK was real or a false positive.

═══════════════════════════════════════════════════
SPRINT 4 FINISH — Day 2 (after Wave 0 PASS)
═══════════════════════════════════════════════════

Read .planning/PHASES/PHASE-S4-content-crm.md. Tickets remaining:
- S4.3 — Content attribution engine
- S4.4 — Content calendar
- S4.8 — Churn rescue + autonomous revenue loop (DEMO TICKET — MANDATORY COUNCIL before dispatch)
- S4.10 — CRM Console UI consolidation

S4.8 is the demo ticket — autonomously emails customers showing churn signal with rescue offers.
This is high-trust autonomy. /council BEFORE writing code. Embed verdict in PR.

If S4.5/S4.6/S4.7/S4.9 fake-delivery is fixed in Wave 0, S4.8 inherits real transport. Don't
re-implement Resend integration — reuse the W0.2 module.

═══════════════════════════════════════════════════
SPRINT 5 — Day 3
═══════════════════════════════════════════════════

Read .planning/PHASES/PHASE-S5-finance.md. All 10 tickets. Council on any ticket touching:
- Stripe webhook handlers (already idempotent per PR #33; don't break it)
- Pricing tier enforcement (don't relax tier checks)
- Revenue forecast math (council on the model assumptions, not the code)

═══════════════════════════════════════════════════
SPRINT 6 — Days 4–5
═══════════════════════════════════════════════════

Read .planning/PHASES/PHASE-S6-ops-polish.md. All 10 tickets. Council on:
- S6 permissions matrix (RBAC change → mandatory)
- S6 audit trail extension (touching activity_log → council)
- S6 mobile brief (Notification permission, push token storage → council)

Plus the residual P2s from 2026-05-05 council should be wrapped into S6:
- /api/health full strip to {ok, version} for unauth (Day 5 latest)
- FOUNDEROS_BILLING_GATE_ENABLED default-on in prod via deploy.sh validation (Day 5)
- BYO runner prompt/skill parity with claude_local (S6.X if not already in roadmap)

═══════════════════════════════════════════════════
E2E PROTOCOL — Day 6
═══════════════════════════════════════════════════

Three suites must run green:

1. e2e/playwright.config.ts (Wave 23A, prod-safe):
   FOUNDEROS_E2E_PROFILE=public-only pnpm --filter e2e test
   Hits founderos.fly.dev preview. Public-only routes. No auth-mutation.

2. tests/e2e/ (boots local server):
   pnpm test:e2e
   Onboarding + signoff flows.

3. NEW — e2e/client-readiness/*.spec.ts (write if missing):

   a. new-founder-onboards-and-runs-first-workflow.spec.ts
      - Sign up via Supabase
      - Email confirm via fixture
      - Onboarding 6-step (PRD-003 acceptance criteria)
      - Connect 2+ Composio integrations (Stripe + PostHog test mode)
      - First agent wakeup
      - Create first lifecycle workflow (onboarding-emails template)
      - Workflow run dispatches, executes, marks completed
      - Resend webhook fixture confirms email delivery (NOT just row marked completed)
      - Activity log shows full lineage with workflow_id

   b. founder-pauses-and-resumes-workflow.spec.ts
      - Workflow active, running
      - Founder PATCH status=paused
      - Trigger event that would normally fire workflow → assert no new run
      - Resume status=active
      - Trigger event again → run fires
      - Audit log records both transitions

   c. billing-gate-blocks-on-cancellation.spec.ts
      - Subscription active in instance_subscription
      - Wakeup endpoint returns 200
      - Stripe webhook customer.subscription.deleted (signed fixture)
      - Wakeup endpoint returns 402
      - Stripe webhook customer.subscription.created (signed fixture, re-subscribe)
      - Wakeup endpoint returns 200

   d. runner-token-expires-and-rotates.spec.ts (validates W0.3)
      - Issue token with ttl_days=1
      - Wait or set system clock forward
      - Authenticated runner request returns 401 with rotation hint
      - POST /rotate issues new token
      - New token authenticates; old token rejected
      - 24h grace: old token still works during grace window

   e. workflow-actually-sends-email.spec.ts (validates W0.1+W0.2)
      - Create workflow with autonomy=4
      - Trigger run
      - Assert HTTP 201 from POST /runs
      - Assert Resend test inbox received email within 30s
      - Assert workflow_run.actions[i].status="completed" ONLY after webhook confirms delivery
      - Assert activity_log has entry with action="workflow_run.completed" and lineage

If any suite is red → fix before proceeding to Day 7. Do NOT skip.

═══════════════════════════════════════════════════
PRD VERIFICATION — Day 7
═══════════════════════════════════════════════════

Read these and produce .planning/PRD-VERIFICATION.md:

A. /Users/vinamr/Projects/founderos/.planning/PROJECT.md "MVP promise":
   "Increase growth execution output by 5–10x and surface the top revenue opportunities
    automatically."

   For each Sprint goal in the table at .planning/PROJECT.md "What ships in 6 weeks", write:
   - Goal: <goal>
   - Sprint: S<N>
   - Status: PASS / FAIL
   - Evidence: <file:line> or <test-name> or <staging URL screenshot>

B. docs/prds/PRD-001-decision-inbox.md
   Extract acceptance criteria. Per criterion: PASS / FAIL with evidence.

C. docs/prds/PRD-002-composio-integration.md
   Same.

D. docs/prds/PRD-003-founder-onboarding-6step.md
   Same.

E. /Users/vinamr/Downloads/FounderOS -DoubtBuddy.md (the buyer contract)
   Read once for completeness check. List any acceptance criterion in the buyer doc that
   is NOT covered by the four PRDs above. Mark each as PASS / FAIL / OUT-OF-SCOPE-PER-MVP.

F. Each .planning/PHASES/PHASE-S<N>-*.md exit criterion:
   PASS / FAIL with file/test evidence.

Final verdict line at the top of PRD-VERIFICATION.md:
- "READY FOR CLIENT" if all PASS
- "NOT READY — N items FAIL, see below" otherwise

If NOT READY: prepend a Day-7-extension plan to CONTINUE.md (one fix per FAIL, prioritized).

═══════════════════════════════════════════════════
"READY FOR CLIENT" DEFINITION (the bar to clear)
═══════════════════════════════════════════════════

The product is ready for the client to play around without fear when ALL of these are true:

[ ] All P1 findings from any council since 2026-05-03 are closed (verify by reading decisions.md)
[ ] All PHASE-S*.md exit criteria are met (per-phase doc, search for "Exit criteria")
[ ] All 3 PRDs in docs/prds/ have evidence-backed verification in PRD-VERIFICATION.md
[ ] All 5 client-readiness E2E specs above are green
[ ] Manual smoke against staging works for the 6-step onboarding (record video → docs/handover/)
[ ] DEMO workspace exists in staging with synthetic data so client can click anywhere
    without breaking real data — seed via scripts/seed-demo-workspace.ts (write if missing)
[ ] /api/health is fully stripped to {ok, version} for unauth callers (P2 from 2026-05-05 council)
[ ] FOUNDEROS_BILLING_GATE_ENABLED is set in prod fly secrets (P2 from 2026-05-05 council)
[ ] CONTINUE.md has top section "CLIENT HANDOVER 2026-05-12" with:
    - Staging URL
    - How to log in (test credentials Vinamr supplies separately)
    - What NOT to touch (live Stripe webhook, real customer data, instance_admin role grants)
    - Who to contact if it breaks (Vinamr's contact)
    - 5 happy-path scenarios to try first
    - Known limitations (out-of-scope items per .planning/PROJECT.md)
[ ] All commits since 2026-05-05 are pushed to remote feat/trust-closure (or main if rebased)
[ ] Final /council verdict on the merged-to-main diff is PASS or PASS-WITH-CONDITIONS-RESOLVED

═══════════════════════════════════════════════════
PACING — autonomous-loop-dynamic mode
═══════════════════════════════════════════════════

After each commit, schedule next wake via ScheduleWakeup with the SAME prompt:
"<<autonomous-loop-dynamic>>"

Picking delaySeconds (per Anthropic prompt-cache 5min TTL):
- Active iteration (test running, code changes pending, deploy in progress): 60–270s
- Mid-ticket, between commits: 270s (stays in cache)
- Between tickets within a sprint: 1200s (one cache miss buys the next 20min)
- Between sprints: 1800s (longer pause OK, sprints are larger contexts)
- Council fired, waiting on result: 270s (don't burn cache 10x for 1 council)
- Long-running test suite or deploy: 270s
- Idle / nothing to check imminently: 1800s

Don't pick 300s — worst-of-both. Pick 270 or 1200+, never 300.

End every wake with one ScheduleWakeup call OR omit to end the loop. Don't double-schedule.

═══════════════════════════════════════════════════
ISSUE RECORDING PROTOCOL — never halt, log everything for morning review
═══════════════════════════════════════════════════

Vinamr's directive 2026-05-05: "ensure no hard halt for all issues that happen record them
for my eyes in the morning." The loop keeps moving. Every issue is recorded.

Issue log: .planning/MORNING-REPORT-<YYYY-MM-DD>.md — one file per calendar day (UTC).
At session start, ALWAYS open or create today's MORNING-REPORT-<date>.md and append.

Issue record format (one per issue):
```
### [<HH:MM:SS UTC>] [<SEVERITY>] [<TICKET-ID or AREA>] <one-line headline>

**What happened:** <2-3 sentences>
**What I tried:** <2-3 sentences — the attempts and why they failed>
**Workaround applied:** <what I did to keep moving — specific commit SHA if any>
**Status:** <SKIPPED / DEFERRED / WORKED-AROUND / BLOCKED-NEEDS-DECISION>
**Files touched:** <list, or "none">
**Next-action recommendation for Vinamr:** <one line>
```

Severities:
- **CRIT** — buyer-facing demo break, security exposure, data corruption risk. Surface near top.
- **HIGH** — blocked ticket, council BLOCK, repeated test failure. Workaround applied; needs human
- **MED**  — a flaky test, a rate-limit retry that worked, a deferred polish item
- **LOW**  — informational, no action needed

When to record (and keep going, NEVER halt):
1. Test failure retried 3 times unchanged → record HIGH, skip ticket, move on
2. LLM capacity error (Gemini 429, Codex exit-55, Claude 529) on same call 3x → record MED,
   fall back through model chain (use next-tier or balanced model); if entire chain fails, record
   HIGH and skip the council step
3. /council BLOCK verdict → record HIGH, apply the council's recommended fix as best-effort,
   commit it under "wip(council-fix): <topic>", continue. Do NOT halt for re-council on small fixes
4. /council PASS-WITH-CONDITIONS → address conditions inline, record MED with what was addressed
5. Missing dependency at install time → try the next-tier solution (npm, pnpm, brew) → if all
   fail, record HIGH and skip the dependent ticket
6. Migration generates schema collision → write hand-rolled SQL + journal entry per
   vinamr-invariants Drizzle pattern, record MED
7. CONTINUE.md or PROJECT.md says something contradicting today's plan → trust the latest one,
   record MED, surface the contradiction
8. A required env var (RESEND_API_KEY, COMPOSIO_AUTH_CONFIG_*) is missing in dev → use a
   well-named stub/mock for local tests, record HIGH for prod gap, defer to morning
9. Decision not in decisions.md or ROADMAP.md → take the SAFEST available default
   (least-privileged, additive, reversible) and record HIGH with the alternatives considered
10. Anything else that would have halted → record at appropriate severity and continue

═══════════════════════════════════════════════════
HARD HALTS — only TRULY irreversible one-way doors halt the loop
═══════════════════════════════════════════════════

These are the ONLY conditions that stop the agent. Everything else → MORNING-REPORT + continue.

- Live Stripe key flip from test to production mode (one-way door, real money debited from
  real accounts; unrecoverable)
- Real customer data migration that would destructively alter or delete production rows for
  a paying design partner (data loss is unrecoverable)
- DNS / domain ownership transfer for any customer-facing domain (recoverable only via the
  registrar with delays measured in hours)
- Vinamr writes "STOP" or "HALT" anywhere in CONTINUE.md (check at every wake — the override
  is sacred)
- Force-push to main (never; even with permission)
- `rm -rf` on a path containing user data, secrets, or git history (never; even with permission)

If any of the above is about to happen → write a CRIT entry to MORNING-REPORT, ScheduleWakeup
in 3600s, and end this wake. Do NOT execute the irreversible action.

═══════════════════════════════════════════════════
CROSS-CUTTING DEFAULTS — apply silently, never halt
═══════════════════════════════════════════════════

(Same as LONG_RUNNING_PROMPT.md — workflow runtime BullMQ, event ingestion webhook→queue→table,
PostHog hosted only, Tier 1 pricing only, 14-day trial, pgvector for vectors, Recharts for
charts, etc. Don't re-decide.)

═══════════════════════════════════════════════════
WORKING STYLE — apply every wake
═══════════════════════════════════════════════════

- Direct, dense communication. No filler.
- Atomic commits per ticket. Conventional Commits.
- Tests alongside code. Integration tests for any route handler change.
- Parallel tool calls when independent (git status + diff + log together).
- Verify, don't claim. After each commit: typecheck + targeted tests + visual verification
  if UI change.
- Reference file:line when pointing at code.
- Subagent output is a SUMMARY, not the diff. Read actual files before trusting subagent reports.
- After each sprint completes: invoke /vanta-sync (don't wait to be asked). The user expects this.
- Before any major refactor or arch change: invoke /council.

═══════════════════════════════════════════════════
PROGRESS REPORTING
═══════════════════════════════════════════════════

After each ticket commits, append a line to .planning/PROGRESS-2026-05-XX.md (date of THIS day):
- timestamp (ISO)
- ticket-id (S<N>.<M>)
- commit SHA
- one-line summary
- next ticket / wake delay

After each day rolls over (00:00 UTC):
- Close yesterday's PROGRESS file
- Open today's
- Update CONTINUE.md "today" pointer

After the 7-day window completes:
- Run /vanta-sync (the daily cap; one mention is enough)
- Open PRD-VERIFICATION.md, write verdict
- Append CLIENT HANDOVER section to CONTINUE.md
- ScheduleWakeup ONCE more in 3600s with delay reason "Final review window for Vinamr"
- Then end the loop

═══════════════════════════════════════════════════
BEGIN NOW
═══════════════════════════════════════════════════

Run the resume protocol (read 6 files + git status). Then:

If today is 2026-05-05 and Wave 0 has not started:
- Begin W0.1 (route → executor wiring). It's the riskiest fix; do it first.
- ScheduleWakeup 270s after first commit lands.

If Wave 0 is in progress:
- Pick up the next W0.X.
- ScheduleWakeup 270s after each.

If Wave 0 is done and council on Wave 0 has passed:
- Move to the day-by-day plan based on today's date.

If today is past 2026-05-12 and not yet ready:
- Write a comprehensive MORNING-REPORT-2026-05-12.md summary of what slipped and why
- Compile a "DAY-8 EXTENSION PLAN" at the top with prioritized fixes
- Continue working through the queue (no halt — Vinamr's directive is "no hard halts")
- ScheduleWakeup 3600s to give Vinamr a window to course-correct before further work
```

---

## Notes for Vinamr (operator-facing — outside THE PROMPT)

### To start the 7-day run

In a fresh Claude Code session (`/clear` if you want a clean context), at `~/Projects/founderos`:

```
/loop please follow the instructions in LONG_RUNNING_PROMPT-7DAY.md
```

The agent reads this file's THE PROMPT section, executes the resume protocol, picks up Wave 0, and self-paces via `ScheduleWakeup`.

### To check progress

- `cat .planning/PROGRESS-2026-05-$(date +%d).md` — today's commit log
- `cat CONTINUE.md` — the operator-facing state. Top section is always current.
- `git log --oneline --since="1 day ago"` — quick activity check
- `cat ~/.gstack/projects/bajajvinamr-founderos/decisions.md | head -50` — most recent council decisions

### To stop or pause

- Type `stop` or `pause` in the session — the loop halts after current commit.
- Or write `HALT: <reason>` at the top of `CONTINUE.md` — the agent reads this every wake and halts on next check.

### To override a default

- Append the override to `.planning/ROADMAP.md` "Cross-cutting decisions" section with date stamp.
- Or write a new `decisions.md` entry with `Supersedes:` pointing at the prior decision.

### What the agent will NOT do (hard halts — only irreversible one-way doors)

- Flip live Stripe keys to production mode
- Destructively migrate real customer data
- Transfer DNS / domain ownership
- Force-push to main
- `rm -rf` on user data, secrets, or git history

### What the agent will DO (everything else, with logging)

Every issue not on the halt list above goes into `.planning/MORNING-REPORT-<date>.md`:
- Test failure 3x → log HIGH, skip ticket, move on
- Council BLOCK → log HIGH, apply best-effort fix, continue
- LLM capacity error → log MED, fall back through model chain, skip if all fail
- Missing decision → take safest default (least-privileged, additive, reversible), log HIGH
- Missing dependency → try alternates, skip dependent ticket if none work
- Migration collision → hand-roll SQL per vinamr-invariants Drizzle pattern, log MED

### What you should expect when you wake up

- One MORNING-REPORT-<date>.md file per day in `.planning/` (7 total)
- CRIT entries near the top of each (read these first)
- A trail of commits with conventional-commit messages
- An updated CONTINUE.md with current state
- Possibly a `wip(council-fix): <topic>` commit or two from auto-applied BLOCK recommendations
- ScheduleWakeup chain still active (the loop is alive unless you say STOP)

### Estimated cost

- Average of ~5 commits/day × 7 days = ~35 commits over the window
- Each /council call: ~$0.50-2.00 in Codex+Gemini API charges (PARTIAL mode is half)
- Expect 5-8 councils across the 7 days (Wave 0 + S4.8 + each schema migration + each new auth/billing change + final pre-handover)
- Anthropic API for the agent itself: variable; the user has visibility on Claude session billing

### What "ready for client" looks like at 2026-05-12

Open the staging URL → log in with credentials → see a populated dashboard with synthetic data → click around 5 happy-path scenarios → no errors, no broken links, no fake data shown as real, no permission errors, no console warnings beyond expected → feel confident the client can play around safely.

If that's not true on 2026-05-12: agent halts the day before, writes a clear delta in CONTINUE.md, asks Vinamr to extend the window or cut scope.

---

## Why this is different from the original LRP

| Aspect | Original LRP | 7-Day LRP |
|---|---|---|
| Scope | "Through end of Sprint 6" (open-ended) | 7-day window with daily milestones |
| Pacing | Manual paste each session | `/loop` dynamic with `ScheduleWakeup` |
| Wave 0 | Not present | Hard gate before any sprint work — closes 2026-05-05 BLOCK |
| PRD verification | Implicit | Explicit Day-7 protocol with `PRD-VERIFICATION.md` deliverable |
| E2E | "Tests before merge" | 5 named client-readiness specs as Day-6 gate |
| Client-ready bar | Not explicitly defined | 11-checkbox checklist ("ready for client to play around without fear") |
| Hard halts | 4 items | 5 truly irreversible items only (live Stripe, real data, DNS, force-push, rm-rf); everything else → MORNING-REPORT and continue |
| Cost ceiling | None | Implicit via halts; Vinamr can stop anytime |

The original LRP remains as fallback if the 7-day mandate is canceled or extended.
