/**
 * Wave 17A — Daily digest routes.
 *
 *   GET  /api/digest/preview?companyId=&timezone=
 *        Renders the current-state digest for the logged-in user. Handy for
 *        the settings page's "preview my morning email" button.
 *
 *   POST /api/digest/prefs
 *        Body: { companyId, enabled?, hourLocal?, timezone? }
 *        Updates the caller's per-company digest preferences.
 *
 *   POST /api/digest/unsubscribe/:token
 *        Public endpoint — no auth. Verifies an HMAC-signed token and
 *        disables the digest for the embedded (userId, companyId) pair.
 */

import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@founderos/db";
import { companyMemberships } from "@founderos/db";
import { badRequest, forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  buildDailyDigest,
  resolveUnsubscribeSecret,
  verifyUnsubscribeToken,
} from "../services/daily-digest.js";
import { assertCompanyAccess } from "./authz.js";
import { digestUnsubscribeLimiter } from "../middleware/rate-limit.js";

function requireUserActor(req: Request): string {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  const userId = req.actor.userId;
  if (!userId) {
    throw forbidden("Authenticated user required");
  }
  return userId;
}

const prefsSchema = z.object({
  companyId: z.string().uuid(),
  enabled: z.boolean().optional(),
  hourLocal: z.number().int().min(0).max(23).optional(),
  timezone: z.string().min(1).max(64).optional(),
});

export function digestRoutes(db: Db, opts: { publicUrl?: string } = {}) {
  const router = Router();

  /**
   * GET /api/digest/preview
   * Query: ?companyId=&timezone=
   */
  router.get("/digest/preview", async (req, res) => {
    const userId = requireUserActor(req);
    const companyId = String(req.query.companyId ?? "").trim();
    if (!companyId) {
      throw badRequest("companyId query param is required");
    }
    assertCompanyAccess(req, companyId);

    const tzParam = typeof req.query.timezone === "string" ? req.query.timezone : undefined;

    // Inherit timezone from the membership row when the caller doesn't supply
    // one explicitly, so the preview matches what the cron would send.
    let tz = tzParam;
    if (!tz) {
      const [row] = await db
        .select({ tz: companyMemberships.digestTimezone })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
          ),
        )
        .limit(1);
      tz = row?.tz ?? "UTC";
    }

    const digest = await buildDailyDigest(db, companyId, userId, {
      publicUrl: opts.publicUrl,
      timezone: tz,
    });

    if (!digest) {
      res.json({
        empty: true,
        reason: "No pending decisions, no activity, no failing agents.",
      });
      return;
    }

    res.json({
      empty: false,
      subject: digest.subject,
      html: digest.html,
      text: digest.text,
      metrics: digest.metrics,
    });
  });

  /**
   * GET /api/digest/prefs?companyId=
   * Returns the caller's current digest preferences for the given company.
   */
  router.get("/digest/prefs", async (req, res) => {
    const userId = requireUserActor(req);
    const companyId = String(req.query.companyId ?? "").trim();
    if (!companyId) {
      throw badRequest("companyId query param is required");
    }
    assertCompanyAccess(req, companyId);

    const [row] = await db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
        ),
      )
      .limit(1);

    if (!row) {
      throw notFound("No membership found for this user in that company");
    }

    res.json({
      companyId: row.companyId,
      digestEnabled: row.digestEnabled,
      digestHourLocal: row.digestHourLocal,
      digestTimezone: row.digestTimezone,
      digestLastSentAt: row.digestLastSentAt,
    });
  });

  /**
   * POST /api/digest/prefs
   */
  router.post("/digest/prefs", validate(prefsSchema), async (req, res) => {
    const userId = requireUserActor(req);
    const { companyId, enabled, hourLocal, timezone } = req.body as z.infer<typeof prefsSchema>;
    assertCompanyAccess(req, companyId);

    const now = new Date();
    const update: Partial<typeof companyMemberships.$inferInsert> = { updatedAt: now };
    if (enabled !== undefined) update.digestEnabled = enabled;
    if (hourLocal !== undefined) update.digestHourLocal = hourLocal;
    if (timezone !== undefined) update.digestTimezone = timezone;

    const [updated] = await db
      .update(companyMemberships)
      .set(update)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
        ),
      )
      .returning();

    if (!updated) {
      throw notFound("No membership found for this user in that company");
    }

    res.json({
      companyId: updated.companyId,
      digestEnabled: updated.digestEnabled,
      digestHourLocal: updated.digestHourLocal,
      digestTimezone: updated.digestTimezone,
      digestLastSentAt: updated.digestLastSentAt,
    });
  });

  /**
   * POST /api/digest/unsubscribe/:token
   * Public — no auth middleware required. Token is HMAC-signed so the
   * server trusts it without needing a cookie.
   */
  router.post("/digest/unsubscribe/:token", digestUnsubscribeLimiter, async (req, res) => {
    const token = String(req.params.token ?? "");
    const verified = verifyUnsubscribeToken(token, resolveUnsubscribeSecret());
    if (!verified) {
      throw badRequest("Invalid or expired unsubscribe token");
    }

    const now = new Date();
    await db
      .update(companyMemberships)
      .set({ digestEnabled: false, updatedAt: now })
      .where(
        and(
          eq(companyMemberships.companyId, verified.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, verified.userId),
        ),
      );

    res.json({ ok: true, companyId: verified.companyId });
  });

  // GET alias for unsubscribe so one-click email links work without JS. Mail
  // clients send a GET when the user clicks the raw link.
  router.get("/digest/unsubscribe/:token", digestUnsubscribeLimiter, async (req, res) => {
    const token = String(req.params.token ?? "");
    const verified = verifyUnsubscribeToken(token, resolveUnsubscribeSecret());
    if (!verified) {
      res.status(400).type("text/plain").send("Invalid or expired unsubscribe token");
      return;
    }

    const now = new Date();
    await db
      .update(companyMemberships)
      .set({ digestEnabled: false, updatedAt: now })
      .where(
        and(
          eq(companyMemberships.companyId, verified.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, verified.userId),
        ),
      );

    res
      .status(200)
      .type("text/html")
      .send(
        `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;max-width:480px;margin:0 auto"><h1 style="font-size:18px">Unsubscribed</h1><p>You won't receive any more daily digests for this company. You can turn them back on anytime in <a href="/settings/notifications">Notification settings</a>.</p></body></html>`,
      );
  });

  return router;
}
