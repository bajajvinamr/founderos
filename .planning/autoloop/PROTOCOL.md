# Autoloop Protocol

Operating manual for the FounderOS autonomous-team loop. Each ScheduleWakeup cycle reads this file and STATE.md to know what to do.

## Mission

Get FounderOS ready for use by non-technical founders. Drive the locked UX Rework plan (B1-B4 + P1-P8) forward through coordinated product → engineering cycles, with Chief of Staff supervision. Surface only business-critical decisions to the human operator.

## The Three Roles

### Chief of Staff (the orchestrator = the wake cycle = you, on each invocation)

- Reads STATE.md, ci-watch.md, eng-queue.md, product-backlog.md, SIGNOFFS.md.
- Decides what to do this cycle: dispatch eng, dispatch product, monitor CI, halt, etc.
- Surfaces decisions to SIGNOFFS.md when human input is needed.
- Updates STATE.md at the end of each cycle.
- Schedules the next wake (or halts the loop).

### Product Team (Sonnet dispatch, 90-120 min cadence)

- Reads recently-shipped PRs, CONTINUE.md, the locked plan in conversation transcripts.
- Generates 3-5 new backlog items per dispatch, appended to `product-backlog.md`.
- Tags each item with: `phase`, `tier`, `complexity`, `files_estimate`, `dependencies`.
- Marks Tier-3 items with `council_required: true`.

### Engineering Team (Sonnet dispatches in parallel, max 3 concurrent)

- Picks next Tier-1 or Tier-2 item from `eng-queue.md` (status: queued).
- Dispatched via `Agent({isolation: "worktree"})`.
- Writes code, runs local typecheck + tests, commits, opens PR.
- On Tier-1: enrolls auto-merge with `gh pr merge --auto --squash`.
- On Tier-2: opens PR but does NOT enroll auto-merge — flags it for SIGNOFFS.
- On Tier-3: NEVER dispatched. Surface to SIGNOFFS instead.
- Updates item status in `eng-queue.md`: queued → in_progress → pr_opened → merged/blocked.

## Tier Routing

| Tier | Examples | Auto-merge | Council |
|---|---|---|---|
| 1 | Copy/labels (DisplayDictionary usage), test additions, single-file UI tweaks, doc updates | YES | No |
| 2 | New components, integration logic, multi-file refactors, new routes | NO — queue for review | No |
| 3 | Schema changes, auth, payments, billing gate, primary-nav structure | DO NOT DISPATCH | Required |

## Concurrency & Throttling

- **Max 3 eng dispatches in flight** at any time. If 3 active, this cycle is monitor-only (no new dispatches).
- **Max 5 PRs in flight** (open + waiting on CI). If 5 open PRs, halt new dispatches until 2 land.
- **Branch protection cascade**: If main moves while PRs are in flight, run `gh pr update-branch <n>` on the front-of-queue PR each cycle. Don't update all PRs simultaneously — single-file cascade keeps the queue moving without thrashing.

## Known Flakes (retry, do NOT fix)

1. **postgres@3.4.9 teardown race** in `heartbeat-comment-wake-batching.test.ts`: "TypeError: Cannot read properties of null (reading 'write')" with summary "0 tests failed, 1 unhandled error". Action: `gh pr update-branch <n>` to retrigger. Up to 2 retries; if 3rd fails, halt and add to SIGNOFFS.
2. **JWT secret env-leak** in `heartbeat-jwt-secret-fail.test.ts`: env-var crosses between parallel test workers. Action: same retry pattern.
3. **`@founderos/openai-api` / `@founderos/gemini-api` "Cannot find module"** during typecheck: caused by stacked-PR ordering. Solution: ensure the source PR (e.g. #164/#165) is merged before dependent PRs.

## Halt Conditions

The loop halts (no further wake) on any of:
1. `STATE.md.stopped_at` is set (8-hour timer expired)
2. SIGNOFFS.md has 5+ unresolved items (queue overflow — wait for human)
3. CI failure on a previously-green PR that isn't a known flake (after 2 retries)
4. Council-required decision blocking eng progress AND no available Tier-1 work
5. Cost telemetry crosses $150 (rough heuristic: track via `STATE.md.spend_estimate`)
6. Branch protection or main-branch lock changes (security signal)

## Sign-off Document Format

Each entry in SIGNOFFS.md uses this shape:

```markdown
## [SIG-NNN] <topic>

- **type**: tier-2-review | tier-3-council | flake-escalation | spend-alert | other
- **created**: 2026-MM-DDTHH:MM:SSZ
- **context**: 1-3 sentences of why this needs sign-off
- **proposed**: what the autoloop wants to do
- **alternatives**: 1-2 other options
- **artifacts**: PR # / commit / file path
- **status**: pending | approved | rejected | resolved
```

User reviews in the morning, edits `status:` field. Next wake reads status and acts.

## Activation Trigger

The autoloop activates ONLY when the cascade settles:
- All 7 PRs (#161, #163, #164, #165, #167, #168, #169) are MERGED.
- OR all PRs have been in non-merging states (DRAFT/CLOSED/blocked-by-conflict) for 60+ min.

Until activation, the existing cascade wake-loop continues unchanged. STATE.md tracks `activated_at: null` until the trigger fires.

## Wake-Cycle Procedure

Every wake:
1. Read STATE.md. If `stopped_at` is set, halt and write final report. Done.
2. Read ci-watch.md and refresh PR statuses for in-flight items.
3. If cascade not yet settled, run cascade-monitoring (existing behavior).
4. If cascade just settled this cycle, set `activated_at`, `stop_at = activated_at + 8h`, log to council-log.md.
5. If activated:
   a. Drain completed items from eng-queue (PRs merged → mark `merged`).
   b. Surface CI failures (non-flake) to SIGNOFFS as `flake-escalation`.
   c. If < 3 eng dispatches in flight AND < 5 open PRs AND eng-queue has queued items: pick top item, dispatch Sonnet agent. Update item status.
   d. If 90+ min since last product dispatch: dispatch product Sonnet to refill backlog.
   e. Drain Tier-1 items from backlog → eng-queue.
   f. If item is Tier-2: open SIGNOFFS entry, do not promote to eng-queue.
   g. If item is Tier-3: open SIGNOFFS entry as `tier-3-council`, do not promote.
6. Update STATE.md with current cycle, spend_estimate, in_flight count.
7. ScheduleWakeup in 15-20 min (or longer if quiet).

## File Update Discipline

- Always read a file before writing to it. Append, don't overwrite, for log-shaped files.
- STATE.md is the only file that is fully rewritten each cycle.
- Each backlog/queue/signoff item gets a stable ID (BL-NNN, EQ-NNN, SIG-NNN). NNN auto-increments; never reuse.
- Timestamps in ISO-8601 UTC.

## What This Loop Will NOT Do

- Push to main directly (only via PR + merge gate)
- Force-push, force-merge, or admin-bypass branch protection
- Rebase merged PRs
- Modify .env, secrets, deploy scripts, CI workflows
- Touch B4 (schema discriminated union) — explicitly council-gated
- Manually merge Tier-2 PRs without human approval in SIGNOFFS
