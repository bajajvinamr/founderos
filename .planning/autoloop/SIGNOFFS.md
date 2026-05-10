# Sign-offs — User Review Queue

Items that need human decision. The chief-of-staff appends entries here when:
- Tier-2 PR opened (requires human review before merge)
- Tier-3 item reached (council-required, never auto-dispatched)
- CI failure on a previously-green PR after retry limit
- Cost telemetry crosses 80% of ceiling
- Eng-queue empty AND backlog has only Tier-3 items (loop is parked)
- Any other halt-class event

User reviews each entry, edits the `status:` field, and the next wake cycle acts.

**Status transitions**:
- `pending` (initial) → `approved` | `rejected` | `resolved` | `deferred`

**Schema per entry**:
```
## [SIG-NNN] <topic>
- type: <tier-2-review|tier-3-council|flake-escalation|spend-alert|empty-queue|other>
- created: <iso ts>
- context: 1-3 sentences of why this needs sign-off
- proposed: what the autoloop wants to do
- alternatives: 1-2 other options
- artifacts: <PR #, commit, file path, branch>
- status: pending
- resolved_at: null
- resolution_note: null
```

---

(empty — populated by chief-of-staff after activation)
