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
- **MERGED at 2026-05-11T10:05:24Z** ✅ — autoloop's 2nd ship. Dashboard.tsx clean. EQ-003 round-trip dispatch→merge ≈ ~8.5h elapsed (mostly CI wait).

## [EQ-005] P8.c — Top Blockers + Quick Wins widgets  (from BL-023)

- **branch**: feat/bl-023-top-blockers-quick-wins (or agent-self-named)
- **agent**: dispatch-cycle-10-eq-005 (general-purpose, isolation=worktree, background) — id a051ee3032ed5ed78
- **dispatched_at**: 2026-05-11T10:08:00Z (3 min after #171 merge unblocked BL-023)
- **pr**: null
- **tier_declared**: 1
- **status**: dispatched
- **last_update**: 2026-05-11T10:08:00Z
- **notes**: Unblocked by #171 (BL-021) merge. New widgets fill the space cleared on Dashboard.tsx. Prompt steered to Option A (PURE Tier-1): UI widgets + static Quick Wins suggestions + TODO note for the Haiku suggester service (which is BL-022 P8.b, separate Tier-2 dispatch later). Touches: Dashboard.tsx + new component files under ui/src/components/dashboard/ + new test files. Auto-merge enrolled after diff-validator passes.

## [EQ-004] P2.a — Step 4 onboarding copy uses DisplayDictionary  (from BL-002)  ✅ PR OPENED + auto-merge enrolled

- **branch**: feat/bl-002-step-4-founder-copy (renamed at push-time from worktree-agent-a06f163797092410e via `git push origin local:remote`)
- **agent**: cycle-8.5 dispatch a06f163797092410e (completed 2026-05-11T10:01:00Z, ~5.5min — fastest round-trip yet)
- **dispatched_at**: 2026-05-11T09:55:00Z
- **pr**: #172 — auto-merge enrolled SQUASH at 09:59:58Z; BLOCKED on CI (13 success / 0 failure / 7 running). MERGEABLE per gh.
- **tier_declared**: 1 → actual Tier-1 (diff-validator confirmed: 5 files; `display-dictionary.{ts, test.ts, snap}` + `FounderOnboardingWizard.tsx` + new step4 test — all in Tier-1 paths)
- **status**: pr_opened
- **last_update**: 2026-05-11T10:01:00Z
- **notes**: 5 files / +191 / -5. Added 2 DisplayDictionary keys (`onboarding.step4.headline`, `onboarding.step4.subtitle`) with founder/engineer mode strings, wired wizard Step 4 via `useDisplay` hook + `data-testid`s, added 140-line step4 test with 4 assertions (founder mode, engineer mode, localStorage persistence, fallback). 50/50 onboarding tests pass, 10/10 display-dictionary tests pass, 8-package typecheck green, lint clean. **No worktree leak** this dispatch — confirms harness behavior improving for branch-explicit operations (third no-leak in a row after EQ-002 leak).
