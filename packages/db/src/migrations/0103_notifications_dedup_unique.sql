-- 2026-05-07 — Notifications dedup partial unique (PR-3, council-revised)
--
-- Closes a TOCTOU window in `services/notifications.ts:create()`. The
-- pre-PR code did SELECT-then-INSERT to dedup duplicate notifications
-- about the same target — two concurrent workers could both pass the
-- SELECT and both INSERT.
--
-- COUNCIL REVIEW (2026-05-07, R1+R2 converged, both Codex + Gemini):
--   1. P1 — `company_id` MUST be in the dedup key. user_id is globally
--      unique (Better-Auth text id), but ref_id is free-form text and a
--      cross-tenant collision (e.g. shared local-id) would silently dedup
--      a Company-A alert against a Company-B unread row. Existing test
--      `notifications.test.ts:475` ("cross-tenant access → 403") and the
--      data model both require company-scoped notifications.
--   2. P1 — Migration MUST be self-healing. The pre-fix TOCTOU window may
--      have produced duplicate unread rows already (this migration would
--      fail on `CREATE UNIQUE INDEX` against existing dups, bricking the
--      deploy). We pre-cleanup with a deterministic "keep most recent per
--      dedup key, delete the rest" pass. Verified prod has 0 notifications
--      today (2026-05-07) so this is defensive — but dev/replay scenarios
--      may have dups.
--   3. P3 — Service code uses explicit `where:` in `.onConflictDoNothing()`
--      to target only this partial index (handled in services/notifications.ts).
--
-- DEDUP KEY: (company_id, user_id, kind, ref_kind, ref_id)
--   Filtered to ref_kind/ref_id non-null + read_at null.
--
-- LOCK SEMANTICS: CREATE UNIQUE INDEX without CONCURRENTLY acquires SHARE
-- on the table — fast for current empty/small table. If this gets replayed
-- against a hot table (>10k rows), switch to a separate non-transactional
-- migration with CREATE UNIQUE INDEX CONCURRENTLY.
--
-- IDEMPOTENCY: Pre-cleanup uses a CTE that always evaluates to "keep
-- max(created_at) per dedup group, delete others" — running twice is a
-- no-op (no duplicates left after first run). CREATE UNIQUE INDEX
-- IF NOT EXISTS skips on rerun.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS "uniq_notifications_unread_dedup";
--   (Pre-cleanup is destructive — already-deleted duplicate unread rows
--    are not recoverable. Rollback only removes the constraint, not the
--    cleanup. This is acceptable: duplicates were never load-bearing.)

-- ───── Step 1: pre-cleanup duplicate unread rows ─────
-- Keep the most recently created row per (company_id, user_id, kind, ref_kind,
-- ref_id) tuple where read_at IS NULL and ref pair is set; delete the rest.
-- The `created_at, id` ordering tiebreaks deterministically.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY company_id, user_id, kind, ref_kind, ref_id
      ORDER BY created_at DESC, id DESC
    ) AS rn
  FROM "notifications"
  WHERE read_at IS NULL
    AND ref_kind IS NOT NULL
    AND ref_id IS NOT NULL
)
DELETE FROM "notifications"
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- ───── Step 2: create partial unique index ─────
-- Dedup key: (company_id, user_id, kind, ref_kind, ref_id) where unread + ref-set.
-- Allows re-fire after read (read_at NOT NULL rows fall outside the partial).
-- Allows multiple ref-less notifications (system broadcasts) per user.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_notifications_unread_dedup"
  ON "notifications" ("company_id", "user_id", "kind", "ref_kind", "ref_id")
  WHERE "read_at" IS NULL
    AND "ref_kind" IS NOT NULL
    AND "ref_id" IS NOT NULL;
