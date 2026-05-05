/**
 * hubspot-ingest.ts — HubSpot read path (S2.5)
 *
 * Pulls contacts and deals from HubSpot via Composio's managed APIs.
 * Maps to normalized event rows for funnel diagnostics + churn analysis.
 *
 * Design:
 *   - Uses Composio v3 client (no hand-rolled HubSpot API calls)
 *   - CRITICAL: threads `connectedAccountId` from workspace's Composio connection
 *     to prevent cross-org leaks (PR #30). Every runComposioTool call includes it.
 *   - Watermarks per workspace (lastSyncAt) to fetch only deltas after first sync
 *   - First sync caps at last 90d to avoid pulling history on reconnect
 *
 * Composio HubSpot tool slugs used:
 *   - HUBSPOT_CRM_GET_CONTACTS: fetch contacts modified since a date
 *   - HUBSPOT_CRM_GET_DEALS: fetch deals modified since a date
 *
 * Events emitted:
 *   - contact.created | contact.lifecycle_changed (entity_type: 'contact')
 *   - deal.stage_changed | deal.closed_won | deal.closed_lost (entity_type: 'deal')
 *
 * Dedup strategy:
 *   - Contacts: dedupKey = `<contact_id>:<lifecycle_stage>` so lifecycle changes
 *     don't dedup against the initial contact.created event
 *   - Deals: dedupKey = `<deal_id>:<stage>` so stage changes generate new events
 */

import type { Db } from "@founderos/db";
import { composioConnections } from "@founderos/db";
import { eq } from "drizzle-orm";
import { ingestEvent, type IngestEventInput } from "../event-ingest.js";
import { executeTool } from "../composio-client.js";
import { logger } from "../../middleware/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface HubSpotIngestInput {
  companyId: string;
  db: Db;
}

export interface HubSpotIngestResult {
  contactsProcessed: number;
  dealsProcessed: number;
  syncedAt: Date;
  nextSyncAt: Date;
}

interface HubSpotContact {
  id: string;
  properties: {
    lifecyclestage?: string;
    firstname?: string;
    lastname?: string;
    email?: string;
    [key: string]: unknown;
  };
  archived?: boolean;
  hs_object_id?: string;
}

interface HubSpotDeal {
  id: string;
  properties: {
    dealstage?: string;
    dealname?: string;
    closedate?: string;
    amount?: string;
    [key: string]: unknown;
  };
  archived?: boolean;
  hs_object_id?: string;
}

interface ComposioContactsResponse {
  data?: {
    contacts?: HubSpotContact[];
    paging?: {
      next?: {
        after?: string;
      };
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface ComposioDealsResponse {
  data?: {
    deals?: HubSpotDeal[];
    paging?: {
      next?: {
        after?: string;
      };
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const FIRST_SYNC_LOOKBACK_DAYS = 90;

/**
 * Ingest HubSpot data (contacts + deals) for a given workspace/company.
 *
 * Flow:
 *  1. Fetch the workspace's active HubSpot Composio connection
 *  2. Read the watermark (lastSyncAt) to determine fetch scope
 *  3. Fetch contacts modified since watermark (or last 90d on first sync)
 *  4. Emit contact.created and contact.lifecycle_changed events
 *  5. Fetch deals modified since watermark
 *  6. Emit deal.stage_changed | deal.closed_won | deal.closed_lost events
 *  7. Update watermark for next sync
 */
export async function hubspotIngestService(
  input: HubSpotIngestInput,
): Promise<HubSpotIngestResult> {
  const { companyId, db } = input;

  // ─── Step 1: Fetch workspace's HubSpot connection ───────────────────────

  const connection = await db
    .select()
    .from(composioConnections)
    .where(
      eq(composioConnections.companyId, companyId) &&
        eq(composioConnections.appName, "hubspot"),
    )
    .limit(1);

  if (connection.length === 0) {
    logger.warn({ companyId }, "hubspot-ingest: no active HubSpot connection for workspace");
    return {
      contactsProcessed: 0,
      dealsProcessed: 0,
      syncedAt: new Date(),
      nextSyncAt: new Date(Date.now() + DEFAULT_SYNC_INTERVAL_MS),
    };
  }

  const conn = connection[0];
  const connectedAccountId = conn.composioConnectionId;

  // ─── Step 2: Determine sync scope from watermark ──────────────────────

  let lastSyncAt: Date | null = null;
  try {
    // Store watermark as a JSON property on the connection row (optional extension)
    // For now, we'll compute: if updatedAt is recent (< 30min), assume this is first sync after connect
    const timeSinceUpdate = Date.now() - conn.updatedAt.getTime();
    const isFirstSync = timeSinceUpdate > DEFAULT_SYNC_INTERVAL_MS;

    if (isFirstSync) {
      // First sync: cap at last 90 days
      lastSyncAt = new Date(Date.now() - FIRST_SYNC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
      logger.info(
        { companyId, lastSyncAt },
        "hubspot-ingest: first sync, using 90d lookback",
      );
    } else {
      // Subsequent sync: use last update time as watermark
      lastSyncAt = conn.updatedAt;
      logger.info({ companyId, lastSyncAt }, "hubspot-ingest: delta sync since last update");
    }
  } catch (err) {
    logger.error({ err, companyId }, "hubspot-ingest: error determining sync scope");
    throw err;
  }

  let contactsProcessed = 0;
  let dealsProcessed = 0;

  // ─── Step 3: Fetch and ingest contacts ──────────────────────────────

  try {
    const modifiedAfterISO = lastSyncAt.toISOString();
    const contactsResult = (await executeTool({
      userId: conn.userId,
      toolName: "HUBSPOT_CRM_GET_CONTACTS",
      connectedAccountId,
      params: {
        limit: 100,
        after: undefined,
        filters: {
          filterGroups: [
            {
              filters: [
                {
                  propertyName: "hs_analytics_num_page_views",
                  operator: "EX", // EXISTS — match all contacts
                },
              ],
            },
          ],
          sorts: [
            {
              propertyName: "hs_lastmodifieddate",
              direction: "ASCENDING",
            },
          ],
        },
      },
    })) as any;

    if (contactsResult.ok && contactsResult.output?.data?.contacts) {
      const contacts: HubSpotContact[] = contactsResult.output.data.contacts;

      for (const contact of contacts) {
        // Only ingest if modified after our watermark
        const lastModified = contact.properties?.hs_lastmodifieddate
          ? new Date(contact.properties.hs_lastmodifieddate as string)
          : new Date();

        if (lastModified < lastSyncAt) {
          continue; // Skip contacts before watermark
        }

        const lifecycleStage = contact.properties?.lifecyclestage ?? "unknown";
        const dedupKey = `${contact.id}:${lifecycleStage}`;

        // Determine event type based on lifecycle stage
        let eventName = "contact.created";
        if (lifecycleStage !== "subscriber" && lifecycleStage !== "unknown") {
          eventName = "contact.lifecycle_changed";
        }

        const ingestPayload: IngestEventInput = {
          companyId,
          source: "hubspot",
          entityType: "contact",
          eventName,
          dedupKey,
          occurredAt: lastModified,
          payload: {
            contactId: contact.id,
            email: contact.properties?.email,
            firstName: contact.properties?.firstname,
            lastName: contact.properties?.lastname,
            lifecycleStage,
            archived: contact.archived ?? false,
          },
        };

        try {
          await ingestEvent(ingestPayload);
          contactsProcessed++;
        } catch (ingestErr) {
          logger.error(
            { err: ingestErr, contactId: contact.id, companyId },
            "hubspot-ingest: failed to ingest contact event",
          );
          // Continue processing other contacts on error
        }
      }

      logger.info({ companyId, contactsProcessed }, "hubspot-ingest: contacts synced");
    }
  } catch (err) {
    logger.error({ err, companyId }, "hubspot-ingest: failed to fetch contacts");
    // Don't throw; continue to deals
  }

  // ─── Step 4: Fetch and ingest deals ─────────────────────────────────

  try {
    const dealsResult = (await executeTool({
      userId: conn.userId,
      toolName: "HUBSPOT_CRM_GET_DEALS",
      connectedAccountId,
      params: {
        limit: 100,
        after: undefined,
        filters: {
          filterGroups: [
            {
              filters: [
                {
                  propertyName: "dealstage",
                  operator: "EX", // EXISTS — match all deals
                },
              ],
            },
          ],
          sorts: [
            {
              propertyName: "hs_lastmodifieddate",
              direction: "ASCENDING",
            },
          ],
        },
      },
    })) as any;

    if (dealsResult.ok && dealsResult.output?.data?.deals) {
      const deals: HubSpotDeal[] = dealsResult.output.data.deals;

      for (const deal of deals) {
        // Only ingest if modified after our watermark
        const lastModified = deal.properties?.hs_lastmodifieddate
          ? new Date(deal.properties.hs_lastmodifieddate as string)
          : new Date();

        if (lastModified < lastSyncAt) {
          continue; // Skip deals before watermark
        }

        const stage = deal.properties?.dealstage ?? "unknown";
        const dedupKey = `${deal.id}:${stage}`;

        // Map stage to event name
        let eventName = "deal.stage_changed";
        if (stage === "closedwon") {
          eventName = "deal.closed_won";
        } else if (stage === "closedlost") {
          eventName = "deal.closed_lost";
        }

        const ingestPayload: IngestEventInput = {
          companyId,
          source: "hubspot",
          entityType: "deal",
          eventName,
          dedupKey,
          occurredAt: lastModified,
          payload: {
            dealId: deal.id,
            dealName: deal.properties?.dealname,
            stage,
            amount: deal.properties?.amount,
            closeDate: deal.properties?.closedate,
            archived: deal.archived ?? false,
          },
        };

        try {
          await ingestEvent(ingestPayload);
          dealsProcessed++;
        } catch (ingestErr) {
          logger.error(
            { err: ingestErr, dealId: deal.id, companyId },
            "hubspot-ingest: failed to ingest deal event",
          );
          // Continue processing other deals on error
        }
      }

      logger.info({ companyId, dealsProcessed }, "hubspot-ingest: deals synced");
    }
  } catch (err) {
    logger.error({ err, companyId }, "hubspot-ingest: failed to fetch deals");
    // Non-fatal; both contact and deal syncs can partially fail
  }

  // ─── Step 5: Update watermark ────────────────────────────────────────

  const syncedAt = new Date();
  const nextSyncAt = new Date(syncedAt.getTime() + DEFAULT_SYNC_INTERVAL_MS);

  try {
    // Update the connection's updatedAt timestamp to serve as watermark
    await db
      .update(composioConnections)
      .set({ updatedAt: syncedAt })
      .where(eq(composioConnections.id, conn.id));

    logger.info(
      { companyId, syncedAt, nextSyncAt },
      "hubspot-ingest: watermark updated",
    );
  } catch (err) {
    logger.error(
      { err, companyId },
      "hubspot-ingest: failed to update watermark (non-fatal)",
    );
    // Non-fatal; continuing without watermark update means next sync might re-ingest
  }

  return {
    contactsProcessed,
    dealsProcessed,
    syncedAt,
    nextSyncAt,
  };
}
