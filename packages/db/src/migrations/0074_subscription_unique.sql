-- 2026-05-04 — Stripe webhook idempotency
--
-- Pre-fix bug: services/subscription.ts used `onConflictDoUpdate({ target:
-- [instanceSubscription.id] })`. The `id` column is `defaultRandom()`, so
-- every Stripe retry generated a new UUID — the conflict NEVER fired and
-- every retry inserted a duplicate row. With Stripe's documented retry
-- behavior (up to 3 days, exponential backoff) a single subscription
-- could accumulate dozens of rows for the same Stripe subscription id.
--
-- Fix:
--   1. Dedupe existing rows: keep the most recently updated row per
--      (stripe_subscription_id) and delete the rest.
--   2. Add UNIQUE constraint on stripe_subscription_id (NULLs allowed —
--      a row with no stripe id yet is valid; PostgreSQL treats NULL as
--      "not equal to anything" for UNIQUE so multiple NULLs coexist).
--   3. Application code switches `onConflictDoUpdate` target to
--      `stripeSubscriptionId` and filters out NULLs (defensive).
--
-- Rollback: drop the unique constraint. The dedupe is non-reversible —
-- which is fine, the deleted rows were duplicates with no business value.

-- ── Step 1: Dedupe ────────────────────────────────────────────────────
-- Keep the row with the latest updated_at per stripe_subscription_id.
-- Rows with NULL stripe_subscription_id are left alone — they predate
-- a successful checkout and may represent legitimate placeholder rows.
DELETE FROM "instance_subscription"
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY stripe_subscription_id
        ORDER BY updated_at DESC, created_at DESC
      ) AS rn
    FROM "instance_subscription"
    WHERE stripe_subscription_id IS NOT NULL
  ) ranked
  WHERE ranked.rn > 1
);

-- ── Step 2: Add UNIQUE constraint ─────────────────────────────────────
ALTER TABLE "instance_subscription"
ADD CONSTRAINT "instance_subscription_stripe_subscription_id_unique"
UNIQUE ("stripe_subscription_id");
