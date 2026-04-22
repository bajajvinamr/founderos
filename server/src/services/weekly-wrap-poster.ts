/**
 * Weekly Wrap → Slack poster.
 *
 * When a Weekly Wrap is finalized, check whether:
 *   1. The company has a Slack integration connected.
 *   2. The calling CoS agent has ≥ `suggest` (mapped to `draft` in this
 *      codebase) permission for Slack actions.
 *   3. A `weeklyWrapSlackChannelId` is configured on the company
 *      (stored under `companies.metrics.weeklyWrapSlackChannelId`).
 *
 * If all three hold, route through the `slack.post_message` skill. The skill
 * itself handles the permission semantics:
 *   - `draft` / `approve` → creates a pending action in the Decision Inbox.
 *   - `autonomous`        → posts immediately.
 *
 * This module is deliberately thin — it is a specialization of the generic
 * skill for the Weekly Wrap trigger. The same skill can be invoked by the
 * CoS agent directly.
 *
 * Spec note: "suggest" in the Wave 17B spec maps to `draft` in this codebase.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { companies, integrations } from "@founderos/db";
import type { AgentPermissionLevel } from "@founderos/shared";
import {
  executeSlackPostMessage,
  type SlackPostMessageResult,
} from "./skills/slack-post-message.js";
import { logger } from "../middleware/logger.js";

export interface WeeklyWrapPosterParams {
  db: Db;
  companyId: string;
  /** The CoS agent (or other authorized agent) posting on behalf of the company. */
  agentId?: string | null;
  /** Agent's permission level for Slack actions. */
  permissionLevel: AgentPermissionLevel;
  /** Markdown-ish text body of the wrap. */
  text: string;
  /** Optional Slack blocks for a richer render. */
  blocks?: unknown;
  /** Optional run ID for trace correlation. */
  runId?: string | null;
}

export type WeeklyWrapPosterResult =
  | { ok: true; skipped: false; outcome: SlackPostMessageResult }
  | { ok: true; skipped: true; reason: "no_integration" | "no_channel_configured" | "permission_too_low" };

/** Minimum permission level required to post the Weekly Wrap (≥ `draft`). */
const MIN_PERMISSION_ORDER: Record<AgentPermissionLevel, number> = {
  observe: 0,
  draft: 1,
  approve: 2,
  autonomous: 3,
};

function hasMinimumPermission(level: AgentPermissionLevel): boolean {
  return MIN_PERMISSION_ORDER[level] >= MIN_PERMISSION_ORDER.draft;
}

async function getWeeklyWrapChannelId(db: Db, companyId: string): Promise<string | null> {
  const [row] = await db
    .select({ metrics: companies.metrics })
    .from(companies)
    .where(eq(companies.id, companyId));

  if (!row) return null;

  const metrics = (row.metrics ?? {}) as Record<string, unknown>;
  const raw = metrics.weeklyWrapSlackChannelId;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function hasSlackIntegration(db: Db, companyId: string): Promise<boolean> {
  const [slackRow] = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(and(eq(integrations.companyId, companyId), eq(integrations.kind, "slack")))
    .limit(1);
  return !!slackRow;
}

/**
 * Entry point for posting a finalized Weekly Wrap to Slack.
 *
 * Gates:
 *   - Skip if no Slack integration connected.
 *   - Skip if no `weeklyWrapSlackChannelId` configured on the company.
 *   - Skip if agent permission < `draft` ("suggest" in the spec).
 *
 * Otherwise invokes `slack.post_message`. The skill's own gate maps
 *   `draft` / `approve` → Decision Inbox pending action
 *   `autonomous` → immediate post (logged to audit_log).
 */
export async function postWeeklyWrapToSlack(
  params: WeeklyWrapPosterParams,
): Promise<WeeklyWrapPosterResult> {
  const { db, companyId, agentId, permissionLevel, text, blocks, runId } = params;

  if (!hasMinimumPermission(permissionLevel)) {
    logger.info(
      { companyId, agentId, permissionLevel },
      "weekly-wrap-poster: skipped — agent permission too low",
    );
    return { ok: true, skipped: true, reason: "permission_too_low" };
  }

  const integrationConnected = await hasSlackIntegration(db, companyId);
  if (!integrationConnected) {
    logger.info(
      { companyId },
      "weekly-wrap-poster: skipped — no Slack integration connected",
    );
    return { ok: true, skipped: true, reason: "no_integration" };
  }

  const channelId = await getWeeklyWrapChannelId(db, companyId);
  if (!channelId) {
    logger.info(
      { companyId },
      "weekly-wrap-poster: skipped — no weeklyWrapSlackChannelId configured",
    );
    return { ok: true, skipped: true, reason: "no_channel_configured" };
  }

  const outcome = await executeSlackPostMessage(
    {
      db,
      companyId,
      permissionLevel,
      agentId: agentId ?? null,
      runId: runId ?? null,
    },
    {
      channelId,
      text,
      blocks,
    },
  );

  return { ok: true, skipped: false, outcome };
}
