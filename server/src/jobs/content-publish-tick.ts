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
import { createEmailSender } from "../services/email-sender.js";
import type { Queue } from "bullmq";

// Format -> Composio tool name mapping
const COMPOSIO_TOOLS: Record<string, string> = {
  linkedin: "linkedin_post_content",
  "x-thread": "twitter_post_content",
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
    // Resolve connectedAccountId from the company's integrations
    // For now, we'll use a simple lookup from environment or config
    // This should be replaced with a real integration lookup per company
    const connectedAccountId = process.env[`COMPOSIO_AUTH_${format.toUpperCase()}`];

    if (format === "linkedin" || format === "x-thread") {
      // Publish via Composio
      const toolName = COMPOSIO_TOOLS[format];
      if (!toolName) {
        throw new Error(`Unknown format: ${format}`);
      }

      if (!connectedAccountId) {
        throw new Error(`No integration found for ${format}`);
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
        userId: "", // TODO: resolve from company's admin user
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
