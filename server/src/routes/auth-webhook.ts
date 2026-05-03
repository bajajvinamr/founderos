/**
 * Supabase Auth webhook endpoint.
 *
 * POST /api/auth/webhook
 *
 * Supabase fires signed webhooks when user accounts change (user.created,
 * user.updated, etc.). We verify the HMAC-SHA256 signature using a shared
 * `SUPABASE_WEBHOOK_SECRET` and log the event for audit, but we DO NOT
 * grant any roles or consume invites here.
 *
 * --- Email-squatting note (council 2026-05-03 P2 — Gemini) ---
 * The Supabase `user.created` webhook fires immediately on registration,
 * BEFORE email confirmation. Granting instance_admin (or consuming an
 * invite tied to an email) on this hook is an email-squatting vector: an
 * attacker who registers `ceo@target.com` could claim admin without ever
 * owning the inbox. Bootstrap is therefore deferred to the FIRST
 * AUTHENTICATED REQUEST via `maybeBootstrapNewUser` in `middleware/auth.ts`,
 * which only fires after Supabase has signed-in the user (i.e. after the
 * user has proven they own the email by clicking the confirm link OR
 * authenticated via an OAuth provider that already verified the email).
 *
 * Why keep the webhook at all? Three reasons:
 *  1. Audit log: we record signup events (with verified Supabase signature)
 *     for the admin console and analytics.
 *  2. Rate-limit signal for abuse detection.
 *  3. Forward-compat: future hooks (welcome email triggered post-confirm,
 *     admin notification, etc.) can mount here without re-introducing
 *     squatting risk.
 */

import { Router, type Request, type Response } from "express";
import type { Db } from "@founderos/db";
import {
  extractSupabaseUserFromWebhook,
  verifySupabaseWebhookSignature,
} from "../auth/supabase.js";
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

    const rawBody = req.rawBody;
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

    // Audit-only path. Bootstrap (admin promotion + invite consume) is
    // deferred to first authenticated request — see header comment.
    void db; // intentionally unused; kept in signature for forward-compat (admin notification, analytics, etc.)
    logger.info(
      {
        userId: user.id,
        email: user.email,
        provider: user.provider,
        eventType,
      },
      "auth webhook: user.created acknowledged (no bootstrap — deferred to first authed request)",
    );
    res.status(200).json({
      ok: true,
      action: "acknowledged",
      note: "bootstrap deferred to first authenticated request",
    });
  });

  return router;
}
