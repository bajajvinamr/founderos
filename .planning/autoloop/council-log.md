# Council Log

Major decisions that hit the adversarial council (Gemini + Codex) or were escalated to user. Append-only chronological log.

**Schema per entry**:
```
## [CL-NNN] <iso ts> — <topic>

**Decision**: <what was decided>
**Source**: <auto-loop | autoloop-orchestrator | user-signoff | shadow-council-hook>
**Reviewers**: <gemini | codex | both | user>
**Verdict**: <PASS | FAIL | DEFERRED | CONDITIONAL>
**Rationale**: <why>
**Artifacts**: <files, PRs, COUNCIL.md, SIG-NNN>
```

---

## [CL-001] 2026-05-11T00:00:00Z — Autoloop protocol design

**Decision**: Run an 8-hour autonomous loop with chief-of-staff + product + engineering roles per `PROTOCOL.md`.
**Source**: shadow-council-hook (PostToolUse on Write of PROTOCOL.md)
**Reviewers**: gemini + codex (in-flight via background agent a0c995f21df5eb688)
**Verdict**: pending (background review running)
**Rationale**: PROTOCOL.md keyword-matched on auth/payment/migration. Hook flagged for council. User authorized parallel review while scaffold continues. Findings will land in `.planning/autoloop/COUNCIL.md` when complete.
**Artifacts**: PROTOCOL.md, COUNCIL.md (in flight)

---

## [CL-002] 2026-05-11T00:30:00Z — Autoloop protocol v2 (council P0+P1 fixes merged)

**Decision**: Merge all 3 P0 + 3 P1 findings from COUNCIL.md into PROTOCOL.md v2 before activation. Activation gate now: cascade PRs settle.
**Source**: shadow-council-hook → user-signoff via summary
**Reviewers**: gemini (2.5 Pro) + codex (GPT-5.4) — both
**Verdict**: CONDITIONAL → resolved by v2 rewrite
**Rationale**:
- P0-1 (tier-as-prediction) → path-based tier rules; diff-validator runs before auto-merge enrollment. Tier is now a property of the diff, not a product team guess.
- P0-2 (Tier-2 contradiction) → single-path flow: SIGNOFFS approve → eng-queue promotion → dispatch. Deleted the parallel path that let Tier-2 reach eng-queue without sign-off.
- P0-3 (no drift halt) → parent_plan_id mandatory at intake; 5 drift-halt signals (off-phase work, repeated-dir thrash, scope-expansion without approval, items without parent, same-subsystem PR pile-up).
- P1-1 (concurrency too loose) → 2 eng + 2 PRs (was 3+5); parallel rebase (was single-file).
- P1-2 (flat flake list) → 10-row taxonomy with detection heuristic + retry policy + expiry per class. Unknown flakes halt fast.
- P1-3 (SIGNOFFS unstructured) → enriched schema with priority/blast_radius/expires_at/source/recommended_action + summary table at top sorted by urgency.

P2 findings deferred to first cycle as SIGNOFFS items (activation-from-blocked-stack, forbidden-surface gaps, disk/resource exhaustion).
**Artifacts**: COUNCIL.md (full review), PROTOCOL.md v2, STATE.md v2, SIGNOFFS.md v2, product-backlog.md (all 23 items updated with parent_plan_id), commit 5aa779e

---

## [CL-005] 2026-05-11T01:18:00Z — Cycle 7 dispatch outcomes — diff-validator and worktree-leak invariants validated live

**Decision**: Document outcomes of the first two autoloop-dispatched eng agents (EQ-001 + EQ-002). Confirms path-based diff validation and worktree-leak invariants both fire correctly under autonomous dispatch.
**Source**: autoloop-orchestrator (cycle 8)
**Reviewers**: dispatched-agents (returned summaries)
**Verdict**: PASS (both invariants validated)
**Rationale**:

**EQ-002 / BL-004 / PR #170 — Tier-1 shipped autonomously** ✅
- 4 files / 222+ / 49- under `ui/src/components/onboarding/*`. Zero Tier-3 path touches per `gh pr diff 170 --name-only`. Diff-validator confirmed Tier-1 → auto-merge enrolled SQUASH → merged at 22:39:13Z.
- 14-package typecheck green, 46 onboarding tests pass. First autoloop-shipped PR.
- **Worktree-leak invariant validated** (vinamr-invariants.md "Agent Harness / Claude Code"): initial absolute-path Edits leaked into the parent `chore/autoloop-scaffold` checkout despite `Agent({isolation: "worktree"})`. Agent self-detected via `git diff`, restored main, re-applied via `git apply` inside the worktree. No contamination of autoloop scaffold branch. **This is the second independent confirmation of the invariant** (first was Trust Closure dispatch TC-4); pattern is reproducible.
- Branch auto-rename from `worktree-agent-a7052b5bc00966d43` to the intended `feat/bl-004-remove-default-adapter` worked when agent explicitly renamed (per vinamr-invariants "Agent may self-name worktree branches").

**EQ-001 / BL-001 — Tier-2 honestly escalated to Tier-3** ⚠️→SIG-005
- Agent investigated, found CLAUDE.md note is **stale** (PR #148 restructured `onboarding-bootstrap.ts`), and determined the actual remaining bug requires 7-file coordinated dispatch across `packages/shared/src/constants.ts` (Tier-3) + new migration (Tier-3) + new `@founderos/anthropic-api` adapter package + 4 wiring/test files.
- Agent refused to commit a workaround; returned full triage in summary. Worktree clean, no PR opened.
- **Diff-validator invariant validated** (PROTOCOL.md v2 §"Tier Routing"): the path-based forbidden-surface list correctly forced the work to Tier-3 escalation rather than allowing a Tier-2 dispatch to silently touch shared constants + migrations. The council's P0-1 fix is working as designed.
- Findings now captured in SIG-005 for user review.

**Calibration signal**: 50/50 split between autonomous-ship and honest-escalate is roughly what the council assumed when designing the path validator. 100% ship → validator too loose. 100% escalate → backlog tier-declarations too aggressive. The escalation rate is the system's self-calibration.

**CLAUDE.md note about onboarding-bootstrap.ts:201 is stale** — flagged for cleanup in SIG-005 artifacts (don't edit unilaterally; it's mentioned across audit docs).
**Artifacts**: eng-queue.md (EQ-001 abandoned, EQ-002 merged), SIG-005 (B2 Tier-3 escalation), STATE.md cycle 8 update, ci-watch.md cycle 8 snapshot

---

## [CL-004] 2026-05-11T01:08:00Z — Autoloop activated via user-override (P2-1 escape hatch)

**Decision**: Activate autoloop despite cascade not yet settled (4/7 merged; #163 #168 #169 still in flight). 8-hour timer starts at 2026-05-11T01:08:00Z; stop_at = 2026-05-11T09:08:00Z.
**Source**: user-signoff
**Reviewers**: user (explicit message "Converge into an 8 hour autonomous loop with all permissions granted")
**Verdict**: APPROVED
**Rationale**: PROTOCOL.md v2 §"Activation Trigger" (council P2-1 fix) requires either (a) all cascade PRs merged OR (b) explicit human "abandon stack and activate anyway" sign-off. User provided (b). Three of the four trigger conditions independently hold (COUNCIL.md exists, P0 findings merged into v2, STATE.md transitionable). The cascade's 3 in-flight PRs are tracked separately and will land in parallel with autoloop dispatch — they don't gate the new work because BL-001/BL-004 don't depend on #163/#168/#169.

Permissions posture this run:
- Tier-1: dispatch + auto-merge after path-based diff validation (fully autonomous)
- Tier-2: dispatch + open PR without auto-merge; SIGNOFFS for visibility (fully autonomous on dispatch; merge requires user)
- Tier-3: SIGNOFFS-only; never dispatch (path rules enforce; hard gate)

The path-based diff validator is the safety primitive; human approval at Tier-2 dispatch is downgraded to informational. Tier-3 hard-gate is unchanged.
**Artifacts**: STATE.md v3 (status=active), eng-queue.md (EQ-001, EQ-002), SIGNOFFS.md (SIG-001 through SIG-004 — Tier-3 items), dispatched agents (2 in parallel)

---

## [CL-003] 2026-05-11T00:35:00Z — Shadow Council hook false-positive class noted

**Decision**: Three additional shadow-council-hook fires on PROTOCOL.md v2 + SIGNOFFS.md + product-backlog.md (each on Write/Edit). Treated as false positives — these documents DESCRIBE auth/migration/billing as Tier-3 routed surfaces; they do not modify those surfaces.
**Source**: shadow-council-hook (PostToolUse, keyword-matched)
**Reviewers**: hook-only (no model invocation)
**Verdict**: FALSE-POSITIVE
**Rationale**: Hook is regex-based; cannot distinguish "discusses topic X" from "modifies code in path X". The protocol just adjudicated by CL-002 already routes these topics to council via path rules. Future hook improvement: filter by file-being-written's path (only fire on actual code in `migrations/`, `auth/`, `billing/`, etc.), not on document content. Logged as Vanta invariant candidate (cross-cuts the `vinamr-invariants.md` pattern of "keyword-only routing produces false positives").
**Artifacts**: 3 PostToolUse hook contexts during commit 5aa779e flow
