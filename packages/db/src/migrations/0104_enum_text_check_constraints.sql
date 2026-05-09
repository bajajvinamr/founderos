-- 2026-05-07 — Enum-shaped TEXT CHECK constraints (PR-10)
--
-- Backfills CHECK constraints on enum-shaped TEXT columns that the schema
-- declares with TS unions (`text("col").$type<MyEnum>()`) but where no
-- DB-level constraint enforces the union at runtime.
--
-- Per vinamr-invariants: "TS unions erase at compile time. Raw SQL inserts,
-- manual `psql`, agents bypassing the typed insert path, and migrations
-- all slip arbitrary strings in. CHECK is the runtime backstop."
--
-- AUDIT — gaps closed by this migration (column → values from
-- packages/shared/src/constants.ts):
--   1. plugins.status                       — PLUGIN_STATUSES
--   2. plugin_state.scope_kind              — PLUGIN_STATE_SCOPE_KINDS
--   3. plugin_entities.scope_kind           — PLUGIN_STATE_SCOPE_KINDS
--   4. plugin_jobs.status                   — PLUGIN_JOB_STATUSES
--   5. plugin_job_runs.status               — PLUGIN_JOB_RUN_STATUSES
--   6. plugin_job_runs.trigger              — PLUGIN_JOB_RUN_TRIGGERS
--   7. plugin_webhook_deliveries.status     — PLUGIN_WEBHOOK_DELIVERY_STATUSES
--   8. magic_link_tokens.target_ref_kind    — MAGIC_LINK_TARGET_REF_KINDS
--      (nullable — pair-invariant CHECK on `(purpose, target_ref_kind)`
--      already exists in 0101; this adds value-set enforcement.)
--
-- Columns NOT touched (already have CHECK from prior migrations):
--   - notifications.kind/ref_kind (0100), workflows.template/trigger_kind/
--     status (0087), workflow_runs.status (0087), insights.* (0081),
--     content_drafts.format/status (0088), customer_email_suppressions.*
--     (0093), events.source (0077), magic_link_tokens.purpose (0101),
--     experiments.* (0083), company_memory.category (0099),
--     runner_jobs.status (0085), execution_workspaces.status (0085),
--     issue_relations.type (0049), connector_health.last_sync_status
--     (0079), content_briefs.status (0086).
--
-- LOCK STRATEGY (per vinamr-invariants Postgres rules):
--   - Combine multiple ADD CONSTRAINT into a single ALTER TABLE per table
--     so we acquire ACCESS EXCLUSIVE once and release immediately.
--   - Use NOT VALID + separate VALIDATE CONSTRAINT statements: the ADD
--     skips the table scan (cheap, brief lock); VALIDATE does the scan
--     under ROW SHARE (concurrent writes proceed). This is the escape
--     hatch for potentially-hot tables.
--   - For tables that are tiny or empty (most plugin_* tables today),
--     this is overkill but harmless. The pattern is consistent with
--     future migrations on hotter tables.
--
-- IDEMPOTENCY: Each ADD CONSTRAINT uses an EXISTS check via DO block so
-- reruns are no-ops. (Postgres doesn't support `ADD CONSTRAINT IF NOT
-- EXISTS` for CHECK constraints — the DO block is the canonical
-- idempotent pattern.)
--
-- ROLLBACK:
--   ALTER TABLE plugins                    DROP CONSTRAINT IF EXISTS plugins_status_check;
--   ALTER TABLE plugin_state               DROP CONSTRAINT IF EXISTS plugin_state_scope_kind_check;
--   ALTER TABLE plugin_entities            DROP CONSTRAINT IF EXISTS plugin_entities_scope_kind_check;
--   ALTER TABLE plugin_jobs                DROP CONSTRAINT IF EXISTS plugin_jobs_status_check;
--   ALTER TABLE plugin_job_runs            DROP CONSTRAINT IF EXISTS plugin_job_runs_status_check;
--   ALTER TABLE plugin_job_runs            DROP CONSTRAINT IF EXISTS plugin_job_runs_trigger_check;
--   ALTER TABLE plugin_webhook_deliveries  DROP CONSTRAINT IF EXISTS plugin_webhook_deliveries_status_check;
--   ALTER TABLE magic_link_tokens          DROP CONSTRAINT IF EXISTS magic_link_tokens_target_ref_kind_check;

-- ───── plugins.status ─────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plugins_status_check') THEN
    ALTER TABLE "plugins"
      ADD CONSTRAINT "plugins_status_check"
        CHECK ("status" IN (
          'installed', 'ready', 'disabled', 'error', 'upgrade_pending', 'uninstalled'
        )) NOT VALID;
  END IF;
END$$;
ALTER TABLE "plugins" VALIDATE CONSTRAINT "plugins_status_check";

-- ───── plugin_state.scope_kind ─────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plugin_state_scope_kind_check') THEN
    ALTER TABLE "plugin_state"
      ADD CONSTRAINT "plugin_state_scope_kind_check"
        CHECK ("scope_kind" IN (
          'instance', 'company', 'project', 'project_workspace',
          'agent', 'issue', 'goal', 'run'
        )) NOT VALID;
  END IF;
END$$;
ALTER TABLE "plugin_state" VALIDATE CONSTRAINT "plugin_state_scope_kind_check";

-- ───── plugin_entities.scope_kind ─────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plugin_entities_scope_kind_check') THEN
    ALTER TABLE "plugin_entities"
      ADD CONSTRAINT "plugin_entities_scope_kind_check"
        CHECK ("scope_kind" IN (
          'instance', 'company', 'project', 'project_workspace',
          'agent', 'issue', 'goal', 'run'
        )) NOT VALID;
  END IF;
END$$;
ALTER TABLE "plugin_entities" VALIDATE CONSTRAINT "plugin_entities_scope_kind_check";

-- ───── plugin_jobs.status ─────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plugin_jobs_status_check') THEN
    ALTER TABLE "plugin_jobs"
      ADD CONSTRAINT "plugin_jobs_status_check"
        CHECK ("status" IN ('active', 'paused', 'failed')) NOT VALID;
  END IF;
END$$;
ALTER TABLE "plugin_jobs" VALIDATE CONSTRAINT "plugin_jobs_status_check";

-- ───── plugin_job_runs.status ─────
-- Council R1+R2 (2026-05-07) flagged a partial-idempotency bug in the
-- previous combined-constraint DO block: the EXISTS guard checked only
-- `status_check` but the body created both. If the migration was
-- interrupted after the first ADD succeeded, reruns would skip entirely
-- and leave `trigger_check` un-created (then VALIDATE would fail). Fix:
-- split into two atomic per-constraint DO blocks. Slight cost: two
-- ACCESS EXCLUSIVE locks instead of one, but plugin_job_runs is a small
-- audit log table so this is negligible — and per-constraint atomicity
-- under partial-failure is worth the tradeoff.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plugin_job_runs_status_check') THEN
    ALTER TABLE "plugin_job_runs"
      ADD CONSTRAINT "plugin_job_runs_status_check"
        CHECK ("status" IN (
          'pending', 'queued', 'running', 'succeeded', 'failed', 'cancelled'
        )) NOT VALID;
  END IF;
END$$;
ALTER TABLE "plugin_job_runs" VALIDATE CONSTRAINT "plugin_job_runs_status_check";

-- ───── plugin_job_runs.trigger ─────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plugin_job_runs_trigger_check') THEN
    ALTER TABLE "plugin_job_runs"
      ADD CONSTRAINT "plugin_job_runs_trigger_check"
        CHECK ("trigger" IN ('schedule', 'manual', 'retry')) NOT VALID;
  END IF;
END$$;
ALTER TABLE "plugin_job_runs" VALIDATE CONSTRAINT "plugin_job_runs_trigger_check";

-- ───── plugin_webhook_deliveries.status ─────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plugin_webhook_deliveries_status_check') THEN
    ALTER TABLE "plugin_webhook_deliveries"
      ADD CONSTRAINT "plugin_webhook_deliveries_status_check"
        CHECK ("status" IN ('pending', 'success', 'failed')) NOT VALID;
  END IF;
END$$;
ALTER TABLE "plugin_webhook_deliveries" VALIDATE CONSTRAINT "plugin_webhook_deliveries_status_check";

-- ───── magic_link_tokens.target_ref_kind ─────
-- Nullable column; CHECK allows NULL (matches the existing pair-invariant
-- in 0101 which lets target_ref_kind be NULL when purpose='view_brief').
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'magic_link_tokens_target_ref_kind_check') THEN
    ALTER TABLE "magic_link_tokens"
      ADD CONSTRAINT "magic_link_tokens_target_ref_kind_check"
        CHECK ("target_ref_kind" IS NULL OR "target_ref_kind" IN ('approval')) NOT VALID;
  END IF;
END$$;
ALTER TABLE "magic_link_tokens" VALIDATE CONSTRAINT "magic_link_tokens_target_ref_kind_check";
