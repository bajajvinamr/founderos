-- Migration: 0060_company_memory
-- Creates the company_memory table for storing reusable intelligence entries
-- (weekly summaries, experiment outcomes, founder notes, milestones).

CREATE TABLE IF NOT EXISTS "company_memory" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  "kind"         text NOT NULL,
  "title"        text NOT NULL,
  "body"         text NOT NULL,
  "topic"        text,
  "occurred_at"  timestamptz NOT NULL,
  "pinned"       boolean NOT NULL DEFAULT false,
  "source"       text NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_company_memory_company_occurred"
  ON "company_memory" ("company_id", "occurred_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_company_memory_pinned"
  ON "company_memory" ("company_id", "pinned")
  WHERE pinned = true;
