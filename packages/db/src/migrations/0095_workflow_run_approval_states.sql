-- 0095_workflow_run_approval_states.sql — S4.8 prerequisite #194.
--
-- Extends workflow_runs.status enum to support the approval state machine:
--   pending_approval → approved (transient) → completed | failed
--   pending_approval → rejected (terminal)
--
-- Implementation: drop + re-add the CHECK with the expanded set. This is
-- per-statement ACCESS EXCLUSIVE; the table is small (per tenant) and the
-- lock window is sub-second on real workloads. No data migration required —
-- existing rows have status in {pending_approval, running, completed, failed,
-- cancelled} which all remain in the new set.

ALTER TABLE "workflow_runs"
  DROP CONSTRAINT IF EXISTS "workflow_runs_status_check";--> statement-breakpoint

ALTER TABLE "workflow_runs"
  ADD CONSTRAINT "workflow_runs_status_check"
    CHECK ("status" IN (
      'pending_approval',
      'running',
      'approved',
      'rejected',
      'completed',
      'failed',
      'cancelled'
    ));
