/**
 * customer-email-unsubscribe — S4.8 prerequisite #196 layer 3b.
 *
 * Public, no-auth route that turns one-click email-link clicks into
 * customer_email_suppressions rows. Verifies the HMAC token from layer 2,
 * extracts (companyId, contactEmail, topic), creates a suppression row
 * via layer 3a's recordSuppression helper.
 *
 * Mounted at app-level (NOT under /api) — mirrors contentTrackingRoutes
 * at app.ts:446. Public-facing: no boardMutationGuard, no session cookie,
 * HMAC alone is the trust boundary.
 *
 * Both GET and POST registered:
 *   - GET for legacy email-client one-click behavior
 *   - POST for List-Unsubscribe-Post header per RFC 8058
 *
 * Council 2026-05-06 finding #4 (BLOCK) layer 3b. Closes the user-facing
 * surface that turns "click unsubscribe" into "supressed in DB". Layer 4
 * adds the Resend webhook receiver that auto-inserts on hard bounce + spam.
 *
 * Idempotency: the underlying recordSuppression uses ON CONFLICT DO NOTHING,
 * so replaying the same link is a no-op INSERT. Always returns 200 to the
 * user; the response body distinguishes "you're unsubscribed" (first click)
 * from "you're already unsubscribed" (replay) — both are success states from
 * the user's perspective.
 */

import { Router, type Request, type Response } from "express";
import type { Db } from "@founderos/db";
import { verifyUnsubscribeToken } from "../services/email-unsubscribe-tokens.js";
import { recordSuppression } from "../services/customer-email-suppressions.js";

export function customerEmailUnsubscribeRoutes(db: Db): Router {
  const router = Router();

  async function handle(req: Request, res: Response): Promise<void> {
    const token = String(req.params.token ?? "");
    const payload = verifyUnsubscribeToken(token);
    if (!payload) {
      res
        .status(400)
        .type("text/plain")
        .send(
          "Invalid or expired unsubscribe link.\n" +
            "If you continue to receive emails after attempting to unsubscribe, " +
            "reply directly to the sender.",
        );
      return;
    }

    const { inserted } = await recordSuppression(db, {
      companyId: payload.c,
      contactEmail: payload.e,
      topic: payload.t,
      reason: "user_unsubscribe",
      metadata: {
        token_ts: payload.ts,
        http_method: req.method,
        ua: req.get("user-agent") ?? null,
      },
    });

    const topicLabel = payload.t === "all" ? "all" : payload.t;
    const body = inserted
      ? `You're unsubscribed from ${topicLabel} emails.\n` +
        "To resubscribe, contact your sender directly."
      : `You're already unsubscribed from ${topicLabel} emails.\n` +
        "No further action needed.";

    res.status(200).type("text/plain").send(body);
  }

  router.get("/u/customer/:token", handle);
  router.post("/u/customer/:token", handle);

  return router;
}
