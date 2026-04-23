import Stripe from "stripe";
import { logger } from "../middleware/logger.js";

export interface CheckoutSessionParams {
  customerId?: string;
  customerEmail?: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
}

export interface StripeSubscription {
  id: string;
  customerId: string;
  status: "active" | "past_due" | "canceled" | "incomplete" | "trialing" | "unpaid" | "paused" | "incomplete_expired";
  currentPeriodEnd?: number;
}

export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
}

const API_VERSION = "2026-03-25.dahlia" as const;

export class StripeClient {
  private client: Stripe | null;
  private enabled: boolean;

  constructor(secretKey?: string) {
    const key = secretKey?.trim() || "";
    this.enabled = key.length > 0;
    this.client = this.enabled
      ? new Stripe(key, {
          apiVersion: API_VERSION,
          typescript: true,
          appInfo: { name: "FounderOS", version: "0.3.1" },
        })
      : null;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async createCheckoutSession(params: CheckoutSessionParams): Promise<{ url: string }> {
    if (!this.client) {
      throw new Error("Stripe not configured — STRIPE_SECRET_KEY missing");
    }
    const session = await this.client.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: params.priceId, quantity: 1 }],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      ...(params.customerId ? { customer: params.customerId } : {}),
      ...(params.customerEmail && !params.customerId
        ? { customer_email: params.customerEmail }
        : {}),
      allow_promotion_codes: true,
      billing_address_collection: "auto",
    });
    if (!session.url) {
      throw new Error("Stripe returned checkout session without a URL");
    }
    return { url: session.url };
  }

  async retrieveSubscription(subscriptionId: string): Promise<StripeSubscription | null> {
    if (!this.client) return null;
    try {
      const sub = await this.client.subscriptions.retrieve(subscriptionId);
      const firstItem = sub.items.data[0];
      return {
        id: sub.id,
        customerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
        status: sub.status,
        currentPeriodEnd: firstItem?.current_period_end,
      };
    } catch (error) {
      logger.error({ error, subscriptionId }, "Failed to retrieve Stripe subscription");
      return null;
    }
  }

  constructWebhookEvent(
    body: Buffer | string,
    signature: string,
    endpointSecret: string,
  ): StripeWebhookEvent {
    if (!this.client) {
      throw new Error("Stripe not configured — cannot verify webhook");
    }
    // Real signature verification. Throws on invalid signature or expired timestamp.
    const event = this.client.webhooks.constructEvent(body, signature, endpointSecret);
    return {
      id: event.id,
      type: event.type,
      data: { object: event.data.object as unknown as Record<string, unknown> },
    };
  }
}

export function createStripeClient(opts: { secretKey?: string } = {}): StripeClient {
  return new StripeClient(opts.secretKey);
}
