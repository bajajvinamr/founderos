-- Migration: 0059_integrations
-- Creates the company-scoped integrations table for external tool connections.

CREATE TABLE IF NOT EXISTS "integrations" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"       uuid NOT NULL,
  "kind"             text NOT NULL,
  "status"           text NOT NULL DEFAULT 'disconnected',
  "key_hint"         text,
  "encrypted_api_key" text,
  "config"           jsonb,
  "last_error"       text,
  "connected_at"     timestamptz,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "integrations_company_kind_idx"
  ON "integrations" ("company_id", "kind");
