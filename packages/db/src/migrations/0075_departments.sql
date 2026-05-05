-- 2026-05-05 — Department Registry (S1.7)
--
-- Moves the hardcoded DEPARTMENTS list from ui/src/lib/departments.ts into
-- the database, adding per-workspace overrides via workspace_departments.
--
-- Tables:
--   departments            — global catalogue (id = slug, e.g. 'chief-of-staff')
--   workspace_departments  — per-company enable/disable + autonomy level (1..4)
--
-- Seed:
--   The 7 departments from the hardcoded list are inserted here.
--   Core departments (chief-of-staff, growth, content, crm, finance) get is_core = true.
--   Engineering and ops are non-core.
--
-- Backfill:
--   Every existing company gets workspace_departments rows for the 5 core
--   departments (enabled = true, autonomy_level = 2). Non-core departments
--   are opt-in and are NOT backfilled.
--
-- Idempotency:
--   CREATE TABLE IF NOT EXISTS + INSERT … ON CONFLICT DO NOTHING throughout.
--   Safe to re-run; subsequent executions are no-ops.

-- ── departments ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "departments" (
  "id"          text PRIMARY KEY,
  "label"       text NOT NULL,
  "description" text,
  "icon"        text,
  "sort_order"  integer NOT NULL DEFAULT 0,
  "is_core"     boolean NOT NULL DEFAULT false
);

INSERT INTO "departments" ("id", "label", "description", "icon", "sort_order", "is_core") VALUES
  ('chief-of-staff', 'Chief of Staff',    'Priorities, brief, capital allocation',           'Compass',    1, true),
  ('growth',         'Growth',            'Acquisition, experiments, channels',               'TrendingUp', 2, true),
  ('content',        'Content Studio',    'Research, drafts, distribution, attribution',      'PenTool',    3, true),
  ('crm',            'CRM & Lifecycle',   'Onboarding, activation, churn, upsell',           'Users',      4, true),
  ('finance',        'Finance',           'Revenue, pricing, runway, burn',                  'DollarSign', 5, true),
  ('engineering',    'Engineering',       'Product, PRs, reviews, infra',                    'Code2',      6, false),
  ('ops',            'Operations',        'Workflows, approvals, SOPs',                      'Settings2',  7, false)
ON CONFLICT ("id") DO NOTHING;

-- ── workspace_departments ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "workspace_departments" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"     uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "department_id"  text NOT NULL REFERENCES "departments"("id"),
  "enabled"        boolean NOT NULL DEFAULT true,
  "autonomy_level" integer NOT NULL DEFAULT 2,
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_departments_company_id_department_id_unique" UNIQUE ("company_id", "department_id")
);

-- ── Backfill: enable the 5 core departments for all existing companies ────────
-- ON CONFLICT DO NOTHING is safe: if a row already exists (re-run), leave it.

INSERT INTO "workspace_departments" ("company_id", "department_id", "enabled", "autonomy_level")
SELECT
  c.id,
  d.id,
  true,
  2
FROM "companies" c
CROSS JOIN "departments" d
WHERE d."is_core" = true
ON CONFLICT ("company_id", "department_id") DO NOTHING;
