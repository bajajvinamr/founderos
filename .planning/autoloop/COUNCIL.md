# Autoloop Protocol — Council Review

**Reviewers**: Gemini 2.5 Pro + GPT-5.4 (Codex CLI)
**Reviewed**: 2026-05-11T00:00:00Z
**Document**: PROTOCOL.md v1

> Verdict: **DO NOT ACTIVATE AS WRITTEN**. Both reviewers independently flagged the same three structural defects as P0. Codex: "This protocol is not safe to activate as written." Gemini: "Core Protocol is Unsound/Dangerous."

---

## P0 Findings (must fix before activation)

| # | Finding | Both agree? | Quote(s) | Specific fix |
|---|---|---|---|---|
| P0-1 | **Tier label is a prediction by Product, not a verified property of the diff.** Engineering picks up Tier-1 items and enrolls auto-merge with `gh pr merge --auto --squash` based on Product's guess. There is no second-pass tier audit before dispatch or before auto-merge. A mislabeled item ships unchecked. | ✅ Both | PROTOCOL.md:23 `"Tags each item with: phase, tier"`; :31 `"On Tier-1: enrolls auto-merge"` | Add (a) mandatory tier-validator at queue-promotion time and (b) diff-based guard at PR-open time. If diff touches schema/auth/billing/nav/migrations/runtime/shared-contracts, block auto-merge and force council review regardless of declared tier. |
| P0-2 | **Tier-2 flow is internally contradictory.** Engineering "Picks next Tier-1 or Tier-2 item from eng-queue.md" but the wake procedure says Tier-2 items get a SIGNOFFS entry and are NOT promoted to eng-queue. Two mutually exclusive rules govern the most common change class — actual behavior is undefined. | ✅ Both | PROTOCOL.md:28 vs :105 (Codex); Gemini: "Contradictory Tier Logic ... loop's behavior for most changes undefined" | Choose one design end-to-end: (a) Tier-2 implements first → reviewed on PR, or (b) Tier-2 requires human SIGNOFFS approval BEFORE coding. Delete the other path. |
| P0-3 | **No halt for mission drift / unwanted-but-correct work.** All 6 halts are operational (timer, queue, CI, council-block, spend, branch-protection). Product can "Generate 3-5 new backlog items per dispatch" with no acceptance check, no parent-plan binding, and no drift detector. Loop can run 8h shipping CI-green work that contradicts the locked UX plan, and nothing fires. | ✅ Both | PROTOCOL.md:58 (halt list); :22 (product generates freely). Gemini: "human operator would wake up to 8 hours of wasted effort or even features that actively contradict the business goals." | Add halts for: (a) backlog item with no parent-plan ID, (b) duplicate / overlapping work in same feature area, (c) repeated work in a single subsystem N+ times, (d) product output that diverges from `the locked plan` heuristic check. |

---

## P1 Findings (should fix this cycle)

| # | Finding | Both agree? | Quote(s) | Specific fix |
|---|---|---|---|---|
| P1-1 | **Concurrency caps too loose for this repo's CI cost.** Max 5 PRs in flight + only the front-of-queue PR refreshed per 15-20min cycle. With `ci` aggregate behind install 10m + test 15m + cancel-in-progress, a single main-move can serialize ~2-3h of refresh/retest churn. The last PR in queue can wait >1h to start its rebase. | ✅ Both | PROTOCOL.md:47-48, :108. Codex cites ci.yml:113 + workflows/README.md:27,37. Gemini: "pathologically slow for a system intended to run in parallel." | Drop to **2 open PRs + 1-2 active eng agents** until queue clears, OR compute caps dynamically from observed CI duration and branch-freshness. Alternatively, refresh ALL stale PRs concurrently, not single-file cascade. |
| P1-2 | **Known-flake list is too narrow and too binary.** Only 3 hardcoded symptoms with blanket "retry, do NOT fix" policy. Repo already documents more flake classes; unknown flakes get retried blindly with no escalation taxonomy. | ✅ Both | PROTOCOL.md:50. Codex cites server/vitest.config.ts:6, health.test.ts:8, growth-suggester.test.ts:23, scripts/ensure-workspace-package-links.ts:56, playwright.config.ts:3 (port 3199). Gemini adds OOM, build-cache corruption, network flakes, port conflicts. | Replace flat list with **taxonomy keyed by symptom class + owning subsystem + expiry date + detection heuristic**. Add: parallel/module-state races, embedded-pg port drift, linked-worktree symlink drift, fixed-port collisions (3199/3232), child-process orphan flakes, OOM during typecheck, pnpm registry flakes. Unknown flakes halt fast instead of retrying. |
| P1-3 | **SIGNOFFS format lacks triage metadata.** 15 entries can't be triaged in 10min without opening every PR. Format has no priority, no blocking impact, no blast radius, no CI/merge state, no SLA/expiry, no recommended default action, no source-traceability to backlog item. | ✅ Both | PROTOCOL.md:68-80. Codex: 8 missing fields. Gemini: 4 missing fields (priority, dependencies, effort, source). | Add fields: `priority`, `decision_required`, `blocking`, `blast_radius`, `ci_state`, `merge_state`, `recommended_action`, `expires_at`, `source: BL-NNN`. Add a top-of-file **summary table sorted by urgency** so the human triages from the index, not by scanning entries. |

---

## P2 Findings (consider for future iteration)

| # | Finding | Both agree? | Quote(s) | Specific fix |
|---|---|---|---|---|
| P2-1 | **Activation can start from a blocked stack.** Loop activates when seed PRs are merged OR after 60min in non-merging states (DRAFT/CLOSED/blocked-by-conflict). Activating on top of a blocked stack means engineering work compounds on broken foundations. | Codex only (Gemini didn't surface) | PROTOCOL.md:88 | Require all seed PRs merged, OR explicit human "abandon stack and activate anyway" sign-off. Do not auto-activate over a stuck stack. |
| P2-2 | **"Will NOT Do" list misses high-risk surfaces.** Forbids `.env`, secrets, deploy scripts, CI workflows. Says nothing about `package.json`, lockfiles, runtime config, migrations without schema edits, release-smoke harnesses, `tsconfig.json`, `vite.config.ts`. | ✅ Both | PROTOCOL.md:122 (Codex); Gemini independently names tsconfig.json / vite.config.ts as dependency/build-config gap | Expand forbidden-surface list OR route those files to Tier-3 automatically via a path-based rule independent of agent tier prediction. |
| P2-3 | **Disk/resource exhaustion + dispatch-level retries unhandled.** 8h run + 3 concurrent worktrees + logs + build artifacts can exhaust disk silently. No retry on transient setup failures (`pnpm install` registry hiccup) — a single dropped connection can block a dispatch indefinitely without firing a halt. | Gemini only (Codex didn't surface) | Gemini: "Resource Exhaustion (Non-Cost) ... numerous worktrees, logs, and build artifacts could easily exhaust available disk space"; "Stuck Task Loop ... protocol doesn't specify a retry" | Add disk-space + worktree-count monitoring to halt conditions. Add bounded retry (2-3x with backoff) for `pnpm install` / network-class setup failures, distinct from CI-flake retry policy. Add cleanup pass for stale worktrees each cycle. |

---

## Both-Models-Disagree

No substantive disagreements on P0/P1 — both reviewers converged independently on the same three core defects (tier-guess, tier-2 contradiction, no drift halt) and the same three P1 concerns (concurrency, flake taxonomy, SIGNOFFS format).

Minor surface differences:

| Topic | Gemini | Codex |
|---|---|---|
| Tier-gap examples | Dependency updates, build-config (tsconfig/vite), code deletion | Data backfills without schema diff, runtime/orchestration changes, permission/policy outside narrow "auth" |
| Activation-from-blocked-stack risk | Did not flag | Flagged as P2 |
| Disk/resource exhaustion | Flagged as P2 | Did not flag |
| Mission-drift halt mechanism | "feedback loop to validate Product Team's output against original plan intent" | "require each backlog item to cite explicit parent plan ID + acceptance criteria + why-now justification" |

Both framings are complementary: Codex provides the structural fix (parent-plan binding at backlog time), Gemini provides the runtime fix (drift detector at execution time). Recommend implementing **both**.

---

## Agreed Strengths

Both reviewers found these design choices sound and worth preserving:

1. **Tier-3 is explicitly never dispatched.** The hard rule "DO NOT DISPATCH" + "Surface to SIGNOFFS instead" is the right structural choice for schema/auth/payments. Neither reviewer attacked this principle; both attacked the *tier-detection* upstream of it.
2. **Forbidden mutations are clearly enumerated.** "Push to main directly", "Force-push, force-merge, or admin-bypass branch protection", "Modify .env, secrets, deploy scripts, CI workflows" — neither reviewer pushed back on the list contents, only on its completeness (P2-2).
3. **`Agent({isolation: "worktree"})` for engineering dispatches.** Worktree isolation is the correct primitive; neither reviewer challenged this choice. (Note: known leak vector documented in `vinamr-invariants.md` — phantom modifications to existing tracked files can appear in main checkout. Cross-reference but not new finding.)
4. **STATE.md as single source of cycle truth + ID stability (BL-NNN, EQ-NNN, SIG-NNN with no reuse).** Both implicitly accepted the file/ID model; no critique surfaced.
5. **Activation trigger is gated on cascade settlement.** Both accept the principle of waiting for seed-PR cascade before activating, even though Codex flagged the 60-min-non-merging fallback as P2.

---

## Recommended Activation Gate

Before flipping the autoloop activation switch, all three P0s must be resolved. P1s should be addressed in the same cycle. P2s can be tracked in SIGNOFFS as deferred items.

**Most-critical single finding**: P0-1 + P0-2 together form an exploitable path: an agent mis-labels a schema/auth/billing change as Tier-2, the contradictory Tier-2 flow lets it reach the eng-queue, and the human approves the SIGNOFFS entry assuming "Tier-2" means "low risk" — never noticing the migration file in the diff. The result is a Tier-3 change merged through the Tier-2 review path, completely bypassing the council requirement. This is the headline pre-activation blocker.
