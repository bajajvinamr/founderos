import { logger } from "../middleware/logger.js";

export interface CheckoutSessionParams {
  customerId?: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
}

export interface StripeSubscription {
  id: string;
  customerId: string;
  status: "active" | "past_due" | "canceled" | "incomplete";
  currentPeriodEnd?: number;
}

export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
}

export class StripeClient {
  private secretKey: string;
  private enabled: boolean;

  constructor(secretKey?: string) {
    this.secretKey = secretKey || "";
    this.enabled = !!secretKey;
  }

  async createCheckoutSession(params: CheckoutSessionParams): Promise<{ url: string }> {
    if (!this.enabled) {
      logger.info("Stripe checkout skipped — STRIPE_SECRET_KEY not set");
      return { url: "" };
    }

    // TODO: Implement Stripe.js client or HTTP wrapper
    // For now, stub with TODO comment
    logger.warn("createCheckoutSession: stub implementation, needs Stripe integration");
    throw new Error("Stripe integration not yet implemented");
  }

  async retrieveSubscription(subscriptionId: string): Promise<StripeSubscription | null> {
    if (!this.enabled) {
      logger.info("Stripe subscription retrieval skipped — STRIPE_SECRET_KEY not set");
      return null;
    }

    // TODO: Implement Stripe API call
    logger.warn("retrieveSubscription: stub implementation, needs Stripe integration");
    throw new Error("Stripe integration not yet implemented");
  }

  constructWebhookEvent(
    body: Buffer | string,
    signature: string,
    endpointSecret: string
  ): StripeWebhookEvent {
    // TODO: Use stripe.webhooks.constructEvent for signature verification
    logger.warn("constructWebhookEvent: stub implementation, needs Stripe integration");
    throw new Error("Stripe webhook verification not yet implemented");
  }
}

export function createStripeClient(opts: { secretKey?: string } = {}): StripeClient {
  return new StripeClient(opts.secretKey);
}
