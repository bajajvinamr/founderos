import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

export const instanceSubscription = pgTable(
  "instance_subscription",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
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
