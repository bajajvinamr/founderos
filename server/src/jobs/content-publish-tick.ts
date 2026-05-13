/**
 * content-publish-tick — S4.4 Automated content publishing.
 *
 * BullMQ recurring job that runs every minute to:
 *   1. Query content_drafts where scheduled_for <= now() AND status = 'approved'
 *   2. For each draft, dispatch publish based on channel:
 *      - linkedin, x-thread → Composio tool call
 *      - newsletter → email service
 *      - blog → mark published (TODO: connect blog publish path)
 *   3. On success: status='published', publishedAt=now(), error=null
 *   4. On error: status='approved', error=message (truncated to 500 chars)
 *   5. Per-draft try/catch: one failure doesn't block others
 *   6. Idempotency: skip if publishedAt already set
 *
 * Integration: wired in server/src/jobs/index.ts via registerContentPublishTick(queue)
 */

import { and, eq, isNull, lte } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { contentDrafts } from "@founderos/db";
import { logger } from "../middleware/logger.js";
import { runComposioTool } from "../services/skills/composio-skill-bridge.js";
import {
  ComposioConnectionMissingError,
  resolveActiveConnection,
} from "../services/composio-connection-resolver.js";
import { createEmailSender } from "../services/email-sender.js";
import type { Queue } from "bullmq";

// Format -> Composio tool name mapping
const COMPOSIO_TOOLS: Record<string, string> = {
  linkedin: "linkedin_post_content",
  "x-thread": "twitter_post_content",
};

/**
 * Format -> Composio app slug used to look up the active per-company
 * connection. The slug is the same value stored in
 * `composio_connections.app_name` (e.g. `linkedin`, `twitter`) — keep this
 * table in sync with the route the founder uses to connect.
 */
const COMPOSIO_APPS: Record<string, string> = {
  linkedin: "linkedin",
  "x-thread": "twitter",
};

const RESEND_API_KEY = process.env.RESEND_API_KEY;

/**
 * Run the publish tick — query due drafts and publish them.
 */
export async function runContentPublishTick(db: Db): Promise<void> {
  const now = new Date();

  // Query drafts that are due and approved
  const dueDrafts = await db
    .select()
    .from(contentDrafts)
    .where(
      and(
        lte(contentDrafts.scheduledFor, now),
        eq(contentDrafts.status, "approved"),
        isNull(contentDrafts.publishedAt) // Skip already published (idempotency)
      )
    );

  logger.info(`content-publish-tick: found ${dueDrafts.length} due drafts`);

  // Process each draft independently
  for (const draft of dueDrafts) {
    try {
      await publishDraft(db, draft);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ message }, `content-publish-tick: draft ${draft.id} publish failed`);
      // Error is already logged and saved to draft.error; continue to next
    }
  }
}

/**
 * Publish a single draft based on its format/channel.
 */
async function publishDraft(db: Db, draft: typeof contentDrafts.$inferSelect): Promise<void> {
  const format = draft.format;

  try {
    if (format === "linkedin" || format === "x-thread") {
      // Publish via Composio
      const toolName = COMPOSIO_TOOLS[format];
      if (!toolName) {
        throw new Error(`Unknown format: ${format}`);
      }

      // Resolve BOTH userId and connectedAccountId from the company's
      // active Composio connection for this app. Source: composio_connections
      // row written when the founder OAuth-connected the integration. We use
      // its `userId` (the FounderOS user who owns the OAuth flow) for
      // Composio's per-user routing, and its `composio_connection_id` for
      // org-scoped credential targeting.
      //
      // The two-field resolution is structural: Composio v3
      // `executeTool({ userId, connectedAccountId })` uses both axes. Passing
      // `userId: ""` falls back to "any account for any user" — the same
      // failure class the cross-org leak fix (PR #30) closed for
      // `connectedAccountId`. This job had `userId: ""` as a known gap
      // pre-L2-A10 (TODO: resolve from company's admin user). Closed now via
      // resolveActiveConnection, which also runtime-guards against an empty
      // value sneaking through the DB layer.
      const appName = COMPOSIO_APPS[format];
      if (!appName) {
        // Defensive — COMPOSIO_APPS is keyed by the same format set as
        // COMPOSIO_TOOLS, but a mismatch should fail loud rather than
        // silently fall through to env-var fallback.
        throw new Error(`No composio app mapping for format: ${format}`);
      }
      let userId: string;
      let connectedAccountId: string;
      try {
        const conn = await resolveActiveConnection(db, draft.companyId, appName);
        userId = conn.userId;
        connectedAccountId = conn.connectedAccountId;
      } catch (err) {
        if (err instanceof ComposioConnectionMissingError) {
          throw new Error(
            `No active ${appName} integration for company ${draft.companyId} (status=${err.status})`,
          );
        }
        throw err;
      }

      // Belt-and-suspenders fail-fast at the job boundary. The resolver
      // already guards against empty/whitespace values on the active row,
      // but a defense-in-depth check here protects against any future
      // refactor that swaps the resolver for a lighter-weight lookup that
      // forgets the trim()/length check. Empty userId/connectedAccountId
      // to runComposioTool is the same shape as the cross-org leak.
      if (!userId || userId.trim().length === 0) {
        throw new Error(
          `content-publish-tick: resolved userId is empty for company ${draft.companyId} / ${appName} — refusing to call Composio`,
        );
      }
      if (!connectedAccountId || connectedAccountId.trim().length === 0) {
        throw new Error(
          `content-publish-tick: resolved connectedAccountId is empty for company ${draft.companyId} / ${appName} — refusing to call Composio`,
        );
      }

      // Extract content from payload
      const payload = draft.payload as Record<string, unknown>;
      let postContent = "";

      if (format === "linkedin") {
        const linkedInPayload = payload as { body: string };
        postContent = linkedInPayload.body;
      } else if (format === "x-thread") {
        const xPayload = payload as { tweets: string[] };
        postContent = xPayload.tweets.join("\n");
      }

      const result = await runComposioTool({
        userId,
        connectedAccountId,
        toolName,
        input: { content: postContent },
      });

      if (!result.ok) {
        throw new Error(`Composio error: ${result.message || result.reason}`);
      }

      // Mark as published
      await db
        .update(contentDrafts)
        .set({
          status: "published",
          publishedAt: new Date(),
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(contentDrafts.id, draft.id));

      logger.info(`content-publish-tick: published ${format} draft ${draft.id}`);
    } else if (format === "newsletter") {
      // Send via email
      const sender = createEmailSender({ apiKey: RESEND_API_KEY });
      if (!sender.enabled) {
        throw new Error("Email sender not configured");
      }

      const payload = draft.payload as { subject: string; body: string };
      const result = await sender.send({
        to: "", // TODO: resolve from company subscribers list
        subject: payload.subject,
        html: payload.body,
        text: payload.body.replace(/<[^>]*>/g, ""), // Strip HTML for plain text
      });

      if (!result.ok) {
        throw new Error(`Email send failed: ${result.error}`);
      }

      // Mark as published
      await db
        .update(contentDrafts)
        .set({
          status: "published",
          publishedAt: new Date(),
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(contentDrafts.id, draft.id));

      logger.info(`content-publish-tick: published newsletter draft ${draft.id}`);
    } else if (format === "landing" || format === "reel" || format === "ad") {
      // For v1, just mark as published (TODO: connect actual publish paths)
      await db
        .update(contentDrafts)
        .set({
          status: "published",
          publishedAt: new Date(),
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(contentDrafts.id, draft.id));

      logger.info(
        `content-publish-tick: marked ${format} draft ${draft.id} as published (TODO: connect publish)`
      );
    } else {
      throw new Error(`Unsupported format: ${format}`);
    }
  } catch (err) {
    const errorMessage = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    logger.error({ error: errorMessage }, `marking draft ${draft.id} as failed`);

    // Mark draft error without changing status
    await db
      .update(contentDrafts)
      .set({
        error: errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(contentDrafts.id, draft.id));

    throw err; // Re-throw to be logged by caller
  }
}

/**
 * Register the content-publish-tick recurring job.
 * Called from server/src/jobs/index.ts during app startup.
 */
export async function registerContentPublishTick(queue: Queue): Promise<void> {
  await queue.add(
    "content-publish-tick",
    {},
    {
      jobId: "content-publish-tick",
      repeat: {
        pattern: "*/1 * * * *", // Every minute
      },
      removeOnComplete: true, // Don't keep completed jobs
      removeOnFail: false, // Keep failed jobs for visibility
    }
  );

  logger.info("registered content-publish-tick recurring job");
}
