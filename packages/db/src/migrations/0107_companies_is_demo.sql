-- 0107_companies_is_demo.sql — P0 audit finding #5 (2026-05-09)
--
-- Adds `companies.is_demo` so seed-demo rows (placeholders that ship with the
-- distribution: Acme Robotics, Beta Labs, Demo Corp) can be cleanly identified,
-- filtered out of real metrics, and purged on demand.
--
-- Background:
--   The seed-demo* scripts inserted three real-named portfolio companies into
--   any DATABASE_URL the script was pointed at. Per CLAUDE.md's "Synthetic
--   data must be documented and confirmed with client" rule, that's a
--   buyer-trust hazard.
--
-- This column is the structural backstop:
--   - `seed-demo*` scripts INSERT with is_demo = true
--   - Production rows default to false
--   - Ops can `DELETE FROM companies WHERE is_demo = true` to purge demo data
--   - Future analytics / billing / dashboards can filter demo rows out
--
-- Single-statement ALTER per the hot-table-safe lock invariant
-- (vinamr-invariants.staging.md, "Postgres" section): one ACCESS EXCLUSIVE
-- lock acquisition rather than two. NOT NULL DEFAULT false back-fills every
-- existing row with `false`, which is the safe default — real customer rows
-- are never demo.

ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "is_demo" boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN "companies"."is_demo" IS
  'TRUE for rows inserted by packages/db/src/seed-demo*.ts. Buyer-trust backstop: lets ops queries filter, count, or purge demo data unambiguously. Default FALSE. NEVER mutate for real customer rows. See P0 audit finding #5 (2026-05-09).';
