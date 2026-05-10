# Autoloop State

**Rewritten on every wake cycle. Single source of truth for current runtime status.**

## Lifecycle

- **status**: `active`  <!-- pre-activation | active | halted | completed -->
- **activated_at**: 2026-05-11T01:08:00Z
- **stop_at**: 2026-05-11T09:08:00Z  <!-- activated_at + 8h -->
- **stopped_at**: null
- **halt_reason**: null
- **activation_mode**: `user-override`  <!-- normal-cascade-settle | user-override -->
- **activation_authority**: user message "Converge into an 8 hour autonomous loop with all permissions granted" (2026-05-11T01:05Z) — explicit P2-1 escape hatch

## Permissions Posture (this run)

Per user "all permissions granted":
- **Tier-1**: dispatch + auto-merge (after path-based diff validator) ✅ autonomous
- **Tier-2**: dispatch + open PR without auto-merge; SIGNOFFS entry written for visibility ✅ autonomous
- **Tier-3**: SIGNOFFS-only; never dispatch (path rules enforce regardless) — HARD GATE

The path-based diff validator (PROTOCOL.md v2 §"Tier Routing") is the safety primitive. The human-review gate at Tier-2 dispatch time is downgraded to "informational/visibility only" because the diff itself is now the source of tier truth.

## Activation Trigger Status

1. All 7 cascade PRs MERGED: 4/7 — #161 ✅ #164 ✅ #165 ✅ #167 ✅ #163 ⏳ #168 ⏳ #169 ⏳
   - **Override**: user-signoff per P2-1 escape hatch
2. `COUNCIL.md` exists ✅
3. COUNCIL.md P0 findings merged into PROTOCOL.md v2 ✅
4. STATE.md transitions to `status: active` ✅ (this update)

## Cycle Bookkeeping

- **cycle**: 7  <!-- activation cycle -->
- **last_cycle_at**: 2026-05-11T01:08:00Z
- **next_wake_at**: 2026-05-11T01:28:00Z

## Concurrency Tracking (post-council P1-1)

- **eng_dispatches_in_flight**: 2  <!-- BL-001 + BL-004 dispatched this cycle -->
- **eng_dispatches_max**: 2
- **open_prs**: 3  <!-- #163 #168 #169 cascade — autoloop's new PRs added after dispatch lands -->
- **open_prs_max**: 2  <!-- cascade in flight; once it settles, autoloop's own PRs respect the cap -->
- **last_product_dispatch_at**: null  <!-- product team will be invited starting cycle 9 once eng has a rhythm -->
- **product_dispatch_interval_min**: 90
- **branch_refresh_strategy**: parallel

## Resource Tracking

- **disk_free_gb**: unknown  <!-- check via `df -BG / | tail -1` next cycle -->
- **disk_halt_threshold_gb**: 5
- **active_worktrees**: 2  <!-- BL-001 + BL-004 -->
- **active_worktrees_max**: 5
- **stale_worktree_cleanup_hours**: 6

## Cost Telemetry

- **spend_estimate_usd**: 5  <!-- rough — cycles 1-6 + 2 agent dispatches -->
- **spend_ceiling_usd**: 150
- **cost_alert_at**: 120

## Outputs Counter

- **prs_opened**: 0  <!-- post-activation; cascade PRs counted separately -->
- **prs_merged**: 0
- **signoffs_pending**: 4  <!-- BL-006, BL-007, BL-019, BL-020 — Tier-3 items -->
- **backlog_items_total**: 23
- **backlog_items_remaining**: 21  <!-- minus 2 promoted to eng-queue -->

## Drift Detection State

- **items_without_parent_plan**: 0
- **prs_in_single_dir**: {}
- **prs_outside_active_phase**: 0
- **active_phase_set**: ["B2", "P2"]  <!-- shifted from pre-activation; B-bugs + first founder-language phase -->

## Last Action Log

```
7: 2026-05-11T01:08:00Z | activate | autoloop entered active state via user-override
7: 2026-05-11T01:08:00Z | promote   | BL-001 → EQ-001 (Tier-2, B2 server bootstrap)
7: 2026-05-11T01:08:00Z | promote   | BL-004 → EQ-002 (Tier-1, P2.c remove default adapter)
7: 2026-05-11T01:08:00Z | signoff   | BL-006 → SIG-001 (Tier-3 B4 schema, council-required)
7: 2026-05-11T01:08:00Z | signoff   | BL-007 → SIG-002 (Tier-3 P3.a Sidebar CTA)
7: 2026-05-11T01:08:00Z | signoff   | BL-019 → SIG-003 (Tier-3 P6.a Composio catalog)
7: 2026-05-11T01:08:00Z | signoff   | BL-020 → SIG-004 (Tier-3 P7 IA collapse)
7: 2026-05-11T01:08:00Z | dispatch  | EQ-001 + EQ-002 to general-purpose agents in worktree isolation
```
