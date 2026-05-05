/**
 * content-tracking.ts — Content tracking link redirect (S4.3)
 *
 *   GET /c/:trackingId
 *        Redirects to the published URL after logging a click event.
 *        The trackingId is the content draft's ID. Uses the draft's publishedUrl
 *        from the content_drafts table.
 *
 *        Click events are ingested with:
 *        { source: 'content', entity_type: 'link_click', event_name: 'click',
 *          payload: { draftId, format, refererHost } }
 *
 *        Synthetic dedup key: synth:click:${draftId}:${ts}:${visitorId ?? 'anon'}
 *
 * Public-facing endpoint (no auth required). Mounted at root level.
 */

import { Router } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { contentDrafts, companies } from "@founderos/db";
import { ingestEvent } from "../services/event-ingest.js";
import { logger } from "../middleware/logger.js";

export function contentTrackingRoutes(db: Db) {
  const router = Router();

  /**
   * GET /c/:trackingId
   *
   * Redirect to the published URL after logging a click event.
   * The tracking link is public and requires no authentication.
   */
  router.get("/c/:trackingId", async (req, res) => {
    try {
      const trackingId = req.params.trackingId as string;
      const refererHost = req.get("referer")
        ? new URL(req.get("referer")!).hostname
        : undefined;

      // Fetch the draft from the database
      const [draft] = await db
        .select({
          id: contentDrafts.id,
          format: contentDrafts.format,
          publishedToUrl: contentDrafts.publishedToUrl,
          companyId: contentDrafts.companyId,
          status: contentDrafts.status,
        })
        .from(contentDrafts)
        .where(eq(contentDrafts.id, trackingId))
        .limit(1);

      if (!draft) {
        logger.info(
          { trackingId },
          "content-tracking: draft not found (404)",
        );
        res.status(404).json({ error: "Tracking link not found" });
        return;
      }

      if (!draft.publishedToUrl || draft.status !== "published") {
        logger.info(
          { trackingId, status: draft.status },
          "content-tracking: draft not published (404)",
        );
        res.status(404).json({ error: "Content not published" });
        return;
      }

      // Ingest the click event
      const now = new Date();
      const visitorId = req.headers["user-agent"] ?? "anon"; // Simplified visitor ID — can improve with IP + UA hashing
      const dedupKey = `synth:click:${trackingId}:${now.getTime()}:${visitorId}`;

      try {
        await ingestEvent({
          companyId: draft.companyId,
          source: "posthog", // Click events are tracked via PostHog integration
          entityType: "link_click",
          eventName: "click",
          dedupKey,
          occurredAt: now,
          payload: {
            draftId: trackingId,
            format: draft.format,
            refererHost,
          },
        });
      } catch (error) {
        // Log the error but don't fail the redirect — tracking is best-effort
        logger.error(
          { trackingId, error },
          "content-tracking: failed to ingest click event",
        );
      }

      // Redirect to the published URL
      res.redirect(302, draft.publishedToUrl);
    } catch (error) {
      logger.error({ error }, "content-tracking: unexpected error");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
