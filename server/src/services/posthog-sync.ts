/**
 * PostHog sync service.
 *
 * Pulls funnel event counts and UTM source breakdown from PostHog, then writes
 * them into the integration_data table (upsert). On success it marks the
 * integration as "connected"; on failure it flips status to "error" and stores
 * the error message.
 */

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { integrationData, integrations } from "@founderos/db";
import { createPostHogClient, PostHogAuthError } from "./posthog-client.js";
import { logger } from "../middleware/logger.js";

const FUNNEL_EVENTS = [
  "$pageview",
  "signed_up",
  "activated",
  "trial_started",
  "became_paying_customer",
] as const;

const PERIOD_DAYS = 30;

export type SyncResult =
  | { ok: true; synced: string[] }
  | { ok: false; error: string };

export async function syncPostHog(params: {
  db: Db;
  integrationId: string;
  companyId: string;
  decryptedApiKey: string;
  host?: string;
}): Promise<SyncResult> {
  const { db, integrationId, companyId, decryptedApiKey, host } = params;

  const client = createPostHogClient({ apiKey: decryptedApiKey, host });

  try {
    // 1. Resolve project ID
    const projects = await client.listProjects();
    if (projects.length === 0) {
      throw new Error("No PostHog projects found for this API key");
    }
    const projectId = projects[0].id;

    const since = new Date(Date.now() - PERIOD_DAYS * 24 * 60 * 60 * 1000);

    // 2. Fetch event counts + UTM breakdown in parallel
    const [eventCounts, utmBreakdown] = await Promise.all([
      client.getEventCounts(projectId, [...FUNNEL_EVENTS], since),
      client.getUtmSourceBreakdown(projectId, since),
    ]);

    // 3. Build payloads
    const funnelPayload = {
      pageviews: eventCounts["$pageview"] ?? 0,
      signups: eventCounts["signed_up"] ?? 0,
      activations: eventCounts["activated"] ?? 0,
      trials: eventCounts["trial_started"] ?? 0,
      paid: eventCounts["became_paying_customer"] ?? 0,
      periodDays: PERIOD_DAYS,
    };

    const channelsPayload = {
      channels: utmBreakdown,
      periodDays: PERIOD_DAYS,
    };

    const now = new Date();

    // 4. Upsert both rows
    await db
      .insert(integrationData)
      .values([
        {
          companyId,
          integrationId,
          kind: "posthog.funnel",
          payload: funnelPayload,
          fetchedAt: now,
        },
        {
          companyId,
          integrationId,
          kind: "posthog.channels.utm_source",
          payload: channelsPayload,
          fetchedAt: now,
        },
      ])
      .onConflictDoUpdate({
        target: [
          integrationData.companyId,
          integrationData.integrationId,
          integrationData.kind,
        ],
        set: {
          payload: sql`excluded.payload`,
          fetchedAt: sql`now()`,
        },
      });

    // 5. Mark integration as connected + clear any previous error
    await db
      .update(integrations)
      .set({ status: "connected", lastError: null, updatedAt: now })
      .where(
        and(
          eq(integrations.id, integrationId),
          eq(integrations.companyId, companyId),
        ),
      );

    logger.info(
      { integrationId, companyId },
      "posthog-sync: sync completed successfully",
    );

    return {
      ok: true,
      synced: ["posthog.funnel", "posthog.channels.utm_source"],
    };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error during PostHog sync";

    if (err instanceof PostHogAuthError) {
      logger.warn({ integrationId, companyId }, `posthog-sync: auth error — ${message}`);
    } else {
      logger.error({ err, integrationId, companyId }, "posthog-sync: sync failed");
    }

    // Update integration status to error
    try {
      await db
        .update(integrations)
        .set({
          status: "error",
          lastError: message,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(integrations.id, integrationId),
            eq(integrations.companyId, companyId),
          ),
        );
    } catch (updateErr) {
      logger.error(
        { updateErr, integrationId },
        "posthog-sync: failed to update integration status to error",
      );
    }

    return { ok: false, error: message };
  }
}
