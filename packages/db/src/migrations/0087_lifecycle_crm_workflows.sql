-- 2026-05-05 — Lifecycle CRM workflow registry (S4.5, idx=84)
--
-- Council-flagged ticket. This migration is intentionally over-specified in
-- comments because council will review the RBAC and autonomy-gate decisions.
--
-- CRITICAL DESIGN DECISIONS (for council review):
--
--   1. autonomy_level default = 2 (draft), NOT 4 (autonomous).
--      No customer-facing mutation fires without a human in the loop unless
--      the founder explicitly sets autonomy_level=4 AND the instance-level
--      flag `lifecycle_crm.allow_autonomous_email` is true. The DB default
--      is the last line of defence; if application code ever fails to set the
--      field, the row is safe.
--
--   2. Composite FK pattern (same as 0085_tenant_invariants.sql).
--      workflow_runs.company_id is denormalised alongside workflow_id so
--      we can assert FOREIGN KEY (workflow_id, company_id) REFERENCES
--      workflows (id, company_id). This ensures a row in workflow_runs cannot
--      reference a workflow belonging to a different tenant by forging the
--      workflow_id alone.
--
--   3. CHECK constraints on every enum-shaped text column.
--      TS union types erase at runtime. Without these, a raw-SQL INSERT or
--      a future migration writer can slip arbitrary strings in with no error.
--      New template/status values MUST update both the TypeScript constants
--      AND the CHECK expression.
--
--   4. autonomy_level is CHECK-constrained to 1..4 at the DB layer.
--      Application code must enforce the additional business rule (autonomy=4
--      requires instance opt-in), but the DB ensures no value outside the
--      valid range ever lands.
--
--   5. workflows(id, company_id) composite UNIQUE is created BEFORE the FK
--      in workflow_runs — Postgres validates referential integrity at
--      constraint-create time.
--
--   6. Each ALTER TABLE combines all clauses to acquire ACCESS EXCLUSIVE once
--      per table (per vinamr-invariants Postgres entry 2026-05-05).
--
-- Rollback:
--   ALTER TABLE "workflow_runs" DROP CONSTRAINT IF EXISTS "workflow_runs_workflow_id_company_id_workflows_id_company_id_fk";
--   ALTER TABLE "workflow_runs" DROP CONSTRAINT IF EXISTS "workflow_runs_status_check";
--   ALTER TABLE "workflows" DROP CONSTRAINT IF EXISTS "workflows_id_company_id_uq";
--   ALTER TABLE "workflows" DROP CONSTRAINT IF EXISTS "workflows_template_check";
--   ALTER TABLE "workflows" DROP CONSTRAINT IF EXISTS "workflows_trigger_kind_check";
--   ALTER TABLE "workflows" DROP CONSTRAINT IF EXISTS "workflows_status_check";
--   ALTER TABLE "workflows" DROP CONSTRAINT IF EXISTS "workflows_autonomy_level_check";
--   DROP TABLE IF EXISTS "workflow_runs";
--   DROP TABLE IF EXISTS "workflows";

--------------------------------------------------------------------------
-- Phase 1: Create workflows table
--------------------------------------------------------------------------

CREATE TABLE "workflows" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"    uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "name"          text NOT NULL,
  "template"      text NOT NULL,
  "trigger_kind"  text NOT NULL,
  "trigger_spec"  jsonb NOT NULL,
  "autonomy_level" integer NOT NULL DEFAULT 2,
  "status"        text NOT NULL DEFAULT 'draft',
  "config"        jsonb NOT NULL DEFAULT '{}',
  "last_run_at"   timestamptz,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

--------------------------------------------------------------------------
-- Phase 2: CHECK constraints + composite UNIQUE on workflows
--   Combined into one ALTER TABLE to hold ACCESS EXCLUSIVE once.
--------------------------------------------------------------------------

ALTER TABLE "workflows"
  ADD CONSTRAINT "workflows_template_check"
    CHECK ("template" IN (
      'onboarding-emails',
      'activation-nudge',
      'churn-rescue',
      'upsell'
    )),
  ADD CONSTRAINT "workflows_trigger_kind_check"
    CHECK ("trigger_kind" IN ('event', 'schedule', 'manual')),
  ADD CONSTRAINT "workflows_status_check"
    CHECK ("status" IN ('draft', 'active', 'paused')),
  ADD CONSTRAINT "workflows_autonomy_level_check"
    CHECK ("autonomy_level" BETWEEN 1 AND 4),
  ADD CONSTRAINT "workflows_id_company_id_uq"
    UNIQUE ("id", "company_id");
--> statement-breakpoint

--------------------------------------------------------------------------
-- Phase 3: Indexes on workflows
--------------------------------------------------------------------------

CREATE INDEX "workflows_company_status_idx"   ON "workflows" ("company_id", "status");
--> statement-breakpoint
CREATE INDEX "workflows_company_template_idx" ON "workflows" ("company_id", "template");
--> statement-breakpoint
-- uniqueIndex for (id, company_id) is handled by the UNIQUE constraint above.

--------------------------------------------------------------------------
-- Phase 4: Create workflow_runs table
--------------------------------------------------------------------------

CREATE TABLE "workflow_runs" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_id"     uuid NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "company_id"      uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "status"          text NOT NULL DEFAULT 'running',
  "triggered_by"    jsonb NOT NULL,
  "actions"         jsonb NOT NULL DEFAULT '[]',
  "metric_snapshot" jsonb,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "completed_at"    timestamptz
);
--> statement-breakpoint

--------------------------------------------------------------------------
-- Phase 5: CHECK + composite FK on workflow_runs
--   Combined into one ALTER TABLE.
--------------------------------------------------------------------------

ALTER TABLE "workflow_runs"
  ADD CONSTRAINT "workflow_runs_status_check"
    CHECK ("status" IN (
      'pending_approval',
      'running',
      'completed',
      'failed',
      'cancelled'
    )),
  ADD CONSTRAINT "workflow_runs_workflow_id_company_id_workflows_id_company_id_fk"
    FOREIGN KEY ("workflow_id", "company_id")
    REFERENCES "workflows" ("id", "company_id")
    ON DELETE CASCADE;
--> statement-breakpoint

--------------------------------------------------------------------------
-- Phase 6: Indexes on workflow_runs
--------------------------------------------------------------------------

CREATE INDEX "workflow_runs_workflow_id_idx"    ON "workflow_runs" ("workflow_id");
--> statement-breakpoint
CREATE INDEX "workflow_runs_company_status_idx" ON "workflow_runs" ("company_id", "status");
--> statement-breakpoint
CREATE INDEX "workflow_runs_company_created_idx" ON "workflow_runs" ("company_id", "created_at" DESC);
