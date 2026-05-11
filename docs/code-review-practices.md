# Code Review Practices

> How code review works on FounderOS — for humans AND AI agents.
> Grounded in the autoloop's 16-cycle operational record (8 ships, 1 escalation, 0 worktree leaks).

This document distills the de-facto review discipline that emerged from running 11 AI-agent dispatches against the FounderOS codebase between 2026-05-11T01:08Z and 2026-05-11T13:15Z. It is not generic best-practices boilerplate. Every rule cites a specific event from `.planning/autoloop/` — a PR number, a SIGNOFFS entry (`SIG-NNN`), a council finding ID (`CL-NNN`), or a cycle in `STATE.md`.

Read this once if you are about to:

- Open a PR against `main`
- Review someone else's PR
- Dispatch an AI agent to ship code
- Decide whether a change needs adversarial council before it ships

The reference material lives in `.planning/autoloop/` (`PROTOCOL.md`, `STATE.md`, `SIGNOFFS.md`, `council-log.md`, `COUNCIL.md`). The narrative production gotchas live in `~/.claude/rules/vinamr-invariants.md`. This doc is the **actionable surface** over those.

---

## 1. The structural primitive: path-based tier routing

The single most important review rule on this repo: **a change's risk tier is a property of the diff, not a label someone assigned.** The autoloop computes the tier from `gh pr diff <n> --name-only` and forbidden-path patterns. Human reviewers should do the same — open the file list before reading any code.

This rule exists because the council (Gemini 2.5 Pro + GPT-5.4 via Codex CLI, see `.planning/autoloop/COUNCIL.md` P0-1) found that the first protocol draft let product teams *predict* the tier. Both reviewers flagged this independently: "An agent mis-labels a schema/auth/billing change as Tier-2, the human approves the SIGNOFFS entry assuming Tier-2 means low risk, never noticing the migration file in the diff." That class of failure is structurally eliminated by computing the tier from the diff.

### The three tiers

| Tier | Risk | Author posture | Reviewer posture | Auto-merge? |
|---|---|---|---|---|
| **Tier 1** | Low — copy, tests, docs, small visual tweaks | Ship via `gh pr merge --auto --squash` | Spot-check; trust CI gates | YES, after path validator passes |
| **Tier 2** | Medium — new server-side service, new route, new UI page | Open PR, do NOT enroll auto-merge | Read diff end-to-end; verify scope and test coverage; merge by hand | NO — explicit human merge |
| **Tier 3** | High — schema, auth, billing, primary nav, infra, shared types | Never auto-dispatched; SIGNOFFS-only | Adversarial council (Gemini + Codex) before any code is written | NO — never |

### Tier-3 forbidden paths (authoritative list)

If a PR's diff touches **any** of these, the actual tier is **Tier 3** regardless of declared tier. Re-derived from `PROTOCOL.md` §"Tier Routing":

- **Schema**: `**/*.sql`, `**/migrations/**`, `packages/db/schema/**`, `packages/db/src/check-migration-numbering.ts`
- **Auth/billing middleware**: `**/auth/**`, `**/middleware/auth*.ts`, `**/middleware/billing*.ts`, `**/post-signup-hook.ts`
- **Payments**: `**/stripe/**`, `**/billing/**`, `**/subscriptions/**`, `**/instance_subscription*`
- **Cross-service contracts**: `packages/shared/src/types/**`, `packages/shared/src/api-*.ts`, `packages/shared/src/constants.ts`
- **Primary nav structure**: `ui/src/components/Sidebar.tsx`, `ui/src/components/MobileBottomNav.tsx`, `ui/src/App.tsx`, `ui/src/lib/company-routes.ts`
- **Build/dependency config**: `tsconfig*.json`, `vite.config.ts`, `pnpm-lock.yaml`, root `package.json`, any workspace `package.json`
- **Infrastructure**: `.github/workflows/**`, `_headers`, `vercel.json`, `fly.toml`, `Dockerfile*`, `docker-compose*.yml`
- **Runtime contracts**: `packages/runner/**`, `packages/adapters/**` (existing-file edits)
- **Credentials**: `.env*`, `*.key`, `*.pem`, `secrets/**`, `keys/**` — these are **hard forbid**; not even Tier-3 routes them; the autoloop never touches them

### Tier-2 paths (review queue)

If a PR touches none of the above but does touch:

- `server/src/routes/**` or `server/src/services/**` (existing-file edits)
- `ui/src/pages/**` (new pages) or new top-level components in `ui/src/components/**`
- New server-side services, new database queries (no schema change), new background tasks

→ then it's **Tier 2**: open PR, log a SIGNOFFS entry, human merges. PR #176 (BL-022 Haiku "yesterday widget") is the canonical Tier-2 example — 8 files, +1112 lines pure-additive, new server service + new route surface, sat in the Tier-2 review queue with `autoMergeRequest:null` until the user explicitly merged it 33 minutes after open. See `SIG-008` for the full diff justification.

### Tier-1 paths (everything else)

- Copy/label edits via `DisplayDictionary` (PR #172, PR #177 are examples)
- Test additions / new test files
- Documentation (this file)
- Small visual tweaks to existing components
- New unit-test helpers in `__tests__/` or `**/test-utils/**`
- Pure-additive new UI components in subdirectories (PR #173: 6 new files under `ui/src/components/dashboard/`, +679/-0)

### Why path-based, not LLM judgment

`COUNCIL.md` P0-1 + P0-2 form an exploitable path if you let agents predict tier: mislabel a migration as Tier-2, watch the human approve the SIGNOFFS entry, ship the migration through a low-touch review path. **Path rules are the structural fix**. Don't argue tier in PR descriptions — run `gh pr diff <n> --name-only` and grep the table above.

---

## 2. The review queue: SIGNOFFS schema

`.planning/autoloop/SIGNOFFS.md` is the **review queue** — every Tier-2 PR, every Tier-3 decision, every flake escalation, every cost alert lands here as a `SIG-NNN` entry. The schema (revised in council finding P1-3) is enriched specifically so humans can triage 15 entries in 10 minutes without opening each PR.

### When work flows through SIGNOFFS

| Trigger | Type | Path |
|---|---|---|
| Tier-2 PR opened | `tier-2-review` | `decision_required: approve-merge` — human reviews diff, merges by hand |
| Tier-3 decision | `tier-3-council` | `decision_required: approve` — adversarial council before any code |
| Diff-validator caught mis-tier | `tier-misclassification` | Halt loop, P1, investigate the mis-classifying agent |
| CI red after retry | `flake-escalation` | If not a known flake, halt |
| Cost over 80% of ceiling | `spend-alert` | Informational |
| Mission drift signal fired | `mission-drift` | Halt loop |
| Eng-queue empty + only Tier-3 items left | (informational) | Loop parked |
| Scope expansion proposed | `scope-expansion` | Human approves the new parent_plan_id |

### Entry schema (the fields that matter for review)

```markdown
## [SIG-NNN] <topic>

- type: tier-2-review | tier-3-council | flake-escalation | tier-misclassification | ...
- priority: P0 (block activation) | P1 (block progress) | P2 (informational)
- decision_required: approve | reject | resolve | defer | escalate | approve-merge
- blocking: <what halts until resolved>
- blast_radius: <files, services, runtime impact, user-visible surfaces>
- ci_state: green | red | n/a
- merge_state: MERGEABLE | BLOCKED | BEHIND | n/a
- source: <BL-NNN, EQ-NNN, PR #N, autoloop-cycle-N>
- recommended_action: <1 sentence>
- expires_at: <iso ts>
- context: 1-3 sentences of why this needs sign-off
- proposed: what the autoloop wants to do
- alternatives: 1-2 other options
- artifacts: <PR #, commit, file paths>
- status: pending | approved | rejected | resolved | deferred
```

### Tier-2 vs Tier-3 entries — concrete examples

**SIG-008 (Tier-2 `approve-merge`, P2 priority)** — PR #176, the Haiku yesterday widget. Decision is `approve-merge`. The diff is clean, tests are green, but a new server-side LLM service touching a new route surface gets human eyes once before it lands. The autoloop's job ends at "PR opened + SIGNOFFS logged." The human's job is to read `gh pr diff 176`, verify Haiku model choice + 30s timeout + 1024 max output tokens are appropriate, then `gh pr merge 176 --squash`.

**SIG-005 (Tier-3 `approve`, P0 priority)** — BL-001 B2 adapter bootstrap. Decision is `approve` — and "approve" here means schedule an adversarial council session on the discriminated-union shape *before* any code is written. The blast radius is 7 files spanning 3 Tier-3 forbidden surfaces (shared constants, new migration, new adapter package). The autoloop's path validator correctly refused to dispatch this even when EQ-001 was assigned to it; the agent investigated, returned an honest "this is Tier-3, here's the 7-file shape" summary, and the work moved to SIGNOFFS. This is what the validator is for.

### Expiry semantics

If `expires_at` passes with `status: pending`:

- **P0**: autoloop writes an escalation entry + halts the loop
- **P1**: downgrade to `deferred`, note in council-log
- **P2**: archive to `council-log.md`, remove from SIGNOFFS

Don't let SIGNOFFS entries rot. The system tracks them, but human attention is the rate-limiter.

---

## 3. The PR review checklist (concrete)

Apply this in order to any open PR. Stop at the first NO and address it before moving on.

### 3.1 Compute the actual tier from the diff

```bash
gh pr diff <PR#> --name-only
```

Grep each filename against the Tier-3 forbidden-paths table in §1. If any hit → this is **Tier 3** regardless of what the PR description says. Stop. Open a SIGNOFFS `tier-misclassification` entry. The autoloop's diff-validator does exactly this; humans should too.

### 3.2 Check author posture matches actual tier

- Tier 1: PR should have `autoMergeRequest: SQUASH` (or PENDING → SQUASH on CI completion). Check via `gh pr view <n> --json autoMergeRequest`.
- Tier 2: PR should have `autoMergeRequest: null`. If a Tier-2 PR is enrolled in auto-merge, the agent violated the protocol invariant ("Tier-2 must NOT enroll auto-merge" — `PROTOCOL.md` Tier-2 row in the routing table). PR #176 and PR #178 are confirmed-correct Tier-2 examples (both `autoMergeRequest:null` verified at `STATE.md` cycle 12.5 and 13.5).
- Tier 3: there is no PR (autoloop refused to dispatch). If you see one, something is very wrong.

### 3.3 Prefer pure-additive changes; scrutinize deletions

The autoloop's strongest shipping shape is **pure-additive**: new files, no edits to existing code. Five of the eight shipped autoloop PRs were strictly net-positive:

| PR | Files | Add/Del | Shape |
|---|---|---|---|
| #173 | 6 | +679/-0 | Pure-additive (new widgets) |
| #176 | 8 | +1112/-0 | Pure-additive (new service + new widget) |
| #178 | 3 | +309/-11 | Render-path additive (11 deletions are narrowing pre-existing tests) |
| #177 | 6 | +263/-7 | DisplayDictionary additive (7 deletions are removing old strings being replaced by dictionary keys) |
| #174 | 6 | +427/-4 | Settings-page additive (4 deletions for type widening) |

When deletions appear, ask: are they (a) removing dead code, (b) narrowing pre-existing tests intentionally, or (c) actual behavior changes? Only (c) needs detailed review. PR #178's 11 deletions are all type (b) — pre-existing SSR thinking-markdown test narrowed because the founder-mode gate now hides that block. That's safe.

PR #171 is the one PR with meaningful deletions: -173 across 2 files, all removing dashboard widgets (run-activity, cost, activity-feed). The deletions ARE the change — verify they're authorized by the parent backlog item and not collateral. (BL-021 explicitly authorized the removals; SIG-006 captured the one remaining piece — Permission Coach relocation — as a Tier-3 follow-up.)

### 3.4 Test coverage expectations

The autoloop's lived pattern: **every shipped PR has tests for the changed surface, and the workspace-wide typecheck passes across all packages.** Concrete numbers from cycle 12.7:

- EQ-009 / PR #177: `71/71 tests green (onboarding 61 + display-dictionary 10); typecheck 12 packages green`
- EQ-010 / PR #178: `21/21 transcript tests green (8 new BL-013 founder-mode); typecheck 21 packages green`
- EQ-008 / PR #176: `21 server tests + 15 UI tests green; typecheck 23 packages green`

For Tier-1 PRs, this is enforced by CI. For your review:

- New tests exist for the changed code (count them in the diff)
- Typecheck ran against the full workspace, not just the changed package — if the PR description says "typecheck 12 packages green" or similar, that's the signal
- For Tier-2 PRs adding LLM service surfaces (PR #176 pattern), check that test isolation includes a reset hook (`_resetYesterdaySummaryCache()` in #176) so the test file doesn't bleed state into siblings. See §6 SIG-011 for what happens when this is missed.

### 3.5 Verify CI is green — and trust `mergedAt` over `mergeStateStatus`

Run `gh pr view <n> --json mergeStateStatus,mergedAt,statusCheckRollup`.

Required gates (from `CLAUDE.md` "CI gates"):

- `typecheck` (~2m)
- `lint`
- `test (+ coverage)` (~10m)
- `migration-check`
- `schema-drift`
- `bundle-size` (<1.5MB gzipped UI)
- `audit`
- `gitleaks`
- `CodeQL`
- `E2E critical flows`
- `ci (all checks)` aggregate — this is the actual merge contract

**Known gotcha** (cycle 13 action log, 2026-05-11T12:00:00Z): `mergeStateStatus` from the GitHub CLI can lag actual merge state by 5-10 minutes on freshly-merged PRs. The autoloop probed `#174` at cycle 12.7 (~11:50Z) and got `BLOCKED`; the PR had actually merged at 11:43:40Z. **Trust `mergedAt` over `mergeStateStatus`.** If `mergedAt` is non-null, the PR is merged.

### 3.6 Exception class: path-scoped pre-existing failures

Not every CI red is a real failure. SIG-010 documents three pre-existing test failures (`billing-gate.test.ts`, `heartbeat-jwt-secret-fail.test.ts`, `issues-execution-routes.test.ts`) that existed **before** the autoloop started and are unrelated to most PR scopes. The autoloop validator is path-scoped: a UI-only PR that fails `server/__tests__/*` tests is not the PR's fault.

Decision rule when CI fails:

- Is the failing file in the PR's diff? → It's the PR's fault.
- Is the failure a known flake (see `docs/CI-KNOWN-FLAKES.md`)? → Retry per the flake taxonomy (see §6).
- Is the failure a SIG-010-class pre-existing failure? → Proceed; document in PR description that this failure is known and unrelated.
- Anything else? → Halt and investigate. See SIG-011 for the canonical example.

### 3.7 Worktree-leak invariant check (AI-agent dispatches only)

This applies only when reviewing PRs opened by an AI-agent dispatch (typically: branch name pattern `feat/bl-NNN-*` or `worktree-agent-*`, opened by `claude[bot]` or similar). It does NOT apply to human-authored PRs.

The invariant: `Agent({isolation: "worktree"})` is supposed to keep file writes scoped to the worktree, but `~/.claude/rules/vinamr-invariants.md` documents that **modifications to existing tracked files can leak into the parent checkout's `git status`.** This was caught across 3 leaks during FounderOS trust-closure dispatch (TC-4 agent).

How to verify the agent didn't leak:

```bash
# In the parent checkout (NOT the agent's worktree):
git status --short
# Should be clean. Any unexpected M lines = leak.
```

The autoloop has validated this **6 consecutive times** across EQ-005 (cycle 10.5), EQ-006/EQ-007 (cycle 11.5/11.7), EQ-008 (cycle 12), EQ-009 (cycle 12.7), EQ-010 (cycle 13.5). The streak is meaningful: it suggests that when agents are briefed with explicit forbidden-paths + run `git diff --name-only HEAD` before staging, the leak does not occur. Preserve the streak. If you see a leak, restore phantom changes via `git restore <file>` before staging the actual PR work.

### 3.8 Verify branch self-naming

Related to §3.7: `vinamr-invariants.md` also documents that agents sometimes self-rename their branch from the prompted name to `worktree-agent-<agent_id>` despite the prompt explicitly saying "Your branch: feat/bl-NNN-<topic>". This is harmless for safety (work is still on a separate branch, no contamination), but for review:

```bash
gh pr view <n> --json headRefName
# Verify the branch name matches the intended pattern, not worktree-agent-*
```

If it doesn't match, resolve the actual branch via `git worktree list` before assuming the prompted name was honored. PR #176's branch `feat/bl-022-yesterday-widget-haiku` is an example of correct self-naming (cycle 12.5 action log).

---

## 4. AI-agent dispatch rules

If you are dispatching an AI agent to ship code (via `Agent({isolation: "worktree"})` or any equivalent), follow these rules. They are derived from the autoloop's 11 dispatches (8 ships, 1 escalation, 2 in-flight).

### 4.1 Explicit brief structure

Every dispatch brief must include:

- **Allowed paths**: exact globs the agent may write to (e.g., `ui/src/components/onboarding/*`)
- **Forbidden paths**: exact globs the agent must NOT write to (use the Tier-3 list in §1)
- **Acceptance criteria**: 1-3 bullet points describing what "merged and done" means in user-visible terms
- **Why now**: 1 sentence anchoring the work to the locked plan's `parent_plan_id`

The autoloop's product-team output is rejected at intake if `parent_plan_id` is missing (`PROTOCOL.md` §"Parent Plan Binding"). Apply the same rule when dispatching: if you can't cite a plan item, you don't know what you're shipping.

### 4.2 Branch self-naming requirement

The agent MUST receive its branch name in the brief: e.g., "Your branch: `feat/bl-NNN-<topic>`". Even though the agent may self-rename anyway (§3.8), the explicit instruction is the contract. Verify post-dispatch via `gh pr view <n> --json headRefName`.

### 4.3 Tier-2 must NOT enroll auto-merge

This is a protocol invariant (`PROTOCOL.md` Tier-2 row: "opens PR but does NOT enroll auto-merge"). Verified live across two Tier-2 dispatches:

- EQ-008 / PR #176: `autoMergeRequest=null` confirmed via `gh pr view 176 --json autoMergeRequest` at cycle 12.5
- EQ-010 / PR #178: `autoMergeRequest=null` confirmed at cycle 13.5

If you're briefing a Tier-2 dispatch, the brief must include: "Do NOT run `gh pr merge --auto`. Open the PR, return summary, exit."

### 4.4 Tier-3 NEVER auto-dispatched

If the brief touches any Tier-3 path → don't dispatch. Open a `tier-3-council` SIGNOFFS entry. EQ-001 / BL-001 is the canonical example: the agent investigated, found the work crosses 3 Tier-3 surfaces, refused to commit a workaround, and the work moved to SIG-005. **The agent doing the right thing is part of the system.** Don't punish honest escalation; calibrate against it (CL-005: "50/50 split between autonomous-ship and honest-escalate is roughly what the council assumed").

### 4.5 The worktree-leak pattern

From `vinamr-invariants.md` "Agent Harness / Claude Code":

> `Agent({isolation: "worktree"})` does NOT 100% partition file writes — the worktree's branch state is correctly isolated, but modifications to existing tracked files can leak into the parent checkout's `git status`. Defense: ALWAYS run `git diff --name-only HEAD` before `git add`/`git commit` to verify scope.

Brief every agent with this pattern explicitly. The 6-consecutive-validation streak (§3.7) suggests it works when agents are told.

---

## 5. Adversarial council triggers

The autoloop uses **adversarial review**: Gemini 2.5 Pro + GPT-5.4 (via Codex CLI), in parallel, looking for the same flaws. Both must surface and agree before a finding is treated as P0. See `COUNCIL.md` for the canonical example: both reviewers converged on the same three P0s independently.

### 5.1 Auto-trigger topics

Open an adversarial council session **before any code is written** when the work touches:

- **Auth**: Supabase auth, JWT, OAuth flow, post-signup hooks, magic-link tokens
- **Payments**: Stripe, billing-gate middleware, subscription state, webhooks
- **Migrations**: Anything in `**/migrations/**`, `**/*.sql`, or `packages/db/schema/**`
- **Security**: Threat-model-relevant code, SSRF surfaces, secret handling, runner-token issuance
- **Schema**: Cross-service contracts (`packages/shared/src/types/**`, `constants.ts`, `api-*.ts`)
- **Primary nav structure**: `Sidebar.tsx`, `MobileBottomNav.tsx`, `App.tsx`, `company-routes.ts` — anything that changes the founder's mental model
- **Hard-to-reverse refactors**: Renaming a published package, changing the public type signature of a shared API path constant, deleting a route, etc.

CL-001 documents the council that originally produced `COUNCIL.md`: the PROTOCOL.md draft itself was flagged by the shadow-council-hook (PostToolUse on Write of any file with auth/payment/migration keywords) and a parallel review session was launched.

### 5.2 The R1 → R2 convergence pattern

From `vinamr-invariants.md` "Vanta" section:

> Run a third council round when R2 changed core risk logic, even though the protocol caps at R2.

The autoloop's council itself ran R1 only (CL-001 + CL-002), but the pattern documented in vinamr-invariants for Vanta v3.7→v3.8 is the right one to apply to FounderOS code:

- **R1**: independent reviews from each model. Findings tagged P0 / P1 / P2.
- **R2**: convergence check on R1 findings. If R2's fixes touch the same area being reviewed (e.g., the new code itself), the new code is under-reviewed.
- **R3**: required when R2 changed core logic. Hard-stop on any unresolved both-confirmed P2; single-model P3/P4 findings can be deferred with notes.

### 5.3 What "council" means concretely

```bash
# R1, parallel:
mcp__Multi-CLI__Ask-Gemini  "<context, what was changed, what could go wrong>"
mcp__Multi-CLI__Ask-Codex   "<same context>"

# Wait for both. Compare findings.
# Both-confirmed P0 → must fix before merge.
# Single-model P0 → discuss; one model may be wrong.

# R2 (after R1 fixes):
mcp__Multi-CLI__Ask-Gemini  "Given <fixes>, does <new code> still hold?"
mcp__Multi-CLI__Ask-Codex   "Given <fixes>, does <new code> still hold?"
```

`COUNCIL.md` and `council-log.md` are the persistent record. Every council session that produces a P0/P1 should land in `council-log.md` as `CL-NNN` with the schema:

```markdown
## [CL-NNN] <iso ts> — <topic>

Decision: <what was decided>
Source: <auto-loop | autoloop-orchestrator | user-signoff | shadow-council-hook>
Reviewers: <gemini | codex | both | user>
Verdict: <PASS | FAIL | DEFERRED | CONDITIONAL>
Rationale: <why>
Artifacts: <files, PRs, COUNCIL.md, SIG-NNN>
```

### 5.4 When the shadow-council hook fires falsely

CL-003 documents three shadow-council hook fires on PROTOCOL.md / SIGNOFFS.md / product-backlog.md edits. The hook is keyword-based; it cannot distinguish "discusses topic X" from "modifies code in path X". When the hook fires on a docs-only PR, mark it `FALSE-POSITIVE` in council-log and move on. **Don't let false positives normalize ignoring the hook** — when the hook fires on a real `*.sql` or `auth/**` edit, take it seriously.

---

## 6. Flake taxonomy + retry policy

Not every red CI is a real bug. The autoloop maintains a **10-class flake taxonomy** (`PROTOCOL.md` §"Flake Taxonomy"). Each class has a detection heuristic + retry policy + expiry date.

### 6.1 The 10 known flake classes

| Class | Subsystem | Heuristic | Retry policy | Expiry |
|---|---|---|---|---|
| postgres-teardown null-write | server tests | "Cannot read properties of null (reading 'write')" in `node_modules/postgres/src/connection.js:255` + "N tests passed, 1 unhandled error" | up to 2 retries via update-branch | 2026-08-01 |
| jwt-env-leak | server tests | `heartbeat-jwt-secret-fail.test.ts` asserts `FOUNDEROS_AGENT_JWT_SECRET` unset but env-var leaked from parallel worker | up to 2 retries | 2026-08-01 |
| stacked-PR module-not-found | typecheck | `Cannot find module '@founderos/*'` caused by PR depending on unmerged sibling | NOT a retry — wait + update-branch after dep lands | always (structural) |
| embedded-pg port drift | server tests | "address already in use" on ports 5432-5499; `startEmbeddedPostgresTestDatabase` collision | up to 1 retry | 2026-08-01 |
| fixed-port collision | E2E/integration | port 3199/3232/3000 EADDRINUSE | up to 1 retry, then halt with `port-collision` SIGNOFFS | 2026-08-01 |
| pnpm install registry flake | setup | `fetch failed` / `ETIMEDOUT` / `ECONNRESET` during `pnpm install` | up to 2 retries with backoff (30s, 120s) | always |
| OOM during typecheck | build | "FATAL ERROR: Reached heap limit" + process Killed in tsc | up to 1 retry with `NODE_OPTIONS=--max-old-space-size=8192`, then halt | 2026-08-01 |
| child-process orphan | post-test cleanup | "Terminate orphan process" in log but exit code 0 | NONE — false signal, ignore as success | always |
| workspace-runtime parallel race | server tests | `workspace-runtime.test.ts` intermittent failure under parallel load | up to 2 retries | 2026-08-01 |
| linked-worktree symlink drift | worktree dispatch | Agent worktree references stale package-link in `node_modules/.pnpm/` after a sibling PR updated the workspace | recreate worktree + retry once, then halt | always |

`docs/CI-KNOWN-FLAKES.md` is the **active quarantine list** — when a flake is fixed, it gets marked FIXED with the resolution (see entries #1, #2, #3, #4, #5, #6 — all resolved). When a flake is intractable, it gets `it.skip` with a removal criterion (see entry #7).

### 6.2 Unknown flake — halt fast

`PROTOCOL.md`: "Unknown flake: halt fast. Do not retry blindly. Write SIGNOFFS as `flake-unknown` with the failing job URL + first 50 lines of error output + a `next_step: identify_symptom_class` field."

This is the rule that SIG-011 should have triggered cleaner. SIG-011 was logged as `regression-from-autoloop-ship` (correctly P1) but the categorization is the same lesson: the failure was either a flake class #11 (module-cache contamination) or a real regression. The protocol says: don't retry blindly; investigate or escalate.

### 6.3 Module-cache contamination — the SIG-011 / PR #176 pattern

This is a candidate flake class #11 worth documenting in detail because it appeared during the autoloop's lived record. From SIG-011 + STATE.md cycle 16 action log:

**Symptom**: PR #176 (BL-022 Haiku widget) CI failed with `TypeError: db.select is not a function` at `server/src/services/onboarding-bootstrap.ts:437` inside `maybeTriggerFirstRun`. The failing code is **unchanged on main** — PR #178 passed the same job on the same post-#177 base.

**Diagnosis**: PR #176's only divergence is a new yesterday-summary service + its test file + dashboard.ts route extension. The TypeError fires in a file unchanged by #176. Pattern matches `vinamr-invariants.md` "Event-ingest singleton initialization in tests" — but inverted: the new test file may have a partial `db` mock or `vi.mock('@founderos/db')` that bleeds into the vitest worker's module cache and contaminates downstream tests sharing that worker.

**Why local tests passed**: Vitest typically isolates within a single file; cross-file contamination only shows in parallel workspace runs.

**Resolution path** (per SIG-011 recommended_action):
1. Trigger CI rerun (flake discrimination).
2. If rerun passes → file as flake class #11, add `vi.resetModules()` guard in test's `beforeEach` to harden against re-occurrence.
3. If rerun fails identically → read the test file for `vi.mock` statements; if found, scope to local via `vi.unmock` in `afterAll`, or convert to pure DI.

**What NOT to do** (per SIG-011 alternative (a)): "Force-merge #176 with `--admin` flag bypassing CI. **REJECTED** — this is the unsafe shortcut the protocol explicitly forbids; #176 might be shipping a real test isolation bug into main where it'd contaminate every future PR's CI."

This is the canonical "the system caught a regression" event. See §8 example 4 for the full story arc.

### 6.4 The "trust mergedAt over mergeStateStatus" lesson

Already covered in §3.5 but bears repeating because it's a flake-class adjacent gotcha: the GitHub CLI's `mergeStateStatus` field can lag actual merge state by 5-10 minutes on freshly-merged PRs (cycle 13 action log, 2026-05-11T12:00:00Z). The autoloop probed `#174` at cycle 12.7 and got `BLOCKED`; the PR had actually merged at 11:43:40Z. If you script CI gates on `mergeStateStatus`, you'll get phantom blocks. Trust `mergedAt`.

---

## 7. What you'll see in this repo

For a contributor (human or AI) opening this repo cold, here's the orienting map:

- **`.planning/autoloop/`** — the live operational record of the autonomous-team loop
  - `PROTOCOL.md` — the operating manual (v2, post-council)
  - `STATE.md` — single source of cycle truth, rewritten every wake
  - `SIGNOFFS.md` — the review queue (Tier-2 PRs, Tier-3 decisions, halts)
  - `council-log.md` — every major decision that hit adversarial council
  - `COUNCIL.md` — the original Gemini + Codex review of PROTOCOL.md v1
  - `eng-queue.md`, `product-backlog.md`, `ci-watch.md` — supporting state files
- **`docs/CI-KNOWN-FLAKES.md`** — the active quarantine list (which tests are skip-flagged and why)
- **`CLAUDE.md`** — in-the-code-path gotchas: stack details, command reference, known pitfalls (router prefix parsing, adapter choice, Composio v3, billing-gate, ALS request-context, runner tokens, magic-link tokens, etc.)
- **`AGENTS.md`** — full contributor guide (linked from CLAUDE.md)
- **`~/.claude/rules/vinamr-invariants.md`** (user-global) — production gotchas across all projects, several of which ARE FounderOS-discovered patterns (Composio cross-org, Drizzle FK, Postgres CHECK constraints, Stripe webhook idempotency)

When in doubt, read in this order: this file → CLAUDE.md → PROTOCOL.md → vinamr-invariants.md → the specific SIG-NNN or CL-NNN entry referenced.

---

## 8. Appendix: real examples

### Example 1: clean Tier-1 ship (PR #177, BL-005)

**Cycle**: 12.7 / 13.5
**Round-trip**: 7.9 minutes
**Shape**: 6 files / +263 / -7 in `packages/shared/src/display-dictionary*` (additive keys only) + `ui/src/components/onboarding/*`
**Tier signal**: zero Tier-3 path touches — agent added DisplayDictionary keys but NEVER touched `packages/shared/src/constants.ts` (same parent dir, different files, different tier classification per the path-validator precision check at cycle 12.7)
**CI**: 71/71 tests green (onboarding 61 + display-dictionary 10); typecheck 12 packages green
**Auto-merge**: SQUASH enrolled at 11:39:44Z, fired post-fresh-CI at 11:58:59Z
**Reviewer involvement**: zero — pure autoloop ship

This is what Tier-1 should look like. Small surface, pure-additive (or additive with minor narrowing), test coverage matching the change, no Tier-3 path touches, auto-merge fires on green CI. Six of the eight autoloop ships fit this shape.

### Example 2: Tier-2 review queue (PR #178, BL-013)

**Cycle**: 13.5 / 16
**Round-trip**: 13.9 minutes (dispatch → PR open)
**Time in review queue**: ~33 minutes (PR opened 12:15Z, user merged 13:05:40Z)
**Shape**: 3 files / +309 / -11 all in `ui/src/components/transcript/*`
**Tier signal**: modifies `RunTranscriptView.tsx` (render-contract change, Tier-2). Diff-validator PASS for Tier-2 — no Tier-3 paths.
**CI**: 21/21 transcript tests green (8 new BL-013 founder-mode + 3 BL-012 seam + 10 pre-existing); typecheck 21 packages green
**`autoMergeRequest`**: `null` — Tier-2 policy honored
**SIGNOFFS entry**: SIG-009 logged P1 (P4 keystone) with `decision_required: approve-merge`
**Resolution**: User explicit-merge at cycle 15 ("Go ahead merge and launch a new autonomous loop"); auto-merge SQUASH fired after CI

This is what Tier-2 should look like. The autoloop's job ended at "PR opened + SIGNOFFS logged." The human's job was to review the render-contract change (toggle founder/engineer via Settings, confirm chain-of-thought hides + reappears, confirm failed runs preserve stderr) and merge. Both PR #176 and PR #178 followed this exact shape.

### Example 3: when path-validator forced escalation (EQ-001 / SIG-005, BL-001)

**Cycle**: 7 / 8
**Round-trip**: dispatch → escalation summary (no PR opened)
**What happened**: EQ-001 was assigned to BL-001 (B2 server bootstrap honors chosen adapter — "Tier-2" by product's declaration). The agent investigated and found that the actual fix requires 7 files spanning 3 Tier-3 forbidden surfaces:
- `packages/shared/src/constants.ts` (cross-service contract)
- new `packages/db/src/migrations/0107_*.sql` (schema)
- new `packages/adapters/anthropic-api/` package (parallel of #165's gemini-api)
- plus server registry wiring, route key-persistence widening, resolver routing, test assertion flips

The agent refused to commit a workaround. Returned the full triage. The work moved to SIG-005 (P0, `decision_required: approve`).

**Why this is a system success, not a failure**: The path validator did exactly what it was designed to do — catch a Tier-3-shaped change that was declared Tier-2 by the product team. CL-005: "Diff-validator invariant validated: the path-based forbidden-surface list correctly forced the work to Tier-3 escalation rather than allowing a Tier-2 dispatch to silently touch shared constants + migrations. The council's P0-1 fix is working as designed."

**Calibration signal**: 50/50 split between autonomous-ship (EQ-002) and honest-escalate (EQ-001) in cycle 7. CL-005 notes this is roughly what the council assumed when designing the path validator. 100% ship → validator too loose. 100% escalate → backlog tier-declarations too aggressive. The escalation rate is the system's self-calibration.

### Example 4: when the system caught a regression (SIG-011 / PR #176)

**Cycle**: 16
**What happened**: PR #176 had been Tier-2 reviewed (SIG-008), user-merged-enrolled (`gh pr merge 176 --auto --squash`) at cycle 15. Sister PR #178 (also Tier-2, also user-merged-enrolled at cycle 15) merged successfully at 13:05:40Z. PR #176 auto-merge BLOCKED at 13:07:03Z with `test (+ coverage)` + `ci (all checks)` FAILED:

```
TypeError: db.select is not a function
  at maybeTriggerFirstRun (server/src/services/onboarding-bootstrap.ts:437)
```

**The diagnostic challenge**: The failing code (`onboarding-bootstrap.ts:437`) is UNCHANGED on main. PR #178 just passed the same test job on identical post-#177 base. PR #176 is the only variable.

**The diagnosis**: Pattern matches `vinamr-invariants.md` "Event-ingest singleton initialization in tests" — but inverted. The new yesterday-summary test file likely has a partial `db` mock or `vi.mock('@founderos/db')` that bleeds into the vitest worker's module cache and contaminates downstream tests sharing that worker. Local 21/21 passed because vitest typically isolates within a single file; cross-file contamination only shows in parallel workspace runs.

**The right move (per SIG-011)**: Trigger CI rerun for flake-vs-real-bug discrimination. If rerun passes → file as flake class #11, add `vi.resetModules()` hardening. If rerun fails → re-dispatch EQ-008 with isolation fix context (scope `vi.mock` to local via `vi.unmock` in `afterAll`, or convert to pure DI).

**The wrong move (explicitly rejected in SIG-011)**: Force-merge with `--admin` flag bypassing CI. The PR might be shipping a real test-isolation bug into main where it'd contaminate every future PR's CI.

**The system-level point**: The auto-merge was correctly held back. The auto-merge enrollment is a request, not a guarantee — GitHub's CI gate refused to merge red CI. SIG-011 captured the diagnostic state. The next cycle either confirms the flake (and we add a hardening rule) or re-dispatches with better isolation. **Either path is the system working.** Compare with the EQ-001 escalation in example 3: there, the path-validator caught a tier-misclassification before code was written; here, the CI gate caught a test-isolation regression after code was written. Both are layers of the same defense.

---

## Final note: this doc is a snapshot

The autoloop's 16-cycle record is the evidence base for everything above. As the loop continues (`activated_at: 2026-05-11T12:30:00Z`, `stop_at: 2026-05-11T20:30:00Z` for the current relaunch), new patterns will emerge. When they do:

- New flake classes → add to `PROTOCOL.md` taxonomy + `docs/CI-KNOWN-FLAKES.md`
- New Tier-3 forbidden surfaces → add to §1 here + `PROTOCOL.md` §"Tier Routing"
- New worktree-leak shapes → add to `vinamr-invariants.md` "Agent Harness" section
- New review checklist items → add to §3 here

The discipline this doc captures is the lived practice as of 2026-05-11 cycle 16. It is meant to be updated, not preserved as scripture.
