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

## [CL-003] 2026-05-11T00:35:00Z — Shadow Council hook false-positive class noted

**Decision**: Three additional shadow-council-hook fires on PROTOCOL.md v2 + SIGNOFFS.md + product-backlog.md (each on Write/Edit). Treated as false positives — these documents DESCRIBE auth/migration/billing as Tier-3 routed surfaces; they do not modify those surfaces.
**Source**: shadow-council-hook (PostToolUse, keyword-matched)
**Reviewers**: hook-only (no model invocation)
**Verdict**: FALSE-POSITIVE
**Rationale**: Hook is regex-based; cannot distinguish "discusses topic X" from "modifies code in path X". The protocol just adjudicated by CL-002 already routes these topics to council via path rules. Future hook improvement: filter by file-being-written's path (only fire on actual code in `migrations/`, `auth/`, `billing/`, etc.), not on document content. Logged as Vanta invariant candidate (cross-cuts the `vinamr-invariants.md` pattern of "keyword-only routing produces false positives").
**Artifacts**: 3 PostToolUse hook contexts during commit 5aa779e flow
