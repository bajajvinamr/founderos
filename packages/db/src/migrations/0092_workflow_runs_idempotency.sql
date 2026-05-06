-- Migration 0092: workflow_runs idempotency key
-- Council 2026-05-06 S4.8 prerequisite #2
-- Adds idempotency_key column and unique constraint to prevent duplicate workflow_run creation
-- from dual triggers (kpi_anomaly insight + Stripe at_risk webhook on same customer same day).

ALTER TABLE workflow_runs
  ADD COLUMN idempotency_key text,
  ADD CONSTRAINT workflow_runs_idempotency_unique
    UNIQUE NULLS NOT DISTINCT (company_id, workflow_id, idempotency_key);
