-- 2026-05-07 · S7.0.4 — Rename adapter_type 'cursor' → 'cursor_local'
--
-- Per PHASE-S7 plan + council R1 P2 (Codex): the cursor-local adapter
-- package was the lone outlier in the adapter-type enum, exporting
-- `type = "cursor"` while every other CLI in AGENT_ADAPTER_TYPES uses
-- the `<name>_local` family pattern (claude_local, codex_local,
-- gemini_local, opencode_local, pi_local, hermes_local). S7.0.4
-- normalizes the name before any S7.B wiring touches it.
--
-- Steps:
--   1. Update any existing runner_jobs / agents rows from 'cursor' to
--      'cursor_local'. Pre-prod expects zero such rows; this UPDATE is
--      defense-in-depth.
--   2. Drop the old CHECK constraint on runner_jobs.adapter_type
--      (added in migration 0105) so we can rebuild it with the new
--      enum list.
--   3. Re-add the CHECK constraint with 'cursor' replaced by
--      'cursor_local'. NOT VALID + VALIDATE per
--      vinamr-invariants hot-table-safe lock pattern.
--
-- agents.adapter_type currently has no CHECK constraint, so the row
-- migration is sufficient there. (Adding a CHECK constraint to that
-- table is a separate prerequisite hardening task — out of scope for
-- S7.0.)

-- Step 1: migrate existing rows ────────────────────────────────────────
UPDATE "runner_jobs"
   SET "adapter_type" = 'cursor_local'
 WHERE "adapter_type" = 'cursor';

UPDATE "agents"
   SET "adapter_type" = 'cursor_local'
 WHERE "adapter_type" = 'cursor';

-- Step 2: drop the old CHECK constraint (idempotent) ───────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runner_jobs_adapter_type_check'
      AND conrelid = '"runner_jobs"'::regclass
  ) THEN
    ALTER TABLE "runner_jobs"
      DROP CONSTRAINT "runner_jobs_adapter_type_check";
  END IF;
END $$;

-- Step 3: re-add CHECK with the new enum list ──────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runner_jobs_adapter_type_check'
      AND conrelid = '"runner_jobs"'::regclass
  ) THEN
    ALTER TABLE "runner_jobs"
      ADD CONSTRAINT "runner_jobs_adapter_type_check"
      CHECK ("adapter_type" IN (
        'process',
        'http',
        'claude_local',
        'codex_local',
        'gemini_local',
        'opencode_local',
        'pi_local',
        'cursor_local',
        'openclaw_gateway',
        'hermes_local',
        'byo_runner'
      )) NOT VALID;
    ALTER TABLE "runner_jobs" VALIDATE CONSTRAINT "runner_jobs_adapter_type_check";
  END IF;
END $$;
