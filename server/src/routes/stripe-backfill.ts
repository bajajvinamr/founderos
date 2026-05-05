/**
 * stripe-backfill.ts — Admin endpoint to trigger historical Stripe data ingestion (S2.2)
 *
 * POST /api/integrations/stripe/backfill
 *   Body:  { companyId: string; sinceDays?: number }
 *   Auth:  instance-admin only
 *   Returns: { ingested: number; deduplicated: number; errors: string[] }
 *
 * The underlying backfill is idempotent — the events table UNIQUE constraint
 * (companyId, source, dedupKey) ensures a second run produces no new rows.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { assertInstanceAdmin } from "./authz.js";
import { backfillCompanyStripe } from "../services/stripe-backfill.js";
import { logger } from "../middleware/logger.js";

const backfillBodySchema = z.object({
  companyId: z.string().uuid("companyId must be a valid UUID"),
  sinceDays: z.number().int().positive().max(3650).optional(),
});

export function stripeBackfillRoutes() {
  const router = Router();

  /**
   * POST /api/integrations/stripe/backfill
   *
   * Admin-only: triggers a paginated pull of historical Stripe data
   * (customers, subscriptions, invoices from the last `sinceDays` days)
   * and ingests each item into the canonical events table.
   */
  router.post("/integrations/stripe/backfill", async (req: Request, res: Response) => {
    try {
      assertInstanceAdmin(req);
    } catch {
      res.status(403).json({ error: "Instance admin access required" });
      return;
    }

    const parsed = backfillBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const stripeKey = process.env.STRIPE_SECRET_KEY?.trim();
    if (!stripeKey) {
      res.status(501).json({
        error: "Stripe not configured",
        message: "STRIPE_SECRET_KEY must be set to run a backfill",
      });
      return;
    }

    const { companyId, sinceDays } = parsed.data;

    logger.info({ companyId, sinceDays }, "stripe-backfill: starting");

    try {
      const result = await backfillCompanyStripe(companyId, stripeKey, { sinceDays });
      res.json(result);
    } catch (error) {
      logger.error({ error, companyId }, "stripe-backfill: fatal error");
      res.status(500).json({ error: "Backfill failed", message: String(error) });
    }
  });

  return router;
}
