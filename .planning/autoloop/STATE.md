# Autoloop State

**Rewritten on every wake cycle. Single source of truth for current runtime status.**

## Lifecycle

- **status**: `pre-activation`  <!-- pre-activation | active | halted | completed -->
- **activated_at**: null
- **stop_at**: null  <!-- set to activated_at + 8h when status transitions to active -->
- **stopped_at**: null
- **halt_reason**: null

## Trigger

Autoloop activates only when:
- All 7 cascade PRs are MERGED (#161 ✅ #164 ✅ #163 #165 #167 #168 #169)
- Council review of PROTOCOL.md has produced COUNCIL.md (background agent in flight)
- COUNCIL.md P0 findings have been merged into PROTOCOL.md (if any)

Until all three trigger conditions are met, the existing cascade wake-loop runs unchanged.

## Cycle Bookkeeping

- **cycle**: 0
- **last_cycle_at**: null
- **next_wake_at**: 2026-05-10T21:39:00Z (existing cascade wake)

## Concurrency Tracking

- **eng_dispatches_in_flight**: 0
- **eng_dispatches_max**: 3
- **open_prs**: 5  <!-- #163 #165 #167 #168 #169 — cascade in flight -->
- **open_prs_max**: 5
- **last_product_dispatch_at**: null
- **product_dispatch_interval_min**: 90

## Cost Telemetry

- **spend_estimate_usd**: 0
- **spend_ceiling_usd**: 150
- **cost_alert_at**: 120  <!-- writes SIGNOFFS entry when crossed -->

## Outputs Counter

- **prs_opened**: 0
- **prs_merged**: 0
- **signoffs_pending**: 0
- **backlog_items_total**: 0
- **backlog_items_remaining**: 0

## Last Action Log

```
<cycle>: <iso ts> | <action> | <outcome>
```

(empty until cycle 1)
