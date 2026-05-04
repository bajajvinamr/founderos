import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

export const instanceSubscription = pgTable(
  "instance_subscription",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stripeCustomerId: text("stripe_customer_id"),
    /**
     * Stripe subscription id — UNIQUE at the DB level (migration 0073)
     * so Stripe webhook retries upsert deterministically instead of
     * inserting duplicate rows. NULLs allowed (a row without a Stripe
     * id yet — e.g., placeholder for a free-tier instance — is valid;
     * PostgreSQL UNIQUE treats NULLs as distinct, so multiple NULL rows
     * coexist).
     */
    stripeSubscriptionId: text("stripe_subscription_id").unique(),
    plan: text("plan").notNull().default("free"),
    status: text("status").notNull().default("inactive"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    stripeCustomerIdx: index("idx_instance_subscription_stripe_customer").on(
      table.stripeCustomerId
    ),
    stripeSubIdx: index("idx_instance_subscription_stripe_sub").on(
      table.stripeSubscriptionId
    ),
  })
);
