/**
 * Skill: `slack.post_message`
 *
 * Posts a message to a Slack channel on behalf of an agent, gated by the
 * agent's permission level. Reuses the existing `createSlackClient` wrapper
 * around `chat.postMessage`.
 *
 * Permission semantics (mirrors `permission-tool-gate.ts`, but the skill is
 * authoritative for its own behavior because the gate's pattern matching
 * doesn't cover the dotted skill name directly):
 *   - `observe`    → skill throws; nothing is posted.
 *   - `draft`      → blocked (no side effects); returns a `pending_approval`
 *                    result and creates an approval row in the Decision Inbox.
 *   - `approve`    → creates a `pending_approval` row in the Decision Inbox
 *                    with the payload; no immediate post.
 *   - `autonomous` → posts immediately via Slack; logs `slack.message_posted`
 *                    to the activity log (audit_log).
 *
 * The skill is company-scoped: it looks up the company's connected Slack
 * integration by kind (`slack`) and decrypts the bot token. If no Slack
 * integration is connected, the skill returns `{ ok: false, reason:
 * "no_integration" }` — caller can treat this as a no-op.
 *
 * Spec note: Wave 17B spec uses `suggest` as a synonym for the codebase's
 * existing `draft` permission level. The mapping is: `suggest → draft`.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { integrations, approvals } from "@founderos/db";
import type { AgentPermissionLevel } from "@founderos/shared";
import { createSlackClient, SlackAuthError } from "../slack-client.js";
import { logActivity } from "../activity-log.js";
import { decryptWithMasterKey } from "../../secrets/local-encrypted-provider.js";
import { logger } from "../../middleware/logger.js";

/** Public skill name exposed to agents. */
export const SLACK_POST_MESSAGE_SKILL_NAME = "slack.post_message" as const;

export interface SlackPostMessageInput {
  channelId: string;
  text: string;
  blocks?: unknown;
}

export interface SlackPostMessageContext {
  db: Db;
  companyId: string;
  /** Permission level of the calling agent. */
  permissionLevel: AgentPermissionLevel;
  /** The agent making the call (optional but required for audit attribution). */
  agentId?: string | null;
  /** Optional run ID for tracing. */
  runId?: string | null;
}

export type SlackPostMessageResult =
  | { ok: true; status: "posted"; channelId: string; ts: string }
  | { ok: true; status: "pending_approval"; channelId: string; approvalId: string }
  | { ok: false; reason: "no_integration"; message: string }
  | { ok: false; reason: "channel_not_found"; message: string }
  | { ok: false; reason: "slack_error"; message: string };

function normalizeBlocks(blocks: unknown): unknown[] | undefined {
  if (blocks === undefined || blocks === null) return undefined;
  if (!Array.isArray(blocks)) {
    throw new Error("slack.post_message: `blocks` must be an array when provided");
  }
  return blocks as unknown[];
}

function validateInput(input: SlackPostMessageInput): void {
  if (typeof input.channelId !== "string" || input.channelId.trim().length === 0) {
    throw new Error("slack.post_message: `channelId` is required");
  }
  if (typeof input.text !== "string" || input.text.length === 0) {
    throw new Error("slack.post_message: `text` is required");
  }
}

async function createPendingApproval(params: {
  db: Db;
  companyId: string;
  agentId?: string | null;
  input: SlackPostMessageInput;
  integrationId: string;
}): Promise<string> {
  const { db, companyId, agentId, input, integrationId } = params;
  const [row] = await db
    .insert(approvals)
    .values({
      companyId,
      type: "slack.post_message",
      requestedByAgentId: agentId ?? null,
      status: "pending",
      payload: {
        skill: SLACK_POST_MESSAGE_SKILL_NAME,
        integrationId,
        channelId: input.channelId,
        text: input.text,
        blocks: input.blocks ?? null,
      },
    })
    .returning({ id: approvals.id });
  return row.id;
}

/**
 * Execute the `slack.post_message` skill.
 *
 * Does NOT throw on expected business outcomes (no integration, channel not
 * found, Slack errors). DOES throw on permission denial (`observe`) and on
 * invalid input so agent code surfaces it to the LLM.
 */
export async function executeSlackPostMessage(
  ctx: SlackPostMessageContext,
  input: SlackPostMessageInput,
): Promise<SlackPostMessageResult> {
  validateInput(input);
  const blocks = normalizeBlocks(input.blocks);

  const { db, companyId, permissionLevel, agentId, runId } = ctx;

  // ── Permission: observe ────────────────────────────────────────────────
  if (permissionLevel === "observe") {
    throw new Error(
      `Observe mode: skill "${SLACK_POST_MESSAGE_SKILL_NAME}" is not permitted`,
    );
  }

  // ── Look up company's Slack integration ────────────────────────────────
  const [integrationRow] = await db
    .select()
    .from(integrations)
    .where(
      and(
        eq(integrations.companyId, companyId),
        eq(integrations.kind, "slack"),
      ),
    );

  if (!integrationRow) {
    return {
      ok: false,
      reason: "no_integration",
      message: "Slack integration is not connected for this company",
    };
  }

  // ── Permission: draft / approve → create pending approval ──────────────
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
      action: "slack.message_pending_approval",
      entityType: "integration",
      entityId: integrationRow.id,
      details: {
        skill: SLACK_POST_MESSAGE_SKILL_NAME,
        approvalId,
        channelId: input.channelId,
        permissionLevel,
      },
    }).catch((err) => {
      logger.error(
        { err, companyId, approvalId },
        "slack-post-message: failed to log pending approval activity",
      );
    });

    return {
      ok: true,
      status: "pending_approval",
      channelId: input.channelId,
      approvalId,
    };
  }

  // ── Permission: autonomous → post immediately ──────────────────────────
  if (permissionLevel !== "autonomous") {
    // Unknown permission level — fail closed.
    throw new Error(
      `Unknown permission level "${permissionLevel}" for skill "${SLACK_POST_MESSAGE_SKILL_NAME}"`,
    );
  }

  if (!integrationRow.encryptedApiKey) {
    return {
      ok: false,
      reason: "no_integration",
      message: "Slack integration is missing its bot token",
    };
  }

  let botToken: string;
  try {
    botToken = decryptWithMasterKey(integrationRow.encryptedApiKey);
  } catch (err) {
    logger.error(
      { err, companyId, integrationId: integrationRow.id },
      "slack-post-message: failed to decrypt bot token",
    );
    return {
      ok: false,
      reason: "slack_error",
      message: "Failed to decrypt Slack bot token",
    };
  }

  const client = createSlackClient({ botToken });

  try {
    const result = await client.postMessage(input.channelId, input.text, blocks);

    if (!result.ok) {
      const reason: "channel_not_found" | "slack_error" =
        result.error === "channel_not_found" ? "channel_not_found" : "slack_error";

      await logActivity(db, {
        companyId,
        actorType: agentId ? "agent" : "system",
        actorId: agentId ?? "system",
        agentId: agentId ?? null,
        runId: runId ?? null,
        action: "slack.message_post_failed",
        entityType: "integration",
        entityId: integrationRow.id,
        details: {
          skill: SLACK_POST_MESSAGE_SKILL_NAME,
          channelId: input.channelId,
          error: result.error,
        },
      }).catch(() => {});

      return { ok: false, reason, message: result.error };
    }

    await logActivity(db, {
      companyId,
      actorType: agentId ? "agent" : "system",
      actorId: agentId ?? "system",
      agentId: agentId ?? null,
      runId: runId ?? null,
      action: "slack.message_posted",
      entityType: "integration",
      entityId: integrationRow.id,
      details: {
        skill: SLACK_POST_MESSAGE_SKILL_NAME,
        channelId: input.channelId,
        ts: result.ts,
        permissionLevel,
      },
    }).catch((err) => {
      logger.error(
        { err, companyId, integrationId: integrationRow.id },
        "slack-post-message: failed to log audit entry",
      );
    });

    return {
      ok: true,
      status: "posted",
      channelId: input.channelId,
      ts: result.ts,
    };
  } catch (err: unknown) {
    if (err instanceof SlackAuthError) {
      return {
        ok: false,
        reason: "slack_error",
        message: "Slack bot token is invalid or expired",
      };
    }
    const msg = err instanceof Error ? err.message : "Unknown Slack error";
    logger.error(
      { err, companyId, integrationId: integrationRow.id },
      `slack-post-message: postMessage failed — ${msg}`,
    );
    return { ok: false, reason: "slack_error", message: msg };
  }
}
