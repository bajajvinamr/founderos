# Autoloop State

**Rewritten on every wake cycle. Single source of truth for current runtime status.**

## Lifecycle

- **status**: `pre-activation`  <!-- pre-activation | active | halted | completed -->
- **activated_at**: null
- **stop_at**: null  <!-- set to activated_at + 8h when status transitions to active -->
- **stopped_at**: null
- **halt_reason**: null

## Activation Trigger (REVISED — post-council P2-1)

Autoloop activates only when ALL of these hold (no 60-min fallback; cannot activate over stuck stack):

1. All 7 cascade PRs MERGED: #161 ✅ #164 ✅ #165 ✅ #167 ✅ #163 ⏳ #168 ⏳ #169 ⏳
2. `COUNCIL.md` exists in `.planning/autoloop/` ✅ (created 2026-05-11T00:00:00Z)
3. COUNCIL.md P0 findings merged into PROTOCOL.md ✅ (v2 written 2026-05-11T00:30:00Z; revision history records the merge)
4. STATE.md transitions to `status: active`, `activated_at = now`, `stop_at = activated_at + 8h`

**Current gate**: condition 1 only. 3 PRs ⏳ in-flight (#163, #168 fresh CI after cycle-5 rebase; #169 fresh CI after cycle-6 rebase). Expected to settle on next 1-2 wake cycles.

## Cycle Bookkeeping

- **cycle**: 6
- **last_cycle_at**: 2026-05-11T01:02:00Z
- **next_wake_at**: 2026-05-11T01:22:00Z

## Concurrency Tracking (REVISED post-council P1-1)

- **eng_dispatches_in_flight**: 0
- **eng_dispatches_max**: 2  <!-- was 3 -->
- **open_prs**: 4  <!-- #163 #165 #168 #169 — cascade in flight; #167 merged -->
- **open_prs_max**: 2  <!-- was 5; cascade in flight so currently OVER quota until settled -->
- **last_product_dispatch_at**: null
- **product_dispatch_interval_min**: 90
- **branch_refresh_strategy**: parallel  <!-- was single-file cascade; parallel rebase per cycle -->

## Resource Tracking (NEW post-council P2-3)

- **disk_free_gb**: unknown  <!-- check each cycle: `df -BG /Users/vinamr | tail -1 | awk '{print $4}'` -->
- **disk_halt_threshold_gb**: 5
- **active_worktrees**: 0  <!-- check via `git worktree list | wc -l` minus 1 (main) -->
- **active_worktrees_max**: 5
- **stale_worktree_cleanup_hours**: 6

## Cost Telemetry

- **spend_estimate_usd**: 0
- **spend_ceiling_usd**: 150
- **cost_alert_at**: 120  <!-- writes SIGNOFFS entry when crossed -->

## Outputs Counter

- **prs_opened**: 0  <!-- post-activation -->
- **prs_merged**: 0
- **signoffs_pending**: 0
- **backlog_items_total**: 23
- **backlog_items_remaining**: 23

## Drift Detection State (NEW post-council P0-3)

- **items_without_parent_plan**: 0  <!-- count from backlog; halt at 2 in single product dispatch -->
- **prs_in_single_dir**: {}  <!-- map dir → count; halt at 5 same-dir without parent_plan_id progression -->
- **prs_outside_active_phase**: 0  <!-- halt at 3+ -->
- **active_phase_set**: ["B1", "B3", "P1"]  <!-- pre-activation; will shift to ["B2", "P2", "P3"] post-cascade -->

## Last Action Log

```
<cycle>: <iso ts> | <action> | <outcome>
```

(empty until cycle 1)
