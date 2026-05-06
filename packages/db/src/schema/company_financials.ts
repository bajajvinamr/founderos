import {
  pgTable,
  uuid,
  bigint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * `company_financials` — singleton-per-company manual finance inputs.
 *
 * Founder-supplied numbers that we can't derive from Stripe/events:
 * cash on hand and monthly burn. These power Sprint 5 runway forecast
 * (S5.5), cash planning (S5.8), and the headline "months until cash-out"
 * gauge in the Finance cockpit.
 *
 * UNIQUE on company_id makes this a strict singleton — UPSERT on
 * (company_id) is the canonical write path; no historical rows.
 *
 * Audit trail intentionally minimal in v1 (lastUpdatedAt + lastUpdatedBy)
 * because the row is read on every cockpit load and a separate audit
 * table is overkill. Activity log captures the change event.
 */
export const companyFinancials = pgTable(
  "company_financials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    cashBalanceCents: bigint("cash_balance_cents", { mode: "number" })
      .notNull()
      .default(0),
    monthlyBurnCents: bigint("monthly_burn_cents", { mode: "number" })
      .notNull()
      .default(0),
    currency: text("currency").notNull().default("USD"),
    lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUpdatedBy: text("last_updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("company_financials_company_uq").on(table.companyId),
  }),
);
