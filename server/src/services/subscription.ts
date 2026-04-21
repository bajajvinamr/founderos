import type { Db } from "@founderos/db";
import { instanceSubscription } from "@founderos/db";
import { eq } from "drizzle-orm";
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

export function subscriptionService(db: Db) {
  async function getCurrentSubscription(): Promise<CurrentSubscription | null> {
    try {
      const result = await db.query.instanceSubscription.findFirst();
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
      return sub?.status === "active";
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
          await db
            .insert(instanceSubscription)
            .values({
              stripeCustomerId: obj.customer as string,
              stripeSubscriptionId: obj.id as string,
              plan: "pro",
              status: (obj.status as string) || "active",
              currentPeriodEnd: obj.current_period_end
                ? new Date((obj.current_period_end as number) * 1000)
                : undefined,
            })
            .onConflictDoUpdate({
              target: [instanceSubscription.id],
              set: {
                stripeSubscriptionId: obj.id as string,
                status: (obj.status as string) || "active",
                currentPeriodEnd: obj.current_period_end
                  ? new Date((obj.current_period_end as number) * 1000)
                  : undefined,
                updatedAt: new Date(),
              },
            });
          logger.info({ eventType: event.type }, "Subscription webhook processed");
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
  };
}
