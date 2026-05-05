import { Router, type Request, type Response } from "express";
import type { Db } from "@founderos/db";
import { subscriptionService } from "../services/subscription.js";
import { createStripeClient } from "../services/stripe-client.js";
import { ingestEvent } from "../services/event-ingest.js";
import { logger } from "../middleware/logger.js";
import { billingWebhookLimiter } from "../middleware/rate-limit.js";

// ---------------------------------------------------------------------------
// Local type: Stripe events include `created` (Unix s) that the shared
// StripeWebhookEvent interface doesn't expose. We extend it locally so we
// can normalize occurredAt without modifying the shared interface.
// ---------------------------------------------------------------------------

interface StripeEventWithCreated {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Entity-type mapping for Stripe event types → canonical entityType
// ---------------------------------------------------------------------------

type StripeEntityType = "customer" | "subscription" | "invoice" | "charge";

function resolveEntityType(eventType: string): StripeEntityType {
  if (eventType.startsWith("customer.subscription.")) return "subscription";
  if (eventType.startsWith("customer.")) return "customer";
  if (eventType.startsWith("invoice.")) return "invoice";
  if (eventType.startsWith("charge.")) return "charge";
  return "customer"; // fallback — unreachable for the 14 handled types
}

/**
 * The 14 Stripe event types we ingest into the canonical events table.
 * Subscription-level events are also handled by the existing subscription
 * row idempotency logic (PR #33) — that logic runs first and is unaffected.
 */
const INGEST_EVENT_TYPES = new Set([
  "customer.created",
  "customer.updated",
  "customer.deleted",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.trial_will_end",
  "invoice.created",
  "invoice.finalized",
  "invoice.paid",
  "invoice.payment_failed",
  "charge.succeeded",
  "charge.failed",
  "charge.refunded",
]);

/**
 * Ingest a Stripe webhook event into the canonical events table.
 *
 * Non-throwing: errors are logged but do not abort webhook processing.
 * The subscription row idempotency logic (PR #33) must succeed even if
 * event ingestion fails.
 *
 * companyId: on the self-hosted single-tenant build there is exactly one
 * company; resolved from FOUNDEROS_DEFAULT_COMPANY_ID. Multi-tenant builds
 * will need to resolve via Stripe customer → company mapping.
 */
async function ingestStripeEvent(
  event: StripeEventWithCreated,
  companyId: string,
): Promise<void> {
  if (!INGEST_EVENT_TYPES.has(event.type)) return;

  try {
    await ingestEvent({
      companyId,
      source: "stripe",
      entityType: resolveEntityType(event.type),
      eventName: event.type,
      dedupKey: event.id,
      occurredAt: new Date(event.created * 1000),
      payload: event.data.object,
    });
  } catch (err) {
    // Non-fatal: subscription table upsert takes precedence.
    logger.warn(
      { err, eventId: event.id, eventType: event.type, companyId },
      "stripe-ingest: failed to ingest event (non-fatal)",
    );
  }
}

export function billingRoutes(db: Db) {
  const router = Router();
  const subService = subscriptionService(db);
  const stripeClient = createStripeClient({
    secretKey: process.env.STRIPE_SECRET_KEY,
  });

  // GET /api/billing/status — dashboard widget + billing gate
  router.get("/status", async (_req: Request, res: Response) => {
    try {
      const isActive = await subService.isSubscriptionActive();
      const sub = await subService.getCurrentSubscription();

      res.json({
        active: isActive,
        plan: sub?.plan ?? "free",
        status: sub?.status ?? "inactive",
        currentPeriodEnd: sub?.currentPeriodEnd ?? null,
        stripeConfigured: stripeClient.isEnabled(),
      });
    } catch (error) {
      logger.error({ error }, "Failed to get billing status");
      // Fail open — don't block the UI on billing issues.
      res.json({ active: true, plan: "free", status: "inactive", currentPeriodEnd: null, stripeConfigured: false });
    }
  });

  // POST /api/billing/checkout — kicks user off to Stripe-hosted checkout.
  router.post("/checkout", async (req: Request, res: Response) => {
    try {
      if (!stripeClient.isEnabled()) {
        res.status(501).json({
          error: "Stripe not configured",
          message: "STRIPE_SECRET_KEY and STRIPE_PRICE_ID_PRO must be set on the server.",
        });
        return;
      }
      const priceId = process.env.STRIPE_PRICE_ID_PRO;
      if (!priceId) {
        res.status(501).json({
          error: "Stripe plan not configured",
          message: "STRIPE_PRICE_ID_PRO is required (the $299/mo plan's Stripe price ID).",
        });
        return;
      }

      const { customerEmail } = (req.body ?? {}) as { customerEmail?: string };

      // Use FOUNDEROS_BASE_URL if set (prod), otherwise fall back to the
      // request's origin header (local dev).
      const baseUrl =
        process.env.FOUNDEROS_BASE_URL ??
        (req.headers.origin as string | undefined) ??
        "https://founderos.fly.dev";

      const session = await stripeClient.createCheckoutSession({
        priceId,
        customerEmail,
        successUrl: `${baseUrl}/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${baseUrl}/settings/billing?checkout=cancel`,
      });

      res.json({ url: session.url });
    } catch (error) {
      logger.error({ error }, "Checkout failed");
      res.status(500).json({ error: "Checkout failed" });
    }
  });

  // POST /api/billing/webhook — Stripe-signed events.
  // IMPORTANT: needs req.rawBody (attached by express.json's verify hook in app.ts).
  router.post("/webhook", billingWebhookLimiter, async (req: Request, res: Response) => {
    try {
      if (!stripeClient.isEnabled()) {
        res.status(501).json({ error: "Stripe webhook not configured" });
        return;
      }
      const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!endpointSecret) {
        res.status(501).json({ error: "STRIPE_WEBHOOK_SECRET not configured" });
        return;
      }
      const signature = req.headers["stripe-signature"] as string | undefined;
      if (!signature) {
        res.status(400).json({ error: "Missing stripe-signature header" });
        return;
      }
      const rawBody = req.rawBody;
      if (!rawBody) {
        // Without the raw body the signature can't be verified — reject hard.
        res.status(400).json({ error: "Missing raw request body" });
        return;
      }

      let event;
      try {
        event = stripeClient.constructWebhookEvent(rawBody, signature, endpointSecret);
      } catch (err) {
        logger.warn({ err }, "Stripe webhook signature verification failed");
        res.status(400).json({ error: "Invalid signature" });
        return;
      }

      // Existing subscription-row idempotency logic (PR #33) — runs first so
      // the billing gate reflects the latest subscription state even if event
      // ingestion fails.
      await subService.handleStripeWebhook(event);

      // Ingest into canonical events table for downstream KPI / analytics.
      // Cast to StripeEventWithCreated: Stripe always includes `created` on
      // the raw event object — constructWebhookEvent passes it through as
      // unknown fields on the return value from the Stripe SDK.
      const companyId =
        process.env.FOUNDEROS_DEFAULT_COMPANY_ID ?? "default-company";
      await ingestStripeEvent(event as unknown as StripeEventWithCreated, companyId);

      res.json({ received: true });
    } catch (error) {
      logger.error({ error }, "Webhook processing failed");
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  return router;
}
