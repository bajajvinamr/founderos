-- 0098_approvals_workflow_run.sql — S6.2 approval engine refinement.
--
-- Adds `workflow_run_id` (nullable FK) to `approvals`. When an approval
-- row is created in the context of a workflow run, this column links
-- the two so the UI can render "see full plan" against the workflow's
-- step tree instead of just the bare action payload.
--
-- Why nullable: the approvals table is generic — most rows (hire decisions,
-- budget overrides, plugin installs) have no workflow context. Adding a
-- non-NULL constraint would break those rows. ON DELETE SET NULL because
-- a deleted workflow_run shouldn't cascade-nuke the approval audit trail.
--
-- All clauses combined into a single ALTER TABLE so ACCESS EXCLUSIVE is
-- acquired once (vinamr-invariants pattern: avoid multi-statement ALTER
-- TABLE chains on hot tables).

ALTER TABLE "approvals"
  ADD COLUMN "workflow_run_id" uuid,
  ADD CONSTRAINT "approvals_workflow_run_id_fk"
    FOREIGN KEY ("workflow_run_id")
    REFERENCES "workflow_runs"("id")
    ON DELETE SET NULL;--> statement-breakpoint

-- Index for the common UI query: "show me all approvals for this workflow
-- run." Partial index on non-null values keeps the index small (most
-- approval rows do NOT have a workflow_run_id).
CREATE INDEX "approvals_workflow_run_id_idx"
  ON "approvals" ("workflow_run_id")
  WHERE "workflow_run_id" IS NOT NULL;
