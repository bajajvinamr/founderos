-- Migration: 0069_weekly_wraps
-- Wave 18B — Weekly Wrap auto-delivery pipeline.
-- Stores generated weekly wraps so the Friday 5pm cron can produce, persist,
-- and deliver (Slack + email) one wrap per (companyId, weekEndingAt).

CREATE TABLE IF NOT EXISTS "weekly_wraps" (
  "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"               uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  "week_ending_at"           timestamptz NOT NULL,
  "narrative"                text NOT NULL,
  "highlights"               jsonb NOT NULL DEFAULT '[]'::jsonb,
  "metrics"                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  "delivered_to_slack_at"    timestamptz,
  "delivered_to_email_at"    timestamptz,
  "slack_channel_id"         text,
  "created_at"               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_weekly_wraps_company_week"
  ON "weekly_wraps" ("company_id", "week_ending_at" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "weekly_wraps_company_week_unique_idx"
  ON "weekly_wraps" ("company_id", "week_ending_at");
