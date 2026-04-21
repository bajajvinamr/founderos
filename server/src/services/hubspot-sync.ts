/**
 * HubSpot sync service.
 *
 * Pulls deal pipelines and deals from HubSpot, then writes them into
 * the integration_data table (upsert). On success marks the integration
 * as "connected"; on failure flips status to "error" and stores the message.
 */

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { integrationData, integrations } from "@founderos/db";
import {
  createHubspotClient,
  HubspotAuthError,
  type HubspotPipelineStage,
  type HubspotDeal,
} from "./hubspot-client.js";
import { logger } from "../middleware/logger.js";

export type SyncResult =
  | { ok: true; synced: string[] }
  | { ok: false; error: string };

// ─── Payload shapes ───────────────────────────────────────────────────────────

export interface HubspotDealCard {
  id: string;
  name: string;
  amount: number; // dollars
  stageId: string;
  stageLabel: string;
  lastTouchAt: string | null; // ISO date or null
  ownerName: string; // owner id or "—" (no owner lookup in v1)
}

export interface HubspotPipelineStageData {
  id: string;
  label: string;
  count: number;
  totalCents: number;
  weightedCents: number;
  deals: HubspotDealCard[];
}

export interface HubspotPipelinePayload {
  pipelineName: string;
  totalDeals: number;
  stages: HubspotPipelineStageData[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDollars(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? 0 : parsed;
}

function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

function stageProbability(stage: HubspotPipelineStage): number {
  const raw = stage.metadata?.probability;
  if (!raw) return 1; // no probability → treat as 100%
  const n = parseFloat(raw);
  return isNaN(n) ? 1 : Math.min(1, Math.max(0, n));
}

function buildDealCard(
  deal: HubspotDeal,
  stageMap: Map<string, HubspotPipelineStage>,
): HubspotDealCard {
  const props = deal.properties;
  const stageId = props.dealstage ?? "";
  const stage = stageMap.get(stageId);
  const stageLabel = stage?.label ?? stageId;

  return {
    id: deal.id,
    name: props.dealname ?? "(no name)",
    amount: parseDollars(props.amount),
    stageId,
    stageLabel,
    lastTouchAt: props.closedate ?? null,
    ownerName: props.hubspot_owner_id ?? "—",
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function syncHubspot(params: {
  db: Db;
  integrationId: string;
  companyId: string;
  decryptedApiKey: string;
}): Promise<SyncResult> {
  const { db, integrationId, companyId, decryptedApiKey } = params;

  const client = createHubspotClient({ accessToken: decryptedApiKey });

  try {
    // 1. Fetch pipelines — pick the default/first one
    const pipelines = await client.getDealPipelines();
    if (pipelines.length === 0) {
      throw new Error("No HubSpot deal pipelines found for this access token");
    }

    // Prefer a pipeline labeled "default" (case-insensitive), otherwise use the first
    const pipeline =
      pipelines.find((p) => p.label.toLowerCase() === "default") ?? pipelines[0];

    const stageMap = new Map<string, HubspotPipelineStage>(
      pipeline.stages.map((s) => [s.id, s]),
    );

    // Sort stages by displayOrder for consistent column ordering
    const orderedStages = [...pipeline.stages].sort(
      (a, b) => a.displayOrder - b.displayOrder,
    );

    // 2. Fetch up to 200 deals for this pipeline
    const deals = await client.getDeals(pipeline.id);

    // 3. Group by stage and compute aggregates
    const stageDeals = new Map<string, HubspotDealCard[]>();
    for (const stage of orderedStages) {
      stageDeals.set(stage.id, []);
    }

    for (const deal of deals) {
      const card = buildDealCard(deal, stageMap);
      const bucket = stageDeals.get(card.stageId) ?? [];
      stageDeals.set(card.stageId, [...bucket, card]);
    }

    const stages: HubspotPipelineStageData[] = orderedStages.map((stage) => {
      const cards = stageDeals.get(stage.id) ?? [];
      const prob = stageProbability(stage);
      let totalCents = 0;
      let weightedCents = 0;

      for (const card of cards) {
        const cents = toCents(card.amount);
        totalCents += cents;
        weightedCents += Math.round(cents * prob);
      }

      return {
        id: stage.id,
        label: stage.label,
        count: cards.length,
        totalCents,
        weightedCents,
        deals: cards,
      };
    });

    const payload: HubspotPipelinePayload = {
      pipelineName: pipeline.label,
      totalDeals: deals.length,
      stages,
    };

    const now = new Date();

    // 4. Upsert into integration_data
    await db
      .insert(integrationData)
      .values({
        companyId,
        integrationId,
        kind: "hubspot.pipeline",
        payload: payload as unknown as Record<string, unknown>,
        fetchedAt: now,
      })
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

    // 5. Mark integration as connected
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
      { integrationId, companyId, totalDeals: deals.length },
      "hubspot-sync: sync completed successfully",
    );

    return { ok: true, synced: ["hubspot.pipeline"] };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error during HubSpot sync";

    if (err instanceof HubspotAuthError) {
      logger.warn(
        { integrationId, companyId },
        `hubspot-sync: auth error — ${message}`,
      );
    } else {
      logger.error({ err, integrationId, companyId }, "hubspot-sync: sync failed");
    }

    try {
      await db
        .update(integrations)
        .set({ status: "error", lastError: message, updatedAt: new Date() })
        .where(
          and(
            eq(integrations.id, integrationId),
            eq(integrations.companyId, companyId),
          ),
        );
    } catch (updateErr) {
      logger.error(
        { updateErr, integrationId },
        "hubspot-sync: failed to update integration status to error",
      );
    }

    return { ok: false, error: message };
  }
}
