import {
  pgTable,
  uuid,
  text,
  bigint,
  date,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

/**
 * Marketing channels that can carry attributed ad/marketing spend.
 *
 * Mirrors `EXPERIMENT_CHANNELS` from experiments.ts (the canonical list
 * used by Growth's experiment ledger) plus an "other" catch-all so the
 * UI can hold un-categorized spend without forcing the founder to pick
 * a wrong bucket. The CHECK constraint at the DB layer enforces this
 * union — TypeScript unions erase at compile time, see vinamr-invariants
 * "CHECK constraints on enum-shaped text columns".
 */
export const MARKETING_SPEND_CHANNELS = [
  "linkedin",
  "paid_meta",
  "paid_google",
  "referral",
  "seo",
  "partnerships",
  "content",
  "other",
] as const;

export type MarketingSpendChannel = (typeof MARKETING_SPEND_CHANNELS)[number];

/**
 * `marketing_spend` — manual ad-spend ledger by channel + period.
 *
 * S5.6 of Sprint 5 (Finance). Founder enters spend per channel per period
 * (typically a calendar month). Joined with attributed signups from
 * S3.8 (channel attribution) to compute CAC per channel; joined with
 * downstream revenue to compute per-channel LTV.
 *
 * Multiple rows per (companyId, channel) are valid — one per reporting
 * period. The (companyId, channel, periodStart) index supports the
 * common "give me all 2026 LinkedIn spend" lookup; the (companyId,
 * periodStart) index supports aggregate views.
 *
 * `amount_cents >= 0` is enforced via CHECK; refunds (rare in marketing)
 * are entered as separate negative-amount adjustment rows in v2 if
 * needed. v1 keeps it positive-only for legibility.
 */
export const marketingSpend = pgTable(
  "marketing_spend",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    currency: text("currency").notNull().default("USD"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: text("created_by"),
  },
  (table) => ({
    companyChannelPeriodIdx: index("marketing_spend_company_channel_period_idx").on(
      table.companyId,
      table.channel,
      table.periodStart,
    ),
    companyPeriodIdx: index("marketing_spend_company_period_idx").on(
      table.companyId,
      table.periodStart,
    ),
    amountNonNegative: check(
      "marketing_spend_amount_non_negative",
      sql`${table.amountCents} >= 0`,
    ),
    periodOrder: check(
      "marketing_spend_period_order",
      sql`${table.periodEnd} >= ${table.periodStart}`,
    ),
    channelEnum: check(
      "marketing_spend_channel_enum",
      sql`${table.channel} IN ('linkedin','paid_meta','paid_google','referral','seo','partnerships','content','other')`,
    ),
  }),
);
