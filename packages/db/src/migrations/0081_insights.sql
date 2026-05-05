-- 2026-05-05 — Insights table for department-agent recommendations (S3.1)
--
-- Single shared table for all five department agents (CoS / Growth / Content
-- / CRM / Finance). The UI filters by `department` + `kind` rather than
-- joining across per-agent tables.
--
-- All CHECK constraints are inline in the CREATE TABLE — per FounderOS
-- invariant: `ALTER TABLE` takes ACCESS EXCLUSIVE per statement, and a
-- multi-statement migration on a hot table can stall under concurrent
-- traffic. Inline constraints in CREATE TABLE acquire no separate lock
-- (the table is brand new, so nothing is reading it).
--
-- CHECK constraints (runtime backstop for TS union types — types erase at
-- compile time, the DB layer is the only place that catches caller drift,
-- raw SQL inserts, and future migrations that bypass the typed path):
--   department IN ('chief-of-staff','growth','content','crm','finance')
--   kind       IN ('kpi_anomaly','opportunity','blocker','experiment_suggestion','channel_recommendation','attribution')
--   status     IN ('open','acted_on','dismissed','expired')
--   confidence BETWEEN 0 AND 1 inclusive
--
-- FK: ON DELETE CASCADE — insights are recommendation surface tied to a
-- specific company. If the company is removed, surfacing stale insights is
-- worse than losing them. (Contrast with `events` — RESTRICT — which is
-- audit/billing data.)
--
-- Index insights_company_kind_idx (company_id, kind, created_at DESC):
--   The dominant query is "latest N <kind> insights for company X." A
--   composite (company_id, kind) prefix with a DESC suffix on created_at
--   serves both the kind-filtered list and (via prefix usage) a
--   company-wide-by-kind aggregation without a separate sort.
--
-- Idempotency:
--   CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS — safe to
--   re-run; subsequent executions are no-ops.
--
-- Rollback:
--   DROP TABLE IF EXISTS "insights";

CREATE TABLE IF NOT EXISTS "insights" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"     uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "department"     text NOT NULL,
  "kind"           text NOT NULL,
  "title"          text NOT NULL,
  "body"           text NOT NULL,
  "confidence"     real NOT NULL,
  "recommendation" text,
  "evidence"       jsonb NOT NULL,
  "status"         text NOT NULL DEFAULT 'open',
  "outcome_note"   text,
  "expires_at"     timestamp with time zone,
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"     timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "insights_department_check"
    CHECK ("department" IN ('chief-of-staff','growth','content','crm','finance')),
  CONSTRAINT "insights_kind_check"
    CHECK ("kind" IN ('kpi_anomaly','opportunity','blocker','experiment_suggestion','channel_recommendation','attribution')),
  CONSTRAINT "insights_status_check"
    CHECK ("status" IN ('open','acted_on','dismissed','expired')),
  CONSTRAINT "insights_confidence_check"
    CHECK ("confidence" >= 0 AND "confidence" <= 1)
);

CREATE INDEX IF NOT EXISTS "insights_company_kind_idx"
  ON "insights" ("company_id", "kind", "created_at" DESC);
