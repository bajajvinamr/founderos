-- Migration: 0061_integration_data
-- Creates the integration_data table for caching data fetched from external
-- integrations (e.g. PostHog funnel metrics, UTM breakdown).

CREATE TABLE IF NOT EXISTS "integration_data" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  "integration_id"  uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  "kind"            text NOT NULL,
  "payload"         jsonb NOT NULL,
  "fetched_at"      timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("company_id", "integration_id", "kind")
);

CREATE INDEX IF NOT EXISTS "idx_integration_data_company_kind"
  ON "integration_data" ("company_id", "kind");
