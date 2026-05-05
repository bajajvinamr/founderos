-- 2026-05-05 — Canonical events table (S2.1)
--
-- Creates the normalized events table that all integration sources write to.
-- Department agents in S3+ query this table with simple filters — no
-- per-integration table joins required.
--
-- Sources: stripe | posthog | linkedin | notion | slack | hubspot
--
-- Deduplication:
--   UNIQUE (company_id, source, dedup_key)
--   dedup_key is NOT NULL — callers MUST construct a key for every event.
--   When the source provides a natural ID (Stripe event id, PostHog uuid),
--   use it directly. When it doesn't (Slack messages, custom events),
--   synthesize one (e.g. hash of channel+ts+user). This avoids the silent
--   collapse that NULLS NOT DISTINCT would cause when paired with the
--   service's ON CONFLICT DO NOTHING semantics — a null-keyed second event
--   for the same (company,source) would dedup to the first row instead of
--   inserting, with no error surfaced to the caller.
--
-- Source enum (DB-level CHECK):
--   CHECK ("source" IN ('stripe','posthog','linkedin','notion','slack','hubspot'))
--   Catches typos / future drift at the DB layer regardless of caller path
--   (raw SQL, ORM bypass, future migrations). Drizzle's $type<EventSource>()
--   only enforces at TS compile time — types are erased at runtime.
--
-- Foreign key:
--   ON DELETE RESTRICT — events are audit/billing/incident-forensics data.
--   Deleting a company should NOT silently wipe its event history; the app
--   must explicitly handle event retention via a soft-delete or archive
--   flow on companies (out of scope for this migration).
--
-- Indexes:
--   events_company_occurred_at_idx  — range queries by company + time
--                                     (the (company_id, source, ts) index
--                                     does NOT subsume this for company-wide
--                                     ORDER BY ts queries — source breaks
--                                     the global time ordering)
--   events_source_occurred_at_idx   — per-source time-range scans
--
-- Idempotency:
--   CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS throughout.
--   Safe to re-run; subsequent executions are no-ops.
--
-- Rollback:
--   DROP TABLE IF EXISTS "events";

CREATE TABLE IF NOT EXISTS "events" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"   uuid NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "source"       text NOT NULL,
  "entity_type"  text NOT NULL,
  "event_name"   text NOT NULL,
  "dedup_key"    text NOT NULL,
  "occurred_at"  timestamp with time zone NOT NULL,
  "received_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "payload"      jsonb NOT NULL,
  CONSTRAINT "events_source_check"
    CHECK ("source" IN ('stripe','posthog','linkedin','notion','slack','hubspot')),
  CONSTRAINT "events_dedup_unique"
    UNIQUE ("company_id", "source", "dedup_key")
);

CREATE INDEX IF NOT EXISTS "events_company_occurred_at_idx"
  ON "events" ("company_id", "occurred_at" DESC);

CREATE INDEX IF NOT EXISTS "events_source_occurred_at_idx"
  ON "events" ("company_id", "source", "occurred_at" DESC);
