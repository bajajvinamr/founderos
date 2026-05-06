-- 2026-05-05 — Experiments ledger (S3.5)
--
-- Adds the cross-department experiments table (growth, content, crm, finance,
-- chief-of-staff). Departments propose ICE-scored hypotheses, mark them
-- running, then resolve to completed | abandoned. The Growth Console renders
-- this directly; future department consoles read the same table filtered by
-- department.
--
-- ICE math:
--   ice_score is STORED generated: (impact * confidence * ease)::real / 10.
--   STORED (not VIRTUAL) so reads are O(1) and indexable; the trade-off is a
--   row rewrite on every component update, which is acceptable for a low-
--   write table where we sort by score on every list call.
--
-- Range + enum CHECKs at the DB layer:
--   ice_impact / ice_confidence / ice_ease — bounded to 1..10. ICE breaks
--   down outside that band (a 0 zeros the score; >10 inflates it past the
--   100 ceiling all UIs assume). Reject at the DB so a raw SQL writer or
--   agent-generated migration can't slip through.
--
--   department / status / channel CHECKs back the TypeScript unions because
--   $type<...>() is erased at runtime. CHECK fires regardless of caller path
--   (Drizzle insert, raw SQL, future migrations).
--
-- All CHECK constraints inline in the CREATE TABLE so we take ACCESS
-- EXCLUSIVE exactly once during release_command — no ALTER TABLE roundtrips.
-- (Per FounderOS invariant: minimize lock acquisitions on first-class tables.)
--
-- ON DELETE CASCADE on company_id — experiments are workspace-scoped working
-- state, not audit data. When a company is hard-deleted the experiments go
-- with it. Compare events.company_id which is RESTRICT (audit/billing).
--
-- ON DELETE SET NULL implicitly via no-action on agents — we keep the
-- experiment row when the owner agent is deleted; the founder still sees
-- the hypothesis and decides whether to reassign.
--
-- Idempotency: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS
-- throughout. Safe to re-run.
--
-- Rollback:
--   DROP TABLE IF EXISTS "experiments";

CREATE TABLE IF NOT EXISTS "experiments" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"         uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "department"         text NOT NULL DEFAULT 'growth',
  "hypothesis"         text NOT NULL,
  "channel"            text,
  "expected_lift_pct"  real,
  "expected_cac_cents" bigint,
  "ice_impact"         integer NOT NULL,
  "ice_confidence"     integer NOT NULL,
  "ice_ease"           integer NOT NULL,
  "ice_score"          real GENERATED ALWAYS AS (((ice_impact * ice_confidence * ice_ease)::real / 10)) STORED,
  "status"             text NOT NULL DEFAULT 'proposed',
  "owner_agent_id"     uuid REFERENCES "agents"("id"),
  "next_milestone"     text,
  "actual_lift_pct"    real,
  "created_at"         timestamp NOT NULL DEFAULT now(),
  "completed_at"       timestamp,
  CONSTRAINT "experiments_department_check"
    CHECK ("department" IN ('growth','chief-of-staff','content','crm','finance')),
  CONSTRAINT "experiments_status_check"
    CHECK ("status" IN ('proposed','running','completed','abandoned')),
  CONSTRAINT "experiments_channel_check"
    CHECK ("channel" IS NULL OR "channel" IN ('linkedin','paid_meta','paid_google','referral','seo','partnerships','content')),
  CONSTRAINT "experiments_ice_range_check"
    CHECK (
      "ice_impact"     BETWEEN 1 AND 10
      AND "ice_confidence" BETWEEN 1 AND 10
      AND "ice_ease"   BETWEEN 1 AND 10
    )
);

CREATE INDEX IF NOT EXISTS "experiments_company_ice_idx"
  ON "experiments" ("company_id", "ice_score");

CREATE INDEX IF NOT EXISTS "experiments_company_status_idx"
  ON "experiments" ("company_id", "status");
