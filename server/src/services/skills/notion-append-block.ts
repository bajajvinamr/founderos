/**
 * Skill: `notion.append_block`
 *
 * Appends a paragraph block to an existing Notion page, gated by the
 * agent's permission level. Mirrors `notion.create_page` + the wider
 * Slack / HubSpot skill pattern.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { integrations, approvals } from "@founderos/db";
import type { AgentPermissionLevel } from "@founderos/shared";
import { createNotionClient, NotionAuthError } from "../notion-client.js";
import { logActivity } from "../activity-log.js";
import { decryptWithMasterKey } from "../../secrets/local-encrypted-provider.js";
import { logger } from "../../middleware/logger.js";
import {
  evaluateComposioRoute,
  runComposioTool,
} from "./composio-skill-bridge.js";

export const NOTION_APPEND_BLOCK_SKILL_NAME = "notion.append_block" as const;

export interface NotionAppendBlockSkillInput {
  pageId: string;
  text: string;
}

export interface NotionAppendBlockContext {
  db: Db;
  companyId: string;
  permissionLevel: AgentPermissionLevel;
  agentId?: string | null;
  runId?: string | null;
  /** Wave 21: FounderOS user id for Composio routing. Optional. */
  userId?: string | null;
}

export type NotionAppendBlockResult =
  | { ok: true; status: "appended"; blockId: string }
  | { ok: true; status: "pending_approval"; approvalId: string }
  | { ok: false; reason: "no_integration"; message: string }
  | { ok: false; reason: "notion_error"; message: string }
  | { ok: false; reason: "composio_error"; message: string };

function validateInput(input: NotionAppendBlockSkillInput): void {
  if (typeof input.pageId !== "string" || input.pageId.trim().length === 0) {
    throw new Error("notion.append_block: `pageId` is required");
  }
  if (typeof input.text !== "string" || input.text.trim().length === 0) {
    throw new Error("notion.append_block: `text` is required");
  }
}

async function createPendingApproval(params: {
  db: Db;
  companyId: string;
  agentId?: string | null;
  input: NotionAppendBlockSkillInput;
  integrationId: string;
}): Promise<string> {
  const { db, companyId, agentId, input, integrationId } = params;
  const [row] = await db
    .insert(approvals)
    .values({
      companyId,
      type: "notion.append_block",
      requestedByAgentId: agentId ?? null,
      status: "pending",
      payload: {
        skill: NOTION_APPEND_BLOCK_SKILL_NAME,
        integrationId,
        pageId: input.pageId,
        text: input.text,
      },
    })
    .returning({ id: approvals.id });
  return row.id;
}

export async function executeNotionAppendBlock(
  ctx: NotionAppendBlockContext,
  input: NotionAppendBlockSkillInput,
): Promise<NotionAppendBlockResult> {
  validateInput(input);

  const { db, companyId, permissionLevel, agentId, runId, userId } = ctx;

  if (permissionLevel === "observe") {
    throw new Error(
      `Observe mode: skill "${NOTION_APPEND_BLOCK_SKILL_NAME}" is not permitted`,
    );
  }

  // ── Wave 21: Composio routing (autonomous only) ────────────────────────
  if (permissionLevel === "autonomous" && userId) {
    const route = await evaluateComposioRoute({
      db,
      companyId,
      userId,
      appName: "notion",
    });
    if (route.shouldUse) {
      const composioOutcome = await runComposioTool({
        userId,
        connectedAccountId: route.composioConnectionId,
        toolName: "notion_append_block_children",
        input: { block_id: input.pageId, text: input.text },
      });
      if (composioOutcome.ok) {
        const blockId =
          typeof composioOutcome.output?.id === "string"
            ? (composioOutcome.output.id as string)
            : typeof composioOutcome.output?.blockId === "string"
              ? (composioOutcome.output.blockId as string)
              : "";
        await logActivity(db, {
          companyId,
          actorType: agentId ? "agent" : "system",
          actorId: agentId ?? "system",
          agentId: agentId ?? null,
          runId: runId ?? null,
          action: "notion.append_block_executed",
          entityType: "integration",
          entityId: route.composioConnectionId ?? "composio",
          details: {
            skill: NOTION_APPEND_BLOCK_SKILL_NAME,
            pageId: input.pageId,
            blockId,
            permissionLevel,
            via: "composio",
          },
        }).catch(() => {});
        return { ok: true, status: "appended", blockId };
      }
      await logActivity(db, {
        companyId,
        actorType: agentId ? "agent" : "system",
        actorId: agentId ?? "system",
        agentId: agentId ?? null,
        runId: runId ?? null,
        action: "notion.append_block_failed",
        entityType: "integration",
        entityId: route.composioConnectionId ?? "composio",
        details: {
          skill: NOTION_APPEND_BLOCK_SKILL_NAME,
          pageId: input.pageId,
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
        eq(integrations.kind, "notion"),
      ),
    );

  if (!integrationRow) {
    return {
      ok: false,
      reason: "no_integration",
      message: "Notion integration is not connected for this company",
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
      action: "notion.append_block_pending_approval",
      entityType: "integration",
      entityId: integrationRow.id,
      details: {
        skill: NOTION_APPEND_BLOCK_SKILL_NAME,
        approvalId,
        pageId: input.pageId,
        permissionLevel,
      },
    }).catch(() => {});

    return { ok: true, status: "pending_approval", approvalId };
  }

  if (permissionLevel !== "autonomous") {
    throw new Error(
      `Unknown permission level "${permissionLevel}" for skill "${NOTION_APPEND_BLOCK_SKILL_NAME}"`,
    );
  }

  if (!integrationRow.encryptedApiKey) {
    return {
      ok: false,
      reason: "no_integration",
      message: "Notion integration is missing its access token",
    };
  }

  let accessToken: string;
  try {
    accessToken = decryptWithMasterKey(integrationRow.encryptedApiKey);
  } catch (err) {
    logger.error(
      { err, companyId, integrationId: integrationRow.id },
      "notion-append-block: failed to decrypt access token",
    );
    return { ok: false, reason: "notion_error", message: "Failed to decrypt Notion access token" };
  }

  const client = createNotionClient({ accessToken });

  try {
    const result = await client.appendBlocks(input);
    const blockId = result.results[0]?.id ?? "";

    await logActivity(db, {
      companyId,
      actorType: agentId ? "agent" : "system",
      actorId: agentId ?? "system",
      agentId: agentId ?? null,
      runId: runId ?? null,
      action: "notion.append_block_executed",
      entityType: "integration",
      entityId: integrationRow.id,
      details: {
        skill: NOTION_APPEND_BLOCK_SKILL_NAME,
        pageId: input.pageId,
        blockId,
        permissionLevel,
        via: "native",
      },
    }).catch(() => {});

    return { ok: true, status: "appended", blockId };
  } catch (err: unknown) {
    const message =
      err instanceof NotionAuthError
        ? "Notion access token is invalid or expired"
        : err instanceof Error
          ? err.message
          : "Unknown Notion error";

    await logActivity(db, {
      companyId,
      actorType: agentId ? "agent" : "system",
      actorId: agentId ?? "system",
      agentId: agentId ?? null,
      runId: runId ?? null,
      action: "notion.append_block_failed",
      entityType: "integration",
      entityId: integrationRow.id,
      details: {
        skill: NOTION_APPEND_BLOCK_SKILL_NAME,
        pageId: input.pageId,
        error: message,
      },
    }).catch(() => {});

    logger.error(
      { err, companyId, integrationId: integrationRow.id },
      `notion-append-block: appendBlocks failed — ${message}`,
    );

    return { ok: false, reason: "notion_error", message };
  }
}
