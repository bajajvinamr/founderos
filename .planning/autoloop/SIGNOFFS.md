# Sign-offs — User Review Queue (v2 — post-council)

Items that need human decision. The chief-of-staff appends entries here when:

- Tier-2 PR opened (requires human review before merge)
- Tier-3 item reached (council-required, never auto-dispatched)
- Tier misclassification detected (diff-validator caught Tier-3 in declared Tier-1)
- CI failure on a previously-green PR after retry limit
- Cost telemetry crosses 80% of ceiling
- Mission drift detected (items lacking `parent_plan_id`, repeated-dir thrash, off-phase work)
- Eng-queue empty AND backlog has only Tier-3 items (loop is parked)
- Scope expansion proposed (product team wants to add work outside locked plan)
- Any other halt-class event

User reviews each entry, edits the `status:` field, and the next wake cycle acts.

**Status transitions**:
- `pending` (initial) → `approved` | `rejected` | `resolved` | `deferred`

---

## Summary Table (sorted by urgency — P0 → P1 → P2)

Maintained at top of file. The chief-of-staff updates this table whenever an entry is added/resolved.

| ID | Priority | Type | Source | Blocking | Expires | Status | Recommended |
|---|---|---|---|---|---|---|---|

(empty — populated by chief-of-staff after activation)

---

## Entry Schema (REVISED post-council P1-3)

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
- **status**: pending
- **resolved_at**: null
- **resolution_note**: null
```

### Expiry semantics

If `expires_at` passes with `status: pending`:
- **P0** items: autoloop writes an additional SIGNOFFS entry escalating + halts the loop
- **P1** items: downgrade to `deferred` with note in council-log
- **P2** items: archive to `council-log.md` and remove from SIGNOFFS

---

## Entries

(empty — populated by chief-of-staff after activation)
