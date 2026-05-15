-- 0109_mira_labs_is_demo_guard.sql — TD-1 Mira Labs dogfood seed (2026-05-13)
--
-- Two additive changes:
--
-- 1. ADD COLUMN companies.metadata (JSONB, nullable, DEFAULT NULL)
--    Stores per-company persona/dogfood metadata. The Mira Labs dogfood
--    persona uses metadata->>'persona' = 'mira-labs-dogfood' as the
--    stable identity key for idempotency checks and the is_demo guard.
--    Nullable so existing rows are unaffected. Future non-persona use
--    (e.g., onboarding flags, white-label config) can safely piggyback.
--
-- 2. CREATE FUNCTION + TRIGGER: reject_mira_labs_is_demo_flip
--    Guards the WRITE path: any UPDATE that sets companies.is_demo = true
--    on a row where metadata->>'persona' = 'mira-labs-dogfood' is rejected
--    with a clear EXCEPTION. This is the DB-level backstop that prevents
--    future admin sweeps ("set is_demo = true on all demo-ish rows") from
--    clobbering the Mira Labs dogfood persona silently.
--
--    Design: DB trigger preferred over application-layer check per
--    vinamr-invariants.md "events.source CHECK constraint" pattern.
--    Application code can be bypassed (raw SQL, agents, migrations);
--    the trigger cannot.
--
-- Lock semantics:
--    ALTER TABLE ADD COLUMN IF NOT EXISTS is a single ACCESS EXCLUSIVE
--    lock acquisition (per the hot-table lock invariant in
--    vinamr-invariants.staging.md). The column is nullable with no DEFAULT
--    that would require a table rewrite, so the lock is held for milliseconds.
--    CREATE FUNCTION and CREATE TRIGGER do NOT acquire row-level locks on
--    companies; they are DDL-only on the trigger catalog.
--
-- Rollback:
--    DROP TRIGGER IF EXISTS mira_labs_is_demo_guard ON companies;
--    DROP FUNCTION IF EXISTS reject_mira_labs_is_demo_flip();
--    ALTER TABLE companies DROP COLUMN IF EXISTS metadata;

-- Step 1: Add metadata JSONB column to companies (additive, nullable).
ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "metadata" jsonb;

COMMENT ON COLUMN "companies"."metadata" IS
  'Per-company persona / dogfood metadata. Mira Labs sets metadata->>''persona'' = ''mira-labs-dogfood''. '
  'Used for idempotency checks in seed scripts and the is_demo trigger guard. '
  'Nullable — existing rows are unaffected. See TD-1 (2026-05-13).';

-- Step 2: Function that rejects is_demo = true on mira-labs-dogfood rows.
CREATE OR REPLACE FUNCTION reject_mira_labs_is_demo_flip()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_demo = true
     AND (OLD.metadata->>'persona') = 'mira-labs-dogfood' THEN
    RAISE EXCEPTION
      'Cannot set is_demo=true on mira-labs-dogfood persona company (id=%)',
      NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

-- Step 3: Attach trigger.
-- DROP IF EXISTS + CREATE ensures idempotency on re-runs (e.g., CI migration
-- replay). BEFORE UPDATE so the reject fires before the row is written.
DROP TRIGGER IF EXISTS mira_labs_is_demo_guard ON "companies";

CREATE TRIGGER mira_labs_is_demo_guard
  BEFORE UPDATE ON "companies"
  FOR EACH ROW
  EXECUTE FUNCTION reject_mira_labs_is_demo_flip();
