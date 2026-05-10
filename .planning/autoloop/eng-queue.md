# Engineering Queue

Items the chief-of-staff has drained from `product-backlog.md`, in dispatch order. The engineering team picks the top `queued` item with all dependencies `merged`.

**Schema per entry**:
```
## [EQ-NNN] <title>  (from BL-NNN)
- branch: <feat/...>
- agent: <agent-id-from-dispatch>
- dispatched_at: <iso ts>
- pr: <#N | null>
- tier_declared: <1|2|3>
- status: <queued|dispatched|in_progress|pr_opened|merged|blocked|abandoned>
- last_update: <iso ts>
- notes: <any blockers or surprises>
```

---

## [EQ-001] B2 — server bootstrap honors chosen adapter  (from BL-001)

- **branch**: feat/bl-001-bootstrap-honor-adapter (or agent-self-named per vinamr-invariants)
- **agent**: dispatch-cycle-7-eq-001 (general-purpose, isolation=worktree, background)
- **dispatched_at**: 2026-05-11T01:08:00Z
- **pr**: null
- **tier_declared**: 2
- **status**: dispatched
- **last_update**: 2026-05-11T01:08:00Z
- **notes**: Touches server/src/services/onboarding-bootstrap.ts:201. No schema/auth/migration paths in declared scope. Diff validator runs before PR open. Tier-2: PR opens without auto-merge per "all permissions granted" Tier-2 policy.

## [EQ-002] P2.c — remove anthropic_api default in FounderOnboardingWizard  (from BL-004)

- **branch**: feat/bl-004-remove-default-adapter (or agent-self-named)
- **agent**: dispatch-cycle-7-eq-002 (general-purpose, isolation=worktree, background)
- **dispatched_at**: 2026-05-11T01:08:00Z
- **pr**: null
- **tier_declared**: 1
- **status**: dispatched
- **last_update**: 2026-05-11T01:08:00Z
- **notes**: Touches ui/src/components/onboarding/FounderOnboardingWizard.tsx:82 + test. Tier-1 by path (no nav/schema/contract files). Auto-merge enrolled after diff validator passes.
