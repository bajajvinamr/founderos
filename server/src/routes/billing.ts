import { Router, type Request, type Response } from "express";
import type { Db } from "@founderos/db";
import { subscriptionService } from "../services/subscription.js";
import { createStripeClient } from "../services/stripe-client.js";
import { logger } from "../middleware/logger.js";

export function billingRoutes(db: Db) {
  const router = Router();
  const subService = subscriptionService(db);
  const stripeClient = createStripeClient({
    secretKey: process.env.STRIPE_SECRET_KEY,
  });

  // GET /api/billing/status
  router.get("/status", async (_req: Request, res: Response) => {
    try {
      const isActive = await subService.isSubscriptionActive();
      const sub = await subService.getCurrentSubscription();

      res.json({
        active: isActive,
        plan: sub?.plan || "free",
      });
    } catch (error) {
      logger.error({ error }, "Failed to get billing status");
      // Fallback to free/active to not break the gate
      res.json({ active: true, plan: "free" });
    }
  });

  // POST /api/billing/checkout
  router.post("/checkout", async (req: Request, res: Response) => {
    try {
      // TODO: Implement full checkout flow
      // For now, return 501 Not Implemented
      logger.debug("Checkout endpoint called (not yet implemented)");
      res.status(501).json({
        error: "Stripe checkout not yet configured",
        message: "Please configure STRIPE_SECRET_KEY and STRIPE_PRICE_ID_PRO",
      });
    } catch (error) {
      logger.error({ error }, "Checkout error");
      res.status(500).json({ error: "Checkout failed" });
    }
  });

  // POST /api/billing/webhook
  router.post("/webhook", async (req: Request, res: Response) => {
    try {
      const signature = req.headers["stripe-signature"] as string;
      if (!signature) {
        res.status(400).json({ error: "Missing stripe-signature header" });
        return;
      }

      // TODO: Implement full webhook verification and event handling
      logger.debug("Webhook received (verification not yet implemented)");
      res.status(501).json({
        error: "Stripe webhook handling not yet configured",
      });
    } catch (error) {
      logger.error({ error }, "Webhook error");
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  return router;
}
