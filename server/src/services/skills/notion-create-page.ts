/**
 * Skill: `notion.create_page`
 *
 * Creates a Notion page on behalf of an agent, gated by the agent's
 * permission level. Mirrors the `hubspot.create_contact` and
 * `slack.post_message` patterns.
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

export const NOTION_CREATE_PAGE_SKILL_NAME = "notion.create_page" as const;

export interface NotionCreatePageSkillInput {
  parentPageId?: string;
  parentDatabaseId?: string;
  title: string;
  bodyMarkdown?: string;
}

export interface NotionCreatePageContext {
  db: Db;
  companyId: string;
  permissionLevel: AgentPermissionLevel;
  agentId?: string | null;
  runId?: string | null;
  /** Wave 21: FounderOS user id for Composio routing. Optional. */
  userId?: string | null;
}

export type NotionCreatePageResult =
  | { ok: true; status: "created"; pageId: string; url: string }
  | { ok: true; status: "pending_approval"; approvalId: string }
  | { ok: false; reason: "no_integration"; message: string }
  | { ok: false; reason: "notion_error"; message: string }
  | { ok: false; reason: "composio_error"; message: string };

function validateInput(input: NotionCreatePageSkillInput): void {
  if (!input.parentPageId && !input.parentDatabaseId) {
    throw new Error("notion.create_page: `parentPageId` or `parentDatabaseId` is required");
  }
  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    throw new Error("notion.create_page: `title` is required");
  }
  if (input.bodyMarkdown !== undefined && typeof input.bodyMarkdown !== "string") {
    throw new Error("notion.create_page: `bodyMarkdown` must be a string when provided");
  }
}

async function createPendingApproval(params: {
  db: Db;
  companyId: string;
  agentId?: string | null;
  input: NotionCreatePageSkillInput;
  integrationId: string;
}): Promise<string> {
  const { db, companyId, agentId, input, integrationId } = params;
  const [row] = await db
    .insert(approvals)
    .values({
      companyId,
      type: "notion.create_page",
      requestedByAgentId: agentId ?? null,
      status: "pending",
      payload: {
        skill: NOTION_CREATE_PAGE_SKILL_NAME,
        integrationId,
        parentPageId: input.parentPageId ?? null,
        parentDatabaseId: input.parentDatabaseId ?? null,
        title: input.title,
        bodyMarkdown: input.bodyMarkdown ?? null,
      },
    })
    .returning({ id: approvals.id });
  return row.id;
}

export async function executeNotionCreatePage(
  ctx: NotionCreatePageContext,
  input: NotionCreatePageSkillInput,
): Promise<NotionCreatePageResult> {
  validateInput(input);

  const { db, companyId, permissionLevel, agentId, runId, userId } = ctx;

  if (permissionLevel === "observe") {
    throw new Error(
      `Observe mode: skill "${NOTION_CREATE_PAGE_SKILL_NAME}" is not permitted`,
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
        toolName: "notion_create_page",
        input: {
          parent_page_id: input.parentPageId,
          parent_database_id: input.parentDatabaseId,
          title: input.title,
          markdown_content: input.bodyMarkdown,
        },
      });
      if (composioOutcome.ok) {
        const pageId =
          typeof composioOutcome.output?.id === "string"
            ? (composioOutcome.output.id as string)
            : typeof composioOutcome.output?.pageId === "string"
              ? (composioOutcome.output.pageId as string)
              : "";
        const url =
          typeof composioOutcome.output?.url === "string"
            ? (composioOutcome.output.url as string)
            : "";
        await logActivity(db, {
          companyId,
          actorType: agentId ? "agent" : "system",
          actorId: agentId ?? "system",
          agentId: agentId ?? null,
          runId: runId ?? null,
          action: "notion.create_page_executed",
          entityType: "integration",
          entityId: route.composioConnectionId ?? "composio",
          details: {
            skill: NOTION_CREATE_PAGE_SKILL_NAME,
            pageId,
            title: input.title,
            permissionLevel,
            via: "composio",
          },
        }).catch(() => {});
        return { ok: true, status: "created", pageId, url };
      }
      await logActivity(db, {
        companyId,
        actorType: agentId ? "agent" : "system",
        actorId: agentId ?? "system",
        agentId: agentId ?? null,
        runId: runId ?? null,
        action: "notion.create_page_failed",
        entityType: "integration",
        entityId: route.composioConnectionId ?? "composio",
        details: {
          skill: NOTION_CREATE_PAGE_SKILL_NAME,
          title: input.title,
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
      action: "notion.create_page_pending_approval",
      entityType: "integration",
      entityId: integrationRow.id,
      details: {
        skill: NOTION_CREATE_PAGE_SKILL_NAME,
        approvalId,
        title: input.title,
        permissionLevel,
      },
    }).catch((err) => {
      logger.error(
        { err, companyId, approvalId },
        "notion-create-page: failed to log pending approval activity",
      );
    });

    return { ok: true, status: "pending_approval", approvalId };
  }

  if (permissionLevel !== "autonomous") {
    throw new Error(
      `Unknown permission level "${permissionLevel}" for skill "${NOTION_CREATE_PAGE_SKILL_NAME}"`,
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
      "notion-create-page: failed to decrypt access token",
    );
    return { ok: false, reason: "notion_error", message: "Failed to decrypt Notion access token" };
  }

  const client = createNotionClient({ accessToken });

  try {
    const page = await client.createPage(input);

    await logActivity(db, {
      companyId,
      actorType: agentId ? "agent" : "system",
      actorId: agentId ?? "system",
      agentId: agentId ?? null,
      runId: runId ?? null,
      action: "notion.create_page_executed",
      entityType: "integration",
      entityId: integrationRow.id,
      details: {
        skill: NOTION_CREATE_PAGE_SKILL_NAME,
        pageId: page.id,
        title: input.title,
        permissionLevel,
        via: "native",
      },
    }).catch((err) => {
      logger.error(
        { err, companyId, integrationId: integrationRow.id },
        "notion-create-page: failed to log audit entry",
      );
    });

    return { ok: true, status: "created", pageId: page.id, url: page.url };
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
      action: "notion.create_page_failed",
      entityType: "integration",
      entityId: integrationRow.id,
      details: {
        skill: NOTION_CREATE_PAGE_SKILL_NAME,
        title: input.title,
        error: message,
      },
    }).catch(() => {});

    logger.error(
      { err, companyId, integrationId: integrationRow.id },
      `notion-create-page: createPage failed — ${message}`,
    );

    return { ok: false, reason: "notion_error", message };
  }
}
