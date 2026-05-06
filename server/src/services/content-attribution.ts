/**
 * content-attribution.ts — Content attribution aggregation (S4.3)
 *
 * Aggregates clicks, signups, and revenue attributed to a specific content draft
 * over the last 30 days. Uses the events table as the canonical source:
 *   - Clicks: events where source='content', event_name='click', payload.draftId=draftId
 *   - Signups: events where event_name='identify', payload.utmCampaign matches draftId
 *   - Revenue: sum of events where source='stripe', event_name='subscription.created',
 *              payload.utmCampaign matches draftId
 *
 * Tenant isolation: all queries MUST filter on companyId.
 *
 * Payload contract:
 *   Content clicks: { draftId: string, format: string, refererHost?: string }
 *   Signups: { utmCampaign?: string, ... other PostHog identify fields }
 *   Stripe: { utmCampaign?: string, amount: number (in micros) }
 */

import { and, eq, count, sql, gte } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { events } from "@founderos/db";
import { logger } from "../middleware/logger.js";

export interface AttributionMetrics {
  clicks30d: number;
  signups: number;
  revenueMicros: number;
  attributionUtm: string;
}

/**
 * Fetch attribution metrics for a content draft.
 *
 * @param db — Drizzle instance
 * @param draftId — ID of the content draft
 * @param companyId — Company ID (tenant isolation)
 * @param attributionUtm — The UTM string generated at publish time
 * @returns Attribution metrics for the last 30 days
 */
export async function getAttribution(
  db: Db,
  draftId: string,
  companyId: string,
  attributionUtm: string,
): Promise<AttributionMetrics> {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  try {
    // Count clicks: events where event_name='click' and payload.draftId=draftId
    // Using ->> for text extraction to avoid JSON encoding issues
    const clickCountResult = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(events)
      .where(
        and(
          eq(events.companyId, companyId),
          eq(events.eventName, "click"),
          gte(events.occurredAt, thirtyDaysAgo),
          sql`${events.payload}->>'draftId' = ${draftId}`,
        ),
      );

    // Count signups: events where event_name='identify' and payload.utmCampaign matches draftId
    const signupCountResult = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(events)
      .where(
        and(
          eq(events.companyId, companyId),
          eq(events.eventName, "identify"),
          gte(events.occurredAt, thirtyDaysAgo),
          sql`${events.payload}->>'utmCampaign' = ${draftId}`,
        ),
      );

    // Sum revenue: events where source='stripe', event_name='subscription.created',
    // payload.utmCampaign matches draftId
    const revenueResult = await db
      .select({
        total: sql<number>`COALESCE(SUM(CAST(${events.payload}->>'amount' AS BIGINT)), 0)`,
      })
      .from(events)
      .where(
        and(
          eq(events.companyId, companyId),
          eq(events.source, "stripe"),
          eq(events.eventName, "subscription.created"),
          gte(events.occurredAt, thirtyDaysAgo),
          sql`${events.payload}->>'utmCampaign' = ${draftId}`,
        ),
      );

    const clicks30d = Number(clickCountResult[0]?.count ?? 0);
    const signups = Number(signupCountResult[0]?.count ?? 0);
    const revenueMicros = Number(revenueResult[0]?.total ?? 0);

    return {
      clicks30d,
      signups,
      revenueMicros,
      attributionUtm,
    };
  } catch (error) {
    logger.error(
      { draftId, companyId, error },
      "content-attribution: failed to compute attribution metrics",
    );
    // Return zeros on error rather than throwing — attribution is best-effort
    return {
      clicks30d: 0,
      signups: 0,
      revenueMicros: 0,
      attributionUtm,
    };
  }
}

/**
 * Generate a UTM string for a content draft at publish time.
 * Format: utm_source=founderos&utm_campaign=<draftId>&utm_medium=<format>
 */
export function generateAttributionUtm(draftId: string, format: string): string {
  return `utm_source=founderos&utm_campaign=${encodeURIComponent(draftId)}&utm_medium=${encodeURIComponent(format)}`;
}
