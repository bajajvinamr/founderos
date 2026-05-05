/**
 * posthog-poll.ts — BullMQ polling job for PostHog event ingestion (S2.3)
 *
 * For companies without a configured PostHog webhook, this job fetches
 * new events every 15 minutes via the REST API.
 *
 * Watermark strategy:
 *   `config.lastPollAt` (ISO-8601) stored in `integrations.config` tracks
 *   the newest event timestamp seen in the previous run.
 *
 * BullMQ job name: posthog-poll
 * Schedule: every 15 minutes (configured at startup).
 *
 * Also exports the legacy stub interface for backward compat.
 */

import type { Db } from "@founderos/db";
import { and, eq } from "drizzle-orm";
import { integrations } from "@founderos/db";
import {
  createPostHogClient,
  PostHogAuthError,
  type PostHogRawEvent,
} from "./posthog-client.js";
import { decryptWithMasterKey } from "../secrets/local-encrypted-provider.js";
import { ingestEvent } from "./event-ingest-stub.js";
import { logger } from "../middleware/logger.js";

export const POSTHOG_POLL_QUEUE = "posthog-poll";
export const POSTHOG_POLL_CRON = "*/15 * * * *";

export interface PostHogPollJobData {
  companyId: string;
  integrationId: string;
}

// Legacy stub interface (backward compat)
export interface PostHogPollInput {
  companyId: string;
  db: Db;
}

export async function pollPostHogEvents(_input: PostHogPollInput): Promise<void> {
  throw new Error("posthog-poll: use runPostHogPoll() instead");
}

// ─── Entity type mapping ──────────────────────────────────────────────────────

function resolveEntityType(eventName: string): string {
  if (eventName === "$pageview") return "pageview";
  if (eventName === "$identify") return "identify";
  if (eventName === "$autocapture") return "capture";
  return "event";
}

// ─── Core poll logic ──────────────────────────────────────────────────────────

/**
 * Run one poll cycle for a single PostHog integration.
 * Exported for unit testing.
 */
export async function runPostHogPoll(
  db: Db,
  { companyId, integrationId }: PostHogPollJobData,
): Promise<{ ingested: number; newWatermark: string | null }> {
  const [row] = await db
    .select()
    .from(integrations)
    .where(
      and(
        eq(integrations.id, integrationId),
        eq(integrations.companyId, companyId),
      ),
    );

  if (!row) {
    logger.warn({ integrationId, companyId }, "posthog-poll: integration not found");
    return { ingested: 0, newWatermark: null };
  }

  if (row.status === "disconnected" || !row.encryptedApiKey) {
    return { ingested: 0, newWatermark: null };
  }

  let apiKey: string;
  try {
    apiKey = decryptWithMasterKey(row.encryptedApiKey);
  } catch {
    logger.error({ integrationId, companyId }, "posthog-poll: failed to decrypt API key");
    return { ingested: 0, newWatermark: null };
  }

  const config = (row.config as Record<string, unknown>) ?? {};
  const projectId = typeof config["projectId"] === "string" ? config["projectId"] : null;
  const host = typeof config["host"] === "string" ? config["host"] : undefined;
  const lastPollAt = typeof config["lastPollAt"] === "string" ? config["lastPollAt"] : undefined;

  if (!projectId) {
    logger.warn({ integrationId, companyId }, "posthog-poll: no projectId in config, skipping");
    return { ingested: 0, newWatermark: null };
  }

  const client = createPostHogClient({ apiKey, host });

  let events: PostHogRawEvent[] = [];
  try {
    const page = await client.listEvents(Number(projectId), {
      after: lastPollAt,
      limit: 100,
    });
    events = page.events;
  } catch (err: unknown) {
    if (err instanceof PostHogAuthError) {
      await db
        .update(integrations)
        .set({ status: "error", lastError: "API key invalid or expired", updatedAt: new Date() })
        .where(eq(integrations.id, integrationId));
    }
    logger.error({ err, integrationId, companyId }, "posthog-poll: listEvents failed");
    return { ingested: 0, newWatermark: null };
  }

  if (events.length === 0) {
    return { ingested: 0, newWatermark: lastPollAt ?? null };
  }

  let ingested = 0;
  let newestTimestamp: string | null = lastPollAt ?? null;

  for (const event of events) {
    try {
      await ingestEvent({
        companyId,
        source: "posthog",
        entityType: resolveEntityType(event.event),
        eventName: event.event,
        sourceEventId: event.id,
        occurredAt: new Date(event.timestamp),
        payload: {
          distinctId: event.distinct_id,
          properties: event.properties,
        },
      });
      ingested++;

      if (!newestTimestamp || event.timestamp > newestTimestamp) {
        newestTimestamp = event.timestamp;
      }
    } catch (err: unknown) {
      logger.warn(
        { err, eventId: event.id, integrationId },
        "posthog-poll: ingestEvent failed for event (non-fatal)",
      );
    }
  }

  if (newestTimestamp && newestTimestamp !== lastPollAt) {
    const updatedConfig = { ...config, lastPollAt: newestTimestamp };
    await db
      .update(integrations)
      .set({ config: updatedConfig, updatedAt: new Date() })
      .where(eq(integrations.id, integrationId));

    logger.info(
      { integrationId, companyId, ingested, newWatermark: newestTimestamp },
      "posthog-poll: poll completed, watermark advanced",
    );
  }

  return { ingested, newWatermark: newestTimestamp };
}
