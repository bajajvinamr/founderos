CREATE TABLE "decision_outcomes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "approval_id" uuid NOT NULL REFERENCES "approvals"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "outcome_status" text NOT NULL,
  "prompted_at" timestamp with time zone NOT NULL DEFAULT now(),
  "answered_at" timestamp with time zone,
  "founder_note" text,
  "metric_delta" text,
  "memory_entry_id" uuid REFERENCES "company_memory"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "idx_decision_outcomes_approval" ON "decision_outcomes" ("approval_id");
CREATE INDEX "idx_decision_outcomes_company_status" ON "decision_outcomes" ("company_id", "outcome_status");
