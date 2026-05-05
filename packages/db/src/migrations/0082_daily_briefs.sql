-- 2026-05-05 — Daily founder briefs table (S3.3)
--
-- LLM-generated daily brief, one row per (company_id, for_date). Idempotent
-- by the UNIQUE index — a re-run for the same date short-circuits the LLM
-- call and returns the existing row.
--
-- The unique index is INLINE in the CREATE TABLE statement (single ALTER
-- lock per FounderOS invariant). Subsequent statement is a CREATE UNIQUE
-- INDEX IF NOT EXISTS, not an ALTER — it acquires a brief share lock on the
-- empty new table only. No multi-ALTER lock acquisition.
--
-- payload jsonb:
--   Validated by Zod at the service boundary (brief-prompt.ts). The DB
--   stores it as opaque JSON; we don't add a CHECK constraint on the
--   structure because the payload schema will evolve faster than DDL —
--   prompt iterations adding/removing fields are common. The Zod parse
--   IS the runtime guard.
--
-- email_sent_at nullable:
--   Stamped by the delivery cron when the email is dispatched. Null until
--   delivered. Re-running the generator does not clear this field — once a
--   brief has been sent for a date, it stays sent.
--
-- FK: ON DELETE CASCADE — briefs are recommendation surface scoped to one
-- company; orphaned briefs are worse than no briefs.
--
-- Idempotency: CREATE TABLE IF NOT EXISTS + CREATE UNIQUE INDEX IF NOT
-- EXISTS. Safe to re-run.
--
-- Rollback:
--   DROP TABLE IF EXISTS "daily_briefs";

CREATE TABLE IF NOT EXISTS "daily_briefs" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"     uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "for_date"       date NOT NULL,
  "payload"        jsonb NOT NULL,
  "generated_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "email_sent_at"  timestamp with time zone
);

CREATE UNIQUE INDEX IF NOT EXISTS "daily_briefs_company_date_idx"
  ON "daily_briefs" ("company_id", "for_date");
