# Autoloop Protocol (v2 — post-council)

Operating manual for the FounderOS autonomous-team loop. Each ScheduleWakeup cycle reads this file and STATE.md to know what to do.

**Revision history**:
- v1 (2026-05-11T00:00:00Z) — initial draft, flagged by Shadow Council hook
- v2 (2026-05-11T00:30:00Z) — incorporates all P0 + P1 findings from `COUNCIL.md` (Gemini 2.5 Pro + GPT-5.4 adversarial review)

## Mission

Get FounderOS ready for use by non-technical founders. Drive the locked UX Rework plan (B1-B4 + P1-P8) forward through coordinated product → engineering cycles, with Chief of Staff supervision. Surface only business-critical decisions to the human operator. **The locked plan is the mission anchor — work outside it requires explicit user approval via SIGNOFFS `scope-expansion` entries.**

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
- Tags each item with: `phase`, `tier` (declared), `complexity`, `files_estimate`, `dependencies`, **`parent_plan_id`** (mandatory — see Mission Anchor below).
- Tier declared by product is a HINT only — actual tier is computed from diff at dispatch + auto-merge time (see Tier Routing).
- Marks Tier-3 items with `council_required: true`.

### Engineering Team (Sonnet dispatches in parallel, max 2 concurrent — REVISED post-council)

- Picks next eligible item from `eng-queue.md` (status: `queued` for Tier-1, `approved-for-dispatch` for Tier-2).
- Dispatched via `Agent({isolation: "worktree"})`.
- Writes code, runs local typecheck + tests, commits, opens PR.
- **Before opening PR**: runs `git diff --name-only main...HEAD` and validates against Tier-3 path patterns. If ANY file matches a Tier-3 pattern, abort dispatch, write SIGNOFFS as `tier-misclassification`. Eng exits with a note in council-log.
- **On Tier-1** (post-diff-validation): enrolls auto-merge with `gh pr merge --auto --squash`.
- **On Tier-2** (post-diff-validation): opens PR but does NOT enroll auto-merge — SIGNOFFS entry already exists from chief-of-staff pre-dispatch.
- **On Tier-3** (post-diff-validation): never reaches here; if it does, that's a tier-misclassification halt.
- Updates item status in `eng-queue.md`: `queued → dispatched → in_progress → pr_opened → merged/blocked`.

## Tier Routing (REVISED post-council — P0-1 + P0-2)

**A tier is a property of the diff, not a product-team prediction.** Each item has a *declared tier* (product's guess) and an *actual tier* (computed from path patterns at dispatch + auto-merge). The actual tier always wins. Auto-merge is gated on actual-tier == declared-tier == 1.

### Path-based tier rules (authoritative)

If a PR's diff (via `gh pr diff <n> --name-only`) touches ANY of these paths, the actual tier is **Tier 3** regardless of declared tier:

- `**/*.sql`, `**/migrations/**`, `packages/db/schema/**`, `packages/db/src/check-migration-numbering.ts` — schema
- `**/auth/**`, `**/middleware/auth*.ts`, `**/middleware/billing*.ts`, `**/post-signup-hook.ts` — auth/billing
- `**/stripe/**`, `**/billing/**`, `**/subscriptions/**`, `**/instance_subscription*` — payments
- `packages/shared/src/types/**`, `packages/shared/src/api-*.ts`, `packages/shared/src/constants.ts` — cross-service contracts
- `ui/src/components/Sidebar.tsx`, `ui/src/components/MobileBottomNav.tsx`, `ui/src/App.tsx`, `ui/src/lib/company-routes.ts` — primary nav structure
- `tsconfig*.json`, `vite.config.ts`, `pnpm-lock.yaml`, root `package.json`, workspace-package `package.json` — build/dependency config
- `.github/workflows/**`, `_headers`, `vercel.json`, `fly.toml`, `Dockerfile*`, `docker-compose*.yml` — infrastructure
- `.env*`, `*.key`, `*.pem`, `secrets/**`, `keys/**` — credentials (explicit forbid; never even Tier-3)
- `packages/runner/**`, `packages/adapters/**` (existing-file edits) — runtime contracts

If a PR's diff touches (and does NOT touch any Tier-3 path):
- `server/src/routes/**`, `server/src/services/**` (modifying existing files) — **Tier 2**
- `ui/src/pages/**` (new pages), new top-level components in `ui/src/components/**` — **Tier 2**
- New server-side services, new database queries (not schema), new background tasks — **Tier 2**

Everything else that is NOT Tier-2 and NOT Tier-3 — **Tier 1**:
- Copy/label edits via DisplayDictionary
- Test additions / new test files
- Documentation
- Small visual tweaks to existing components (text, styling-only props)
- New unit-test helpers in `__tests__/` or `**/test-utils/**`

### Flow per tier

| Tier | Pre-dispatch | Dispatch | PR-open | Auto-merge |
|---|---|---|---|---|
| **1** | Product declares + chief-of-staff promotes to eng-queue (status=queued) | Eng dispatched | Diff re-validated; if hits Tier-3 pattern, halt + SIGNOFFS as `tier-misclassification` | YES — but only if final diff stays Tier-1 |
| **2** | Product declares; chief-of-staff writes SIGNOFFS entry `tier-2-review`; **does NOT promote to eng-queue**. Eng waits for user `status: approved`. | Once approved, chief-of-staff promotes to eng-queue (status=approved-for-dispatch); eng dispatched | Same diff re-validation as Tier-1 | NO — opens PR, separate SIGNOFFS entry for land-time review |
| **3** | Product declares OR diff-detector forces. Chief-of-staff writes SIGNOFFS as `tier-3-council`. **Never reaches eng-queue or eng dispatch.** | — | — | — |

### Diff-validator implementation

The chief-of-staff cycle invokes a tier-validator function before each Tier-1 auto-merge:

```bash
# Pseudo-procedure run before `gh pr merge --auto --squash`:
DIFF=$(gh pr diff <n> --name-only)
# Match against patterns:
echo "$DIFF" | grep -E '\.sql$|migrations/|packages/db/schema/|/auth/|middleware/(auth|billing)|/stripe/|/billing/|packages/shared/src/types/|Sidebar\.tsx|MobileBottomNav\.tsx|tsconfig|vite\.config|pnpm-lock|^package\.json|^\.github/workflows/|_headers|vercel\.json|fly\.toml|Dockerfile|^\.env|\.key$|\.pem$|secrets/|keys/' && {
  # Hit — escalate to tier-3-council, do NOT auto-merge
}
```

This runs *every cycle* against in-flight Tier-1 PRs, not just at PR open. Late commits to the branch could introduce Tier-3 paths.

## Parent Plan Binding (Mission Anchor — REVISED post-council, P0-3)

Every backlog item MUST cite `parent_plan_id` from the locked FounderOS UX Rework plan:

- `B1` — unblock multi-provider tiles (DONE per cascade)
- `B2` — server bootstrap honors chosen adapter
- `B3` — Composio promote primary CTA (DONE per cascade)
- `B4` — provider key discriminated-union schema (council-gated, never auto-dispatched)
- `P1` — Display Dictionary infrastructure (DONE per cascade)
- `P2` through `P8` — phases per locked plan
- `scope-expansion-<topic>` — requires explicit user approval via SIGNOFFS `scope-expansion` entry BEFORE product team is allowed to add

Items lacking `parent_plan_id` are rejected at intake:
- Product agent's offending output is logged to `council-log.md` as `intake-rejected`.
- Eng-queue is NOT promoted.
- 2+ such items in one product-dispatch triggers a `mission-drift` halt (see below).

Acceptance criteria for each item must include:
- `why_now`: 1-sentence justification why this is in scope of the active phase
- `done_criteria`: 1-3 bullet points describing what "merged and done" means in user-visible terms

### Mission-drift halts

Loop halts on any of these signals:
1. Product team output contains 2+ items lacking `parent_plan_id` (suggests product agent went off-piste)
2. Engineering has merged 5+ PRs in the same top-level directory (e.g. `server/src/routes/`) without progressing the plan's active `parent_plan_id` set
3. Engineering merged 3+ PRs whose `parent_plan_id` is outside the active phase set (e.g. 3 P5-tagged PRs while plan says active phase is P2)
4. Chief-of-staff has dispatched 3+ `scope-expansion` items without user approval recorded in SIGNOFFS
5. Same subsystem touched by 3+ in-flight PRs (likely cross-PR conflict risk)

## Concurrency & Throttling (REVISED post-council — P1-1)

- **Max 2 eng dispatches in flight** at any time (was 3). If 2 active, this cycle is monitor-only.
- **Max 2 open PRs in flight** (open + waiting on CI; was 5). If 2 open PRs, halt new dispatches until 1 lands.
- **Parallel branch refresh, NOT single-file cascade** (REVERSED from v1): when main moves, run `gh pr update-branch <n>` concurrently for all BEHIND PRs each cycle. Council's CI-cost analysis showed single-file serializes 2-3h of churn per main-move; the parallel-rebase thrash cost is smaller in absolute terms on a 2-PR queue.
- **Disk + worktree budget**:
  - Max 5 active worktrees at any time
  - Stale worktrees (last access > 6h, no agent in flight) cleaned via `git worktree prune` each cycle
  - Halt at < 5GB disk free
- **Dispatch-level retries** (NEW per P2-3): if `pnpm install` fails with network-class error (ETIMEDOUT/ECONNRESET/fetch failed), retry up to 2x with backoff (30s, 120s). Distinct from CI-flake retry — this is the setup phase before any CI runs.

## Flake Taxonomy (REVISED post-council — P1-2)

Replaces the v1 flat list. Each row: symptom class, owning subsystem, detection heuristic, retry policy, expiry.

| Class | Subsystem | Heuristic | Retry | Expiry |
|---|---|---|---|---|
| postgres-teardown null-write | server tests | "Cannot read properties of null (reading 'write')" in `node_modules/postgres/src/connection.js:255` + summary "N tests passed, 1 unhandled error" + originated in heartbeat-comment-wake-batching.test.ts | up to 2 retries via update-branch | 2026-08-01 |
| jwt-env-leak | server tests | heartbeat-jwt-secret-fail.test.ts asserts FOUNDEROS_AGENT_JWT_SECRET unset but env-var leaked from parallel worker | up to 2 retries | 2026-08-01 |
| stacked-PR module-not-found | typecheck | "Cannot find module '@founderos/*'" caused by PR depending on unmerged sibling | NOT a retry — wait + update-branch after dep lands | always (structural) |
| embedded-pg port drift | server tests | "address already in use" on ports 5432-5499; `startEmbeddedPostgresTestDatabase` collision | up to 1 retry | 2026-08-01 |
| fixed-port collision | E2E/integration | port 3199/3232/3000 EADDRINUSE | up to 1 retry, then halt with `port-collision` SIGNOFFS | 2026-08-01 |
| pnpm install registry flake | setup | "fetch failed" / "ETIMEDOUT" / "ECONNRESET" during `pnpm install` | up to 2 retries with backoff (30s, 120s) | always |
| OOM during typecheck | build | "FATAL ERROR: Reached heap limit" + process Killed in tsc | up to 1 retry with `NODE_OPTIONS=--max-old-space-size=8192`, then halt | 2026-08-01 |
| child-process orphan | post-test cleanup | "Terminate orphan process" appears in log but exit code 0 | NONE — false signal, ignore as success | always |
| workspace-runtime parallel race | server tests | workspace-runtime.test.ts intermittent failure under parallel load (documented in `docs/CI-KNOWN-FLAKES.md` v1) | up to 2 retries | 2026-08-01 |
| linked-worktree symlink drift | worktree dispatch | Agent worktree references stale package-link in `node_modules/.pnpm/` after a sibling PR updated the workspace | recreate worktree + retry once, then halt | always |
| vitest cross-worker module-cache race | server/UI tests | Rapid-fire identical TypeError (e.g. `db.select is not a function`) across many tests at UNCHANGED code paths; PR adds a new test file with partial `vi.mock` or singleton import-time effects; identical-base sibling PRs PASS the same job | up to 1 retry via `gh run rerun --failed`; if rerun also fails, dispatch isolation-fix (likely `vi.resetModules()` in beforeEach or convert partial mocks to pure DI) | 2026-08-01 |

**Unknown flake**: halt fast. Do not retry blindly. Write SIGNOFFS as `flake-unknown` with the failing job URL + first 50 lines of error output + a `next_step: identify_symptom_class` field.

**Branch HEAD leak (new invariant class, REFINED cycle 18)**: Agent({isolation: "worktree"}) dispatches can flip the parent checkout's HEAD to the agent's intended branch. Two distinct mechanisms now confirmed:
  - **Mechanism A** (cycles 16.2, 16.5, 18-staging): worktree harness creates the named branch in the parent ref-store and the parent's HEAD follows, while the worktree itself gets auto-renamed to `worktree-agent-<id>`. Agent's worktree branch is correct; parent's branch silently flips.
  - **Mechanism B** (cycle 18, EQ-013): dispatched agent runs `cd /Users/vinamr/Projects/founderos && <bash>` for every command, putting workdir IN the parent checkout. All `git checkout -b`, `git add`, `git commit` operations land on the parent, not the isolated worktree. The agent's `.claude/worktrees/agent-<id>/` worktree stays pristine; the parent branches and commits as if the agent had checked out locally.
  Detection: `git branch --show-current` returns something other than the autoloop-scaffold branch when the autoloop runner expects to be on it. Defense:
  1. Every Edit/Write to .planning/autoloop/* MUST be preceded by `git branch --show-current` check (autoloop side).
  2. Every dispatched agent's brief MUST explicitly forbid `cd /Users/vinamr/Projects/founderos && ...` patterns and require the agent work from its worktree's pwd (agent side).
  Recovery: `git stash push --include-untracked -m "..." -- <files>` → `git checkout chore/autoloop-scaffold` → `git stash pop`. Observed 4 times across cycles 16.2, 16.5, 18-staging, 18-EQ-013-return — class is recurring AND has multiple root-cause mechanisms, not one-time and not single-cause. (Not technically a flake; it's an agent-harness leak. Documented here because the defensive primitive belongs in the same retry/recovery taxonomy.)

## Halt Conditions (REVISED post-council — augments v1)

Loop halts (no further wake) on any of:
1. `STATE.md.stopped_at` is set (8-hour timer expired)
2. SIGNOFFS.md has 5+ unresolved P0/P1 items (queue overflow — wait for human)
3. CI failure on a previously-green PR that is NOT a known flake (after taxonomy lookup)
4. Council-required decision blocking eng progress AND no available Tier-1 work
5. Cost telemetry crosses $150 (rough heuristic; track via `STATE.md.spend_estimate`)
6. Branch protection or main-branch lock changes (security signal)
7. **Mission drift** — any of the 5 mission-drift signals above
8. **Tier misclassification** — diff-validator detected Tier-3 in declared Tier-1 or Tier-2 work
9. **Resource exhaustion** — disk < 5GB free OR > 5 active worktrees
10. **Stuck setup retry** — pnpm install failed 2 retries in a row across 2+ separate dispatches

## Sign-off Document Format (REVISED post-council — P1-3)

`SIGNOFFS.md` maintains a **summary table at the top, sorted by urgency (P0 → P1 → P2)**:

```markdown
| ID | Priority | Type | Source | Blocking | Expires | Recommended |
|---|---|---|---|---|---|---|
| SIG-007 | P0 | tier-3-council | BL-006 (B4 schema) | autoloop activation | 2026-05-12T00:00 | Council before approving |
| SIG-005 | P1 | tier-2-review | BL-008 (P3.b CommanderBar) | none | 2026-05-15T00:00 | Review diff; approve if scope-clean |
```

Each individual entry uses this enriched schema:

```markdown
## [SIG-NNN] <topic>

- **type**: tier-2-review | tier-3-council | flake-escalation | spend-alert | mission-drift | tier-misclassification | scope-expansion | flake-unknown | port-collision | other
- **priority**: P0 (block activation) | P1 (block progress) | P2 (informational)
- **decision_required**: approve | reject | resolve | defer | escalate
- **blocking**: <what halts until resolved>
- **blast_radius**: <files affected, services, runtime impact, user-visible surfaces>
- **ci_state**: green | red | n/a
- **merge_state**: MERGEABLE | BLOCKED | BEHIND | n/a
- **source**: <BL-NNN, EQ-NNN, PR #N, or autoloop-cycle-N>
- **recommended_action**: <1 sentence of what the autoloop suggests>
- **expires_at**: <iso ts — after this, autoloop escalates or defers>
- **context**: 1-3 sentences of why this needs sign-off
- **proposed**: what the autoloop wants to do
- **alternatives**: 1-2 other options
- **artifacts**: <PR #, commit, file paths>
- **status**: pending | approved | rejected | resolved | deferred
- **resolved_at**: null
- **resolution_note**: null
```

If `expires_at` passes with `status: pending`:
- P0 items: escalate via additional SIGNOFFS entry + halt the loop
- P1 items: downgrade to `deferred` with note in council-log
- P2 items: archive to `council-log.md` and remove from SIGNOFFS

## Activation Trigger (REVISED post-council — P2-1)

The autoloop activates ONLY when ALL of these hold:
1. All 7 cascade PRs (#161, #163, #164, #165, #167, #168, #169) are MERGED. **Not "60-min non-merging fallback"** — that was P2 from Codex; activating over a stuck stack is unsafe.
2. `COUNCIL.md` exists in `.planning/autoloop/` with no unresolved P0 findings (or P0 findings have been merged into this PROTOCOL.md, evidenced by `revision history` entry).
3. STATE.md transitions cycle records `activated_at` and `stop_at = activated_at + 8h`.

Until activation, the existing cascade wake-loop continues unchanged.

## Wake-Cycle Procedure

Every wake:
1. Read STATE.md. If `stopped_at` is set, halt and write final report. Done.
2. Read ci-watch.md and refresh PR statuses for in-flight items.
3. If cascade not yet settled, run cascade-monitoring (existing behavior).
4. If cascade just settled this cycle AND no unresolved P0 in COUNCIL.md: set `activated_at`, `stop_at = activated_at + 8h`, log to council-log.md.
5. If activated:
   - a. Drain completed items from eng-queue (PRs merged → mark `merged`).
   - b. Surface CI failures (non-flake) to SIGNOFFS as `flake-escalation`.
   - c. Run drift detector: count items by `parent_plan_id`. If skewed (3+ outside active phase, 2+ without parent_plan_id), halt.
   - d. Run resource check: disk free, worktree count. If over budget, halt.
   - e. If < 2 eng dispatches in flight AND < 2 open PRs AND eng-queue has eligible items: pick top item, dispatch Sonnet agent. Update item status.
   - f. If 90+ min since last product dispatch: dispatch product Sonnet to refill backlog. Brief it explicitly with the locked plan's active-phase list.
   - g. Drain Tier-1 items from backlog → eng-queue (status=queued).
   - h. For Tier-2 items in backlog: open SIGNOFFS as `tier-2-review`, do NOT promote until user approves.
   - i. For Tier-3 items in backlog: open SIGNOFFS as `tier-3-council`, do NOT promote ever.
   - j. Diff-validate all in-flight Tier-1 PRs (path-based). If any flip to Tier-3 due to late commits, halt + tier-misclassification SIGNOFFS.
6. Update STATE.md with current cycle, spend_estimate, in_flight count, drift_signals.
7. ScheduleWakeup in 15-20 min (or longer if quiet).

## File Update Discipline

- Always read a file before writing to it. Append, don't overwrite, for log-shaped files.
- STATE.md is the only file fully rewritten each cycle.
- Each backlog/queue/signoff item gets a stable ID (BL-NNN, EQ-NNN, SIG-NNN). NNN auto-increments; never reuse.
- Timestamps in ISO-8601 UTC.

## What This Loop Will NOT Do (REVISED post-council — P2-2)

The forbidden-surfaces list expanded. Loop will NEVER touch:

**Hard forbid (no Tier-3, no SIGNOFFS — just don't):**
- `.env*`, `*.key`, `*.pem` (CLAUDE.md guardrail)
- Secrets (`secrets/**`, `keys/**`, anything matching `gitleaks` allowlist)
- Git history (no force-push, force-merge, admin-bypass branch protection)
- Direct push to `main`

**Tier-3-routed (open SIGNOFFS council; user must approve):**
- Schema/migrations (everything in path-based rules above)
- Auth, billing, payments
- Cross-service contracts (`packages/shared/src/types/**`, `api-*.ts`, `constants.ts` for catalog)
- Primary nav structure (Sidebar.tsx, MobileBottomNav.tsx, App.tsx, company-routes.ts)
- Build/dependency config (tsconfig, vite.config, pnpm-lock, package.json)
- Infrastructure (workflows, _headers, vercel.json, fly.toml, Dockerfile)
- Runtime contracts (packages/runner, packages/adapters existing-file edits)

**Additional path forbids (per P2-2 council finding — never auto, always SIGNOFFS at minimum):**
- `vite.config.ts`, `tsconfig*.json` (Gemini surfaced)
- `pnpm-lock.yaml`, any workspace `package.json` (Gemini + Codex)
- `tests/e2e/playwright.config.ts`, `e2e/playwright.config.ts` (smoke harness)
- Files in `docs/runbooks/`, `DEPLOYMENT.md`, `docs/ops/` (ops-critical docs)
- Migration runners (`packages/db/src/check-migration-numbering.ts`, `packages/db/src/runtime-config.ts`)
- Council-log, SIGNOFFS, STATE files themselves (only chief-of-staff writes; eng agents never)

## Tier Misclassification Recovery

When the diff-validator catches a Tier-3 file in a declared Tier-1 PR mid-flight:
1. Immediately halt auto-merge enrollment.
2. Write SIGNOFFS as `tier-misclassification` with priority P1.
3. Log to council-log: which agent declared what tier, which file flipped it.
4. Close the offending PR if pre-merge (don't leave dangling). Branch is preserved.
5. Mark the source backlog item with `tier_misclassification_count++`. If 2+, that item is permanently re-tiered to Tier-3.
6. Brief next product-team dispatch about the misclassification pattern.

## Sample-N Reviewer-Agent Protocol (added cycle 18 per user decision — Option A)

**Origin**: User observation 2026-05-11 cycle 18 — "my github shows how there's 0% activity on code reviews we need to improve this." Autoloop's Tier-1 auto-merge speed creates a structural review-event gap on GitHub's Insights surface. Option A (Sample-N on every PR) selected over path-set-only or self-approve-event.

**Rule**: Every autoloop-shipped PR (Tier-1 + Tier-2) gets a `code-reviewer` subagent dispatched in parallel with CI. The reviewer posts a real GitHub review event (`gh pr review <N> --approve` or `--request-changes`) with a 10-20 line substantive comment.

**Mechanics**:
- Dispatch via `Agent({subagent_type: "code-reviewer", isolation: "worktree", run_in_background: true})` with brief: PR # + branch + tier + file list + review-focus list specific to the change surface (LLM/Anthropic SDK / auth / DB / accessibility / etc.).
- Reviewer agent ID: **RV-NNN** (separate sequence from EQ-NNN dispatches).
- Reviewer is **read-only** — no code modifications. Briefs explicitly forbid destructive git operations.
- For Tier-1 PRs: review event posts as `--approve` if no blockers; CI + review form a 2-of-2 gate before auto-merge fires (auto-merge already requires CI green; review APPROVE is a soft signal that surfaces on GitHub but does not gate the auto-merge enrollment).
- For Tier-2 PRs: review event posts before the user's merge decision, giving the human reviewer a substantive starting point rather than a blank PR.
- If reviewer raises `--request-changes`: open SIGNOFFS as `tier-1-review-blocker` (P1) or `tier-2-review-blocker` (P2). Auto-merge stays enrolled; the autoloop runner removes it if the reviewer finding is substantive (not nit-class).

**Review focus templates** (per surface):
- **Server services / routes**: secret management, error handling, auth surface, cache/dedup keys, LLM SDK params (max_tokens, retry on 529)
- **UI pages / components**: founder-language copy, accessibility (aria, keyboard nav), lazy-loading boundaries, disabled-state UX
- **Shared types / API contracts**: zod validation at boundaries, breaking-change detection vs. existing consumers
- **Tests**: real assertions vs. smoke checks, mock isolation (esp. vitest cross-worker race per class #11), coverage of error states
- **Migrations / schema** (Tier-3 only): never reaches reviewer — SIGNOFFS council instead

**Failure modes (anticipated)**:
- Reviewer agent runs the same Bash `cd <parent>` pattern that caused EQ-013's branch-HEAD leak. Defense: brief explicitly forbids; agent works in its own worktree pwd.
- Reviewer's review event posts after PR merges (race on Tier-1 fast-CI flows). Defense: fall back to `gh pr comment <N>` instead of `gh pr review <N>`. Comment still counts toward GitHub activity surface; just not an "approve" badge.
- Reviewer finds 0 issues every time → review noise without signal. Mitigation: rotate review focus per-surface; if signal-to-noise stays low across 10 dispatches, downgrade to path-set-only (Option B fallback).

**Telemetry**:
- Reviewer findings logged in STATE.md cycle row.
- If reviewer + CI disagree (CI green but reviewer requests changes): flag as `review-vs-ci-divergence` in STATE.md — these are the highest-signal events.
- After 10 RV dispatches, retrospect: how many --approve, how many --request-changes, how many SIGNOFFS opened, how many real issues caught vs. nits.

**First activation**: cycle 18 — RV-001 on #176 (BL-022 Haiku widget, Tier-2), RV-002 on #181 (BL-016 AI Connections, Tier-2). Both dispatched 14:02Z in parallel.
