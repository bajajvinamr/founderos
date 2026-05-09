-- 2026-05-07 · S7.0.1 — Add adapter_type to runner_jobs
--
-- Council R1+R2 P1 (Codex + Gemini, both rounds, FOUNDEROS PHASE-S7):
-- the runner cannot dispatch on adapter_type because runner_jobs has no
-- such column today. The enqueue path writes nothing; the claim API
-- returns nothing. Without this column, S7.1's dispatcher refactor has
-- nothing to dispatch on.
--
-- Default 'claude_local' preserves current production behavior. Existing
-- prod rows (all claude today) get the safe default; no backfill needed.
--
-- CHECK constraint mirrors AGENT_ADAPTER_TYPES from
-- packages/shared/src/constants.ts plus the legacy 'byo_runner' value
-- written by server/src/services/onboarding-bootstrap.ts:307 today.
-- Per vinamr-invariants: "TS unions erase at compile time. CHECK is the
-- runtime backstop." NOT VALID + VALIDATE is the hot-table-safe pattern.

ALTER TABLE "runner_jobs"
  ADD COLUMN IF NOT EXISTS "adapter_type" TEXT NOT NULL DEFAULT 'claude_local';

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
        'cursor',
        'openclaw_gateway',
        'hermes_local',
        'byo_runner'
      )) NOT VALID;
    ALTER TABLE "runner_jobs" VALIDATE CONSTRAINT "runner_jobs_adapter_type_check";
  END IF;
END $$;

-- Index supports operational queries like "show me all queued jobs by adapter"
-- which the multi-CLI runner pool will need post-S7. Cheap to add now.
CREATE INDEX IF NOT EXISTS "runner_jobs_adapter_type_idx"
  ON "runner_jobs" ("adapter_type");
