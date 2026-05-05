-- 2026-05-05 — Canonical events table (S2.1)
--
-- Creates the normalized events table that all integration sources write to.
-- Department agents in S3+ query this table with simple filters — no
-- per-integration table joins required.
--
-- Sources: stripe | posthog | linkedin | notion | slack | hubspot
--
-- Deduplication:
--   UNIQUE (company_id, source, source_event_id) NULLS NOT DISTINCT
--   Allows multiple NULL source_event_id rows (sources that don't provide
--   a dedup key) while preventing replays of the same keyed event.
--
-- Indexes:
--   events_company_occurred_at_idx  — range queries by company + time
--   events_source_occurred_at_idx   — per-source time-range scans
--
-- Idempotency:
--   CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS throughout.
--   Safe to re-run; subsequent executions are no-ops.
--
-- Rollback:
--   DROP TABLE IF EXISTS "events";

CREATE TABLE IF NOT EXISTS "events" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"      uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "source"          text NOT NULL,
  "entity_type"     text NOT NULL,
  "event_name"      text NOT NULL,
  "source_event_id" text,
  "occurred_at"     timestamp with time zone NOT NULL,
  "received_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "payload"         jsonb NOT NULL,
  CONSTRAINT "events_source_dedup_unique" UNIQUE NULLS NOT DISTINCT ("company_id", "source", "source_event_id")
);

CREATE INDEX IF NOT EXISTS "events_company_occurred_at_idx"
  ON "events" ("company_id", "occurred_at" DESC);

CREATE INDEX IF NOT EXISTS "events_source_occurred_at_idx"
  ON "events" ("company_id", "source", "occurred_at" DESC);
