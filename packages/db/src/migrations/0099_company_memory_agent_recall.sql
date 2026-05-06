-- 2026-05-06 — Agent memory schema (S6.4)
--
-- Extends `company_memory` to support agent semantic recall:
--   1. `category` text + CHECK constraint — semantic grouping orthogonal to
--      `kind`. Where `kind` says "this came from a weekly summary", `category`
--      says "this is a decision the company made" (decision/pattern/context/
--      outcome). Lets agents query "show me past DECISIONS in this domain"
--      independently of which routine produced them.
--   2. `embedding vector(1536)` — text-embedding-3-small dim, used for cosine
--      similarity recall ("what past memory is relevant to this prompt?").
--      Same pgvector availability gate as 0084_experiment_embeddings.
--   3. `expires_at timestamptz NULL` — TTL for time-sensitive memory. NULL =
--      no expiry (default). Indexed via partial index (only non-null rows)
--      since the typical row has no expiry.
--
-- pgvector availability: same gate as 0084 — Fly Managed Postgres ships
-- pgvector 0.8.0; PGlite/vanilla-PG environments fall back silently to a
-- text placeholder column and the agent recall path skips cosine search.
--
-- Lock semantics: single ALTER TABLE acquires ACCESS EXCLUSIVE once.
--   ADD COLUMN IF NOT EXISTS keeps the migration idempotent.
--
-- CHECK constraint as enum backstop: `category` is text rather than a
-- pg_enum so we can extend the value set without ALTER TYPE downtime, but
-- the CHECK constraint enforces the closed set at the DB layer (per
-- vinamr-invariants — TS unions erase at compile time, raw SQL inserts and
-- migrations bypass them).
--
-- Idempotency: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, named
-- CHECK constraint guarded by NOT EXISTS lookup.
--
-- Rollback:
--   DROP INDEX IF EXISTS "idx_company_memory_expires_at";
--   DROP INDEX IF EXISTS "idx_company_memory_category";
--   DROP INDEX IF EXISTS "company_memory_embedding_idx";
--   ALTER TABLE "company_memory"
--     DROP CONSTRAINT IF EXISTS "company_memory_category_check",
--     DROP COLUMN IF EXISTS "category",
--     DROP COLUMN IF EXISTS "embedding",
--     DROP COLUMN IF EXISTS "expires_at";

-- Try to load pgvector. If unavailable, skip silently — embedding column
-- becomes text placeholder; agent recall falls back to keyword/topic match.
DO $pgvector_install$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION
  WHEN feature_not_supported THEN
    RAISE NOTICE 'pgvector extension not available — embedding column will be a text placeholder';
  WHEN undefined_file THEN
    RAISE NOTICE 'pgvector extension binary missing — embedding column will be a text placeholder';
  WHEN OTHERS THEN
    RAISE NOTICE 'pgvector extension load failed (%); embedding column will be a text placeholder', SQLERRM;
END
$pgvector_install$;

-- Single ALTER for category + expires_at (single ACCESS EXCLUSIVE lock).
ALTER TABLE "company_memory"
  ADD COLUMN IF NOT EXISTS "category" text,
  ADD COLUMN IF NOT EXISTS "expires_at" timestamptz;

-- CHECK constraint on category — closed-set enum backstop.
DO $check_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'company_memory_category_check'
  ) THEN
    ALTER TABLE "company_memory"
      ADD CONSTRAINT "company_memory_category_check"
      CHECK ("category" IS NULL OR "category" IN (
        'decision', 'pattern', 'context', 'outcome'
      ));
  END IF;
END
$check_constraint$;

-- Embedding column — vector(1536) when pgvector is loaded, text fallback otherwise.
DO $embedding_column$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') THEN
    EXECUTE 'ALTER TABLE "company_memory" ADD COLUMN IF NOT EXISTS "embedding" vector(1536)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "company_memory_embedding_idx" ON "company_memory" USING hnsw ("embedding" vector_cosine_ops)';
  ELSE
    RAISE NOTICE 'vector type missing — embedding column falls back to text';
    EXECUTE 'ALTER TABLE "company_memory" ADD COLUMN IF NOT EXISTS "embedding" text';
  END IF;
END
$embedding_column$;

-- Partial index on expires_at — most rows have no expiry, so the index
-- only carries rows where TTL applies (cheap and fast for the cleanup query).
CREATE INDEX IF NOT EXISTS "idx_company_memory_expires_at"
  ON "company_memory" ("expires_at")
  WHERE "expires_at" IS NOT NULL;

-- Index on (company_id, category) for the agent recall query path:
--   "show me past DECISIONS for this company" or
--   "show me past PATTERNS for this company".
CREATE INDEX IF NOT EXISTS "idx_company_memory_company_category"
  ON "company_memory" ("company_id", "category")
  WHERE "category" IS NOT NULL;
