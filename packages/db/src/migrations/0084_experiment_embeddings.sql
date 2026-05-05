-- 2026-05-05 — Experiment hypothesis embeddings (S3.6)
--
-- Adds pgvector-backed dedup for the growth-suggester service. When the
-- Growth agent proposes new experiments via LLM, each hypothesis is
-- embedded into a 1536-dim vector (text-embedding-3-small dim, also a
-- common sentence-embedding default). Before insert, we cosine-search
-- against existing `proposed` rows; matches at similarity > 0.85 are
-- discarded as duplicates.
--
-- pgvector availability:
--   Fly Managed Postgres ships pgvector 0.8.0 (verified 2026-05-05). On
--   environments without the extension (PGlite, vanilla Postgres without
--   superuser to install), `CREATE EXTENSION` will fail; tests guard with
--   a runtime probe and `describe.skip` the embedding-dependent cases.
--
-- HNSW index:
--   `vector_cosine_ops` is the right operator class for cosine similarity
--   queries (`1 - (a <=> b)`). HNSW > IVFFlat at our query volume since
--   we read on every proposer run but write on the same cadence — HNSW's
--   build-time cost amortizes over many reads. Defaults (m=16, ef=64) are
--   fine for an experiments table that won't exceed O(10K) rows per
--   workspace.
--
-- Lock semantics:
--   `ALTER TABLE` takes ACCESS EXCLUSIVE. Single ALTER statement, single
--   lock acquisition. Index creation is a separate concurrent-safe
--   operation but we use plain `CREATE INDEX` (not CONCURRENTLY) because
--   the table is empty / sparse during this migration window.
--
-- Idempotency: CREATE EXTENSION IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS — safe to re-run.
--
-- Rollback:
--   DROP INDEX IF EXISTS "experiments_hypothesis_embedding_idx";
--   ALTER TABLE "experiments" DROP COLUMN IF EXISTS "hypothesis_embedding";

-- Try to load pgvector. If unavailable (e.g. PGlite, vanilla Postgres
-- without the extension binary on disk), skip silently — the column +
-- index are then also skipped, and the growth-suggester service falls
-- back to a sha256(hypothesis text) string-equality dedup path.
DO $pgvector_install$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION
  WHEN feature_not_supported THEN
    RAISE NOTICE 'pgvector extension not available — embedding column will be skipped';
  WHEN undefined_file THEN
    RAISE NOTICE 'pgvector extension binary not on share/extension/ — embedding column will be skipped';
  WHEN OTHERS THEN
    RAISE NOTICE 'pgvector extension load failed (%); embedding column will be skipped', SQLERRM;
END
$pgvector_install$;

-- Add the column. When the `vector` type is reachable, use it (prod path
-- — Fly MPG, dev Postgres with extension installed). Otherwise use `text`
-- as a placeholder so the Drizzle schema reference still resolves; the
-- service writes NULL and the dedup gate falls back to a sha256-text
-- string-equality path. This keeps the column shape uniform across
-- environments — selects and inserts that name `hypothesis_embedding`
-- compile and execute against either type.
DO $add_column$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') THEN
    EXECUTE 'ALTER TABLE "experiments" ADD COLUMN IF NOT EXISTS "hypothesis_embedding" vector(1536)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "experiments_hypothesis_embedding_idx" ON "experiments" USING hnsw ("hypothesis_embedding" vector_cosine_ops)';
  ELSE
    RAISE NOTICE 'vector type missing — falling back to text placeholder (no embedding-cosine dedup)';
    EXECUTE 'ALTER TABLE "experiments" ADD COLUMN IF NOT EXISTS "hypothesis_embedding" text';
  END IF;
END
$add_column$;
