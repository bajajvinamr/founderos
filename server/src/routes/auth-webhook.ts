/**
 * Supabase Auth webhook endpoint.
 *
 * POST /api/auth/webhook
 *
 * Supabase fires signed webhooks when user accounts change (user.created,
 * user.updated, etc.). We verify the HMAC-SHA256 signature using a shared
 * `SUPABASE_WEBHOOK_SECRET` and, on `user.created`, run the same post-signup
 * bootstrap logic better-auth uses (first-user-wins instance_admin grant +
 * pending-invite consume).
 *
 * Why not use Supabase's own "auth trigger" DB function? Because the
 * bootstrap logic lives server-side (invite service, role checks) and we
 * want one code path exercised by both adapters.
 */

import { Router, type Request, type Response } from "express";
import type { Db } from "@founderos/db";
import {
  extractSupabaseUserFromWebhook,
  verifySupabaseWebhookSignature,
} from "../auth/supabase.js";
import { runPostSignupBootstrap } from "../auth/post-signup-hook.js";
import { logger } from "../middleware/logger.js";
import { authWebhookLimiter } from "../middleware/rate-limit.js";

/** Header Supabase sends with the HMAC signature. */
const SIGNATURE_HEADER = "x-supabase-signature";
/** Supabase event types we act on. Others are ACK'd so retries don't pile up. */
const SIGNUP_EVENT_TYPES = new Set(["user.created", "INSERT"]);

export function authWebhookRoutes(
  db: Db,
  opts: { webhookSecret: string | undefined },
): Router {
  const router = Router();

  router.post("/api/auth/webhook", authWebhookLimiter, async (req: Request, res: Response) => {
    if (!opts.webhookSecret) {
      // Fail closed — without a shared secret we can't distinguish a real
      // Supabase call from a forged one.
      logger.warn({ method: req.method, url: req.originalUrl }, "auth webhook called without SUPABASE_WEBHOOK_SECRET configured");
      res.status(503).json({ error: "webhook not configured" });
      return;
    }

    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      // `app.ts` attaches rawBody via the express.json verify callback. If
      // it's missing the request probably wasn't JSON — reject.
      res.status(400).json({ error: "missing raw body" });
      return;
    }

    const signatureHeader = req.header(SIGNATURE_HEADER);
    const signatureOk = verifySupabaseWebhookSignature({
      rawBody,
      signatureHeader: signatureHeader ?? null,
      secret: opts.webhookSecret,
    });

    if (!signatureOk) {
      logger.warn(
        {
          hasSignature: Boolean(signatureHeader),
          bodyBytes: rawBody.length,
        },
        "auth webhook signature invalid — rejecting",
      );
      res.status(401).json({ error: "invalid signature" });
      return;
    }

    const payload = req.body as { type?: string; record?: unknown };
    const eventType = typeof payload?.type === "string" ? payload.type : null;

    if (!eventType) {
      logger.warn({ payloadKeys: Object.keys(payload ?? {}) }, "auth webhook missing event type");
      res.status(400).json({ error: "missing event type" });
      return;
    }

    if (!SIGNUP_EVENT_TYPES.has(eventType)) {
      // ACK non-signup events so Supabase doesn't retry them.
      logger.debug({ eventType }, "auth webhook: ignoring event type");
      res.status(200).json({ ok: true, action: "ignored", eventType });
      return;
    }

    const user = extractSupabaseUserFromWebhook(payload);
    if (!user) {
      logger.warn({ eventType }, "auth webhook: user.created payload missing id or email");
      res.status(400).json({ error: "invalid user record" });
      return;
    }

    try {
      const result = await runPostSignupBootstrap(db, {
        userId: user.id,
        email: user.email,
      });
      logger.info(
        {
          userId: user.id,
          email: user.email,
          provider: user.provider,
          promotedToInstanceAdmin: result.promotedToInstanceAdmin,
          consumedInvite: result.consumedInvite,
        },
        "auth webhook: user.created handled",
      );
      res.status(200).json({ ok: true, result });
    } catch (err) {
      // Webhook must be idempotent. A failed bootstrap is logged but the
      // webhook is still ACK'd to avoid infinite retries — the user can
      // always be promoted manually. If we 5xx'd, Supabase would replay.
      logger.error({ err, userId: user.id }, "auth webhook: runPostSignupBootstrap threw — acking anyway");
      res.status(200).json({ ok: false, error: "bootstrap_failed" });
    }
  });

  return router;
}
