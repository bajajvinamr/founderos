-- S5.9 — Finance settings (singleton-per-company manual inputs)
--
-- Stores founder-supplied cash + burn that we cannot derive from Stripe.
-- Powers Sprint 5 runway forecast (S5.5), cash planning (S5.8), and
-- the cockpit's "months until cash-out" gauge.
--
-- UNIQUE on company_id enforces singleton semantics; UPSERT on
-- (company_id) is the canonical write path.

CREATE TABLE IF NOT EXISTS "company_financials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "cash_balance_cents" bigint NOT NULL DEFAULT 0,
  "monthly_burn_cents" bigint NOT NULL DEFAULT 0,
  "currency" text NOT NULL DEFAULT 'USD',
  "last_updated_at" timestamptz NOT NULL DEFAULT now(),
  "last_updated_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "company_financials_company_uq"
  ON "company_financials" ("company_id");
