import type { Db } from "@founderos/db";
import { instanceSubscription } from "@founderos/db";
import { desc, eq } from "drizzle-orm";
import type { StripeWebhookEvent } from "./stripe-client.js";
import { logger } from "../middleware/logger.js";

export interface CurrentSubscription {
  id: string;
  plan: string;
  status: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  currentPeriodEnd?: Date;
}

export interface SubscriptionStatus {
  active: boolean;
  plan: string;
}

/**
 * "Healthy" subscription statuses for the gate. `trialing` is included
 * because Stripe trials grant full access — gating only on `active`
 * locked trial users out at checkout success.
 *
 * Anchored as a const tuple so the union type stays in sync with the
 * runtime list. Stripe statuses are: `active`, `past_due`, `unpaid`,
 * `canceled`, `incomplete`, `incomplete_expired`, `trialing`, `paused`.
 */
const HEALTHY_SUBSCRIPTION_STATUSES = ["active", "trialing"] as const;

export function subscriptionService(db: Db) {
  async function getCurrentSubscription(): Promise<CurrentSubscription | null> {
    try {
      // ORDER BY updated_at DESC: pre-migration-0073, this table could
      // contain duplicate rows for the same Stripe subscription (every
      // webhook retry inserted a fresh row because the conflict target
      // was misconfigured). The migration dedupes existing rows, but
      // for legacy installs that have already deployed once we still
      // want the newest row to win — `findFirst()` without orderBy
      // returns arbitrary order on PostgreSQL.
      const result = await db.query.instanceSubscription.findFirst({
        orderBy: (table, { desc: descExpr }) => [descExpr(table.updatedAt)],
      });
      if (!result) {
        return null;
      }

      return {
        id: result.id,
        plan: result.plan,
        status: result.status,
        stripeCustomerId: result.stripeCustomerId || undefined,
        stripeSubscriptionId: result.stripeSubscriptionId || undefined,
        currentPeriodEnd: result.currentPeriodEnd || undefined,
      };
    } catch (error) {
      logger.error({ error }, "Failed to get current subscription");
      return null;
    }
  }

  async function isSubscriptionActive(): Promise<boolean> {
    try {
      const sub = await getCurrentSubscription();
      if (!sub) return false;
      return (HEALTHY_SUBSCRIPTION_STATUSES as readonly string[]).includes(
        sub.status,
      );
    } catch (error) {
      logger.error({ error }, "Failed to check subscription status");
      return false;
    }
  }

  async function handleStripeWebhook(event: StripeWebhookEvent): Promise<void> {
    try {
      switch (event.type) {
        case "customer.subscription.created":
        case "customer.subscription.updated": {
          const obj = event.data.object as Record<string, unknown>;
          const stripeSubscriptionId = obj.id as string;
          if (!stripeSubscriptionId) {
            logger.warn({ eventType: event.type }, "Stripe webhook missing subscription id; skipping");
            return;
          }
          // onConflictDoUpdate target = stripeSubscriptionId (UNIQUE per
          // migration 0073). Pre-fix the target was `id` — a fresh UUID
          // every insert that NEVER conflicted, so every retry duplicated.
          await db
            .insert(instanceSubscription)
            .values({
              stripeCustomerId: obj.customer as string,
              stripeSubscriptionId,
              plan: "pro",
              status: (obj.status as string) || "active",
              currentPeriodEnd: obj.current_period_end
                ? new Date((obj.current_period_end as number) * 1000)
                : undefined,
            })
            .onConflictDoUpdate({
              target: instanceSubscription.stripeSubscriptionId,
              set: {
                stripeCustomerId: obj.customer as string,
                status: (obj.status as string) || "active",
                currentPeriodEnd: obj.current_period_end
                  ? new Date((obj.current_period_end as number) * 1000)
                  : undefined,
                updatedAt: new Date(),
              },
            });
          logger.info(
            { eventType: event.type, stripeSubscriptionId },
            "Subscription webhook processed",
          );
          break;
        }

        case "customer.subscription.deleted": {
          const obj = event.data.object as Record<string, unknown>;
          await db
            .update(instanceSubscription)
            .set({
              status: "canceled",
              updatedAt: new Date(),
            })
            .where(eq(instanceSubscription.stripeSubscriptionId, obj.id as string));
          logger.info("Subscription deleted webhook processed");
          break;
        }

        default:
          logger.debug({ type: event.type }, "Unhandled Stripe webhook type");
      }
    } catch (error) {
      logger.error({ error, eventType: event.type }, "Failed to handle Stripe webhook");
      throw error;
    }
  }

  return {
    getCurrentSubscription,
    isSubscriptionActive,
    handleStripeWebhook,
    HEALTHY_SUBSCRIPTION_STATUSES,
  };
}

export { HEALTHY_SUBSCRIPTION_STATUSES };
