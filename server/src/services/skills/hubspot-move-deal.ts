/**
 * Skill: `hubspot.move_deal`
 *
 * Moves a HubSpot deal to a new pipeline stage by PATCHing its `dealstage`
 * property. Permission-gated identically to other Wave 18A HubSpot action skills.
 *
 * Permission semantics:
 *   - `observe`    → skill throws; nothing is written.
 *   - `draft`      → no external call; creates a `pending_approval` row.
 *   - `approve`    → same as `draft`.
 *   - `autonomous` → issues the PATCH immediately; logs
 *                    `hubspot.move_deal_executed` on success and
 *                    `hubspot.move_deal_failed` on error.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { integrations, approvals } from "@founderos/db";
import type { AgentPermissionLevel } from "@founderos/shared";
import { createHubspotClient, HubspotAuthError } from "../hubspot-client.js";
import { logActivity } from "../activity-log.js";
import { decryptWithMasterKey } from "../../secrets/local-encrypted-provider.js";
import { logger } from "../../middleware/logger.js";
import {
  evaluateComposioRoute,
  runComposioTool,
} from "./composio-skill-bridge.js";

export const HUBSPOT_MOVE_DEAL_SKILL_NAME = "hubspot.move_deal" as const;

export interface HubspotMoveDealInput {
  dealId: string;
  stageId: string;
}

export interface HubspotMoveDealContext {
  db: Db;
  companyId: string;
  permissionLevel: AgentPermissionLevel;
  agentId?: string | null;
  runId?: string | null;
  /** Wave 21: FounderOS user id for Composio routing. Optional. */
  userId?: string | null;
}

export type HubspotMoveDealResult =
  | { ok: true; status: "moved"; dealId: string; newStage: string }
  | { ok: true; status: "pending_approval"; approvalId: string }
  | { ok: false; reason: "no_integration"; message: string }
  | { ok: false; reason: "hubspot_error"; message: string }
  | { ok: false; reason: "composio_error"; message: string };

function validateInput(input: HubspotMoveDealInput): void {
  if (typeof input.dealId !== "string" || input.dealId.trim().length === 0) {
    throw new Error("hubspot.move_deal: `dealId` is required");
  }
  if (typeof input.stageId !== "string" || input.stageId.trim().length === 0) {
    throw new Error("hubspot.move_deal: `stageId` is required");
  }
}

async function createPendingApproval(params: {
  db: Db;
  companyId: string;
  agentId?: string | null;
  input: HubspotMoveDealInput;
  integrationId: string;
}): Promise<string> {
  const { db, companyId, agentId, input, integrationId } = params;
  const [row] = await db
    .insert(approvals)
    .values({
      companyId,
      type: "hubspot.move_deal",
      requestedByAgentId: agentId ?? null,
      status: "pending",
      payload: {
        skill: HUBSPOT_MOVE_DEAL_SKILL_NAME,
        integrationId,
        dealId: input.dealId,
        stageId: input.stageId,
      },
    })
    .returning({ id: approvals.id });
  return row.id;
}

export async function executeHubspotMoveDeal(
  ctx: HubspotMoveDealContext,
  input: HubspotMoveDealInput,
): Promise<HubspotMoveDealResult> {
  validateInput(input);

  const { db, companyId, permissionLevel, agentId, runId, userId } = ctx;

  if (permissionLevel === "observe") {
    throw new Error(
      `Observe mode: skill "${HUBSPOT_MOVE_DEAL_SKILL_NAME}" is not permitted`,
    );
  }

  // ── Wave 21: Composio routing (autonomous only) ────────────────────────
  if (permissionLevel === "autonomous" && userId) {
    const route = await evaluateComposioRoute({
      db,
      companyId,
      userId,
      appName: "hubspot",
    });
    if (route.shouldUse) {
      const composioOutcome = await runComposioTool({
        userId,
        connectedAccountId: route.composioConnectionId,
        toolName: "hubspot_update_deal",
        input: {
          dealId: input.dealId,
          properties: { dealstage: input.stageId },
        },
      });
      if (composioOutcome.ok) {
        const newStage =
          typeof (composioOutcome.output as { properties?: { dealstage?: string } })
            ?.properties?.dealstage === "string"
            ? ((composioOutcome.output as { properties: { dealstage: string } })
                .properties.dealstage as string)
            : input.stageId;
        await logActivity(db, {
          companyId,
          actorType: agentId ? "agent" : "system",
          actorId: agentId ?? "system",
          agentId: agentId ?? null,
          runId: runId ?? null,
          action: "hubspot.move_deal_executed",
          entityType: "integration",
          entityId: route.composioConnectionId ?? "composio",
          details: {
            skill: HUBSPOT_MOVE_DEAL_SKILL_NAME,
            dealId: input.dealId,
            newStage,
            permissionLevel,
            via: "composio",
          },
        }).catch(() => {});
        return { ok: true, status: "moved", dealId: input.dealId, newStage };
      }
      await logActivity(db, {
        companyId,
        actorType: agentId ? "agent" : "system",
        actorId: agentId ?? "system",
        agentId: agentId ?? null,
        runId: runId ?? null,
        action: "hubspot.move_deal_failed",
        entityType: "integration",
        entityId: route.composioConnectionId ?? "composio",
        details: {
          skill: HUBSPOT_MOVE_DEAL_SKILL_NAME,
          dealId: input.dealId,
          stageId: input.stageId,
          error: composioOutcome.message,
          via: "composio",
        },
      }).catch(() => {});
      return {
        ok: false,
        reason: "composio_error",
        message: composioOutcome.message,
      };
    }
  }

  const [integrationRow] = await db
    .select()
    .from(integrations)
    .where(
      and(
        eq(integrations.companyId, companyId),
        eq(integrations.kind, "hubspot"),
      ),
    );

  if (!integrationRow) {
    return {
      ok: false,
      reason: "no_integration",
      message: "HubSpot integration is not connected for this company",
    };
  }

  if (permissionLevel === "draft" || permissionLevel === "approve") {
    const approvalId = await createPendingApproval({
      db,
      companyId,
      agentId,
      input,
      integrationId: integrationRow.id,
    });

    await logActivity(db, {
      companyId,
      actorType: agentId ? "agent" : "system",
      actorId: agentId ?? "system",
      agentId: agentId ?? null,
      runId: runId ?? null,
      action: "hubspot.move_deal_pending_approval",
      entityType: "integration",
      entityId: integrationRow.id,
      details: {
        skill: HUBSPOT_MOVE_DEAL_SKILL_NAME,
        approvalId,
        dealId: input.dealId,
        stageId: input.stageId,
        permissionLevel,
      },
    }).catch((err) => {
      logger.error(
        { err, companyId, approvalId },
        "hubspot-move-deal: failed to log pending approval activity",
      );
    });

    return {
      ok: true,
      status: "pending_approval",
      approvalId,
    };
  }

  if (permissionLevel !== "autonomous") {
    throw new Error(
      `Unknown permission level "${permissionLevel}" for skill "${HUBSPOT_MOVE_DEAL_SKILL_NAME}"`,
    );
  }

  if (!integrationRow.encryptedApiKey) {
    return {
      ok: false,
      reason: "no_integration",
      message: "HubSpot integration is missing its access token",
    };
  }

  let accessToken: string;
  try {
    accessToken = decryptWithMasterKey(integrationRow.encryptedApiKey);
  } catch (err) {
    logger.error(
      { err, companyId, integrationId: integrationRow.id },
      "hubspot-move-deal: failed to decrypt access token",
    );
    return {
      ok: false,
      reason: "hubspot_error",
      message: "Failed to decrypt HubSpot access token",
    };
  }

  const client = createHubspotClient({ accessToken });

  try {
    const updated = await client.updateDealStage(input.dealId, input.stageId);
    const newStage =
      typeof updated.properties?.dealstage === "string"
        ? updated.properties.dealstage
        : input.stageId;

    await logActivity(db, {
      companyId,
      actorType: agentId ? "agent" : "system",
      actorId: agentId ?? "system",
      agentId: agentId ?? null,
      runId: runId ?? null,
      action: "hubspot.move_deal_executed",
      entityType: "integration",
      entityId: integrationRow.id,
      details: {
        skill: HUBSPOT_MOVE_DEAL_SKILL_NAME,
        dealId: input.dealId,
        newStage,
        permissionLevel,
        via: "native",
      },
    }).catch((err) => {
      logger.error(
        { err, companyId, integrationId: integrationRow.id },
        "hubspot-move-deal: failed to log audit entry",
      );
    });

    return {
      ok: true,
      status: "moved",
      dealId: input.dealId,
      newStage,
    };
  } catch (err: unknown) {
    const message =
      err instanceof HubspotAuthError
        ? "HubSpot access token is invalid or expired"
        : err instanceof Error
          ? err.message
          : "Unknown HubSpot error";

    await logActivity(db, {
      companyId,
      actorType: agentId ? "agent" : "system",
      actorId: agentId ?? "system",
      agentId: agentId ?? null,
      runId: runId ?? null,
      action: "hubspot.move_deal_failed",
      entityType: "integration",
      entityId: integrationRow.id,
      details: {
        skill: HUBSPOT_MOVE_DEAL_SKILL_NAME,
        dealId: input.dealId,
        stageId: input.stageId,
        error: message,
      },
    }).catch(() => {});

    logger.error(
      { err, companyId, integrationId: integrationRow.id },
      `hubspot-move-deal: updateDealStage failed — ${message}`,
    );

    return { ok: false, reason: "hubspot_error", message };
  }
}
