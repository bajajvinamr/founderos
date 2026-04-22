-- Migration: 0068_conversations
-- Wave 17E — customer conversation insight v1.
-- Stores pasted/uploaded transcripts plus the LLM-extracted insights so the
-- founder can promote individual bullets into company_memory.

CREATE TABLE IF NOT EXISTS "conversations" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  "title"               text NOT NULL,
  "participants"        text[],
  "source_kind"         text NOT NULL,            -- 'transcript_paste' | 'upload' | 'slack_import'
  "transcript"          text NOT NULL,
  "extraction_status"   text NOT NULL DEFAULT 'pending', -- 'pending' | 'complete' | 'failed'
  "extracted_insights"  jsonb,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "completed_at"        timestamptz
);

CREATE INDEX IF NOT EXISTS "idx_conversations_company_created"
  ON "conversations" ("company_id", "created_at" DESC);
