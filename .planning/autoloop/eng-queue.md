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

## [EQ-003] P8.a — Dashboard widget removal  (from BL-021)  ✅ PR OPENED + auto-merge enrolled

- **branch**: feat/bl-021-dashboard-widget-removal (agent created explicitly after worktree auto-named to worktree-agent-ab380f32c4636bb8f — vinamr-invariant validated again)
- **agent**: cycle-8 dispatch ab380f32c4636bb8f (completed 2026-05-11T01:26:30Z, ~8.5min)
- **dispatched_at**: 2026-05-11T01:18:00Z
- **pr**: #171 — auto-merge enrolled SQUASH; BLOCKED on CI (13 success / 0 failure / 7 running)
- **tier_declared**: 1 → actual Tier-1 (diff-validator confirmed: 2 files under ui/src/pages/* — zero forbidden-path touches)
- **status**: pr_opened
- **last_update**: 2026-05-11T01:27:00Z
- **notes**: 2 files / +144 / −173 (net cleanup). Dashboard.tsx removes RunActivityChart, "Month spend" MetricCard, Recent Activity feed, PermissionCoachCard + dead-code cleanup (animation state, entity maps, projectsApi query). Dashboard.test.tsx new — 6 assertions (4 negative for removed widgets, 2 positive preserving FounderBriefing + activityApi.list which The Morning Brief still consumes). Typecheck clean across 24 workspace packages; 24/24 ui/src/pages tests pass; lint clean. **Permission Coach relocation NOT done** — pragmatic-option path: removal-only, TODO comment left, component file untouched, relocation needs Tier-3 nav-structure edit → see SIG-006. No worktree leak observed this dispatch (third consecutive — agent harness behavior may be improving for branch-explicit operations).
- **post-#169 rebase**: cycle 8.5 `gh pr update-branch 171` fired after DisplayDictionary landed; fresh CI rerunning.

## [EQ-004] P2.a — Step 4 onboarding copy uses DisplayDictionary  (from BL-002)

- **branch**: feat/bl-002-step-4-founder-copy (or agent-self-named)
- **agent**: dispatch-cycle-8.5-eq-004 (general-purpose, isolation=worktree, background) — id a06f163797092410e
- **dispatched_at**: 2026-05-11T09:55:00Z (just after #169 DisplayDictionary landed at 09:44:59Z)
- **pr**: null
- **tier_declared**: 1
- **status**: dispatched
- **last_update**: 2026-05-11T09:55:00Z
- **notes**: Unblocked by #169 merge. Touches FounderOnboardingWizard.tsx Step 4 + possibly display-dictionary.ts (sibling to types/, NOT a Tier-3 forbidden path per PROTOCOL.md v2). Tier-1 by path. Auto-merge enrolled after diff-validator passes. Snapshot tests for both viewModes.
