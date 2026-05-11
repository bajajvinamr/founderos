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

## [EQ-001] B2 — server bootstrap honors chosen adapter  (from BL-001)  ⚠️ ABANDONED → escalated

- **branch**: worktree-agent-a3a072a0f72106a61 (no commits; worktree clean)
- **agent**: cycle-7 dispatch (completed 2026-05-11T01:14:00Z)
- **dispatched_at**: 2026-05-11T01:08:00Z
- **pr**: null
- **tier_declared**: 2 → actual Tier-3 (path-based diff would force this)
- **status**: abandoned (tier-3-escalation)
- **last_update**: 2026-05-11T01:14:00Z
- **notes**: Agent investigated honestly, found the CLAUDE.md note about `onboarding-bootstrap.ts:201` hardcoding `claude_local` is STALE — PR #148 already restructured it. The remaining semantic bug (`anthropic_api` collapses to `claude_local` when hosted-off + BYO-off) can't be fixed within Tier-2 scope without touching `packages/shared/src/constants.ts` (cross-service contract — Tier-3) + new migration (Tier-3) + new `@founderos/anthropic-api` adapter package. Agent escalated rather than forcing a bad fix. **Full findings now captured in SIG-005.**

## [EQ-002] P2.c — remove anthropic_api default in FounderOnboardingWizard  (from BL-004)  ✅ MERGED

- **branch**: feat/bl-004-remove-default-adapter (auto-renamed from worktree-agent-a7052b5bc00966d43 then renamed back; vinamr-invariant validated)
- **agent**: cycle-7 dispatch (completed 2026-05-11T01:14:00Z)
- **dispatched_at**: 2026-05-11T01:08:00Z
- **pr**: #170 — opened, auto-merge enrolled SQUASH, merged 2026-05-10T22:39:13Z
- **tier_declared**: 1 → actual Tier-1 (diff-validator confirmed: 4 files under ui/src/components/onboarding/* — zero Tier-3 path touches)
- **status**: merged
- **last_update**: 2026-05-10T22:39:13Z
- **notes**: 4 files / 222+ / 49-. 14-package typecheck green, 46 onboarding tests pass. Worktree-leak invariant validated live (per vinamr-invariants.md): initial absolute-path Edits leaked into main checkout; agent self-detected via `git diff`, restored main, re-applied via `git apply` inside worktree. No contamination of chore/autoloop-scaffold. Autoloop's first dispatched + shipped PR ✅.

---

## [EQ-003] P8.a — Dashboard widget removal  (from BL-021)

- **branch**: feat/bl-021-dashboard-widget-removal (or agent-self-named)
- **agent**: dispatch-cycle-8-eq-003 (general-purpose, isolation=worktree, background)
- **dispatched_at**: 2026-05-11T01:18:00Z
- **pr**: null
- **tier_declared**: 1
- **status**: dispatched
- **last_update**: 2026-05-11T01:18:00Z
- **notes**: Touches ui/src/pages/Dashboard.tsx (remove Run Activity Chart, raw cost widget, activity feed) and possibly Setup route additions for Permission Coach move. Tier-1 by path (no nav/schema/contract files). Auto-merge enrolled after diff validator passes.
