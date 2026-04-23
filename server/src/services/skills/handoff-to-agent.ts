/**
 * Skill: `agent.handoff`
 *
 * Lets an agent dispatch a sub-task to a sibling agent (resolved by role
 * slug inside the same company). Mirrors the permission ladder used by
 * the integration skills:
 *
 *   observe  → throws
 *   draft    → creates a pending approvals row, no downstream work
 *   approve  → same as draft
 *   autonomous → creates the handoff + spawns the receiver's issue
 */

import type { Db } from "@founderos/db";
import { approvals } from "@founderos/db";
import type { AgentPermissionLevel } from "@founderos/shared";
import { agentHandoffService } from "../agent-handoff.js";
import { logActivity } from "../activity-log.js";
import { logger } from "../../middleware/logger.js";

export const HANDOFF_SKILL_NAME = "agent.handoff" as const;

export interface HandoffSkillInput {
  toAgentRoleSlug: string;
  request: string;
  context?: Record<string, unknown>;
  fromIssueId?: string | null;
}

export interface HandoffSkillContext {
  db: Db;
  companyId: string;
  permissionLevel: AgentPermissionLevel;
  /** Sender — required. The agent invoking this skill. */
  agentId: string;
  runId?: string | null;
}

export type HandoffSkillResult =
  | { ok: true; status: "created"; handoffId: string; toAgentId: string; toIssueId: string | null }
  | { ok: true; status: "pending_approval"; approvalId: string }
  | { ok: false; reason: "unknown_role" | "invalid_input"; message: string };

function validateInput(input: HandoffSkillInput): void {
  if (typeof input.toAgentRoleSlug !== "string" || input.toAgentRoleSlug.trim().length === 0) {
    throw new Error("agent.handoff: `toAgentRoleSlug` is required");
  }
  if (typeof input.request !== "string" || input.request.trim().length < 4) {
    throw new Error("agent.handoff: `request` must be at least 4 chars");
  }
}

export async function executeAgentHandoff(
  ctx: HandoffSkillContext,
  input: HandoffSkillInput,
): Promise<HandoffSkillResult> {
  validateInput(input);

  const { db, companyId, permissionLevel, agentId, runId } = ctx;

  if (permissionLevel === "observe") {
    throw new Error(`Observe mode: skill "${HANDOFF_SKILL_NAME}" is not permitted`);
  }

  const handoffs = agentHandoffService(db);
  const toAgentId = await handoffs.findAgentByRoleSlug(companyId, input.toAgentRoleSlug);
  if (!toAgentId) {
    return {
      ok: false,
      reason: "unknown_role",
      message: `No agent with role "${input.toAgentRoleSlug}" exists in this company`,
    };
  }

  if (permissionLevel === "draft" || permissionLevel === "approve") {
    const [row] = await db
      .insert(approvals)
      .values({
        companyId,
        type: "agent.handoff",
        requestedByAgentId: agentId,
        status: "pending",
        payload: {
          skill: HANDOFF_SKILL_NAME,
          toAgentRoleSlug: input.toAgentRoleSlug,
          toAgentId,
          request: input.request,
          context: input.context ?? {},
          fromIssueId: input.fromIssueId ?? null,
        },
      })
      .returning({ id: approvals.id });

    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId: runId ?? null,
      action: "agent.handoff_pending_approval",
      entityType: "handoff",
      entityId: row.id,
      details: {
        skill: HANDOFF_SKILL_NAME,
        approvalId: row.id,
        toAgentRoleSlug: input.toAgentRoleSlug,
        requestPreview: input.request.slice(0, 280),
      },
    }).catch(() => {});

    return { ok: true, status: "pending_approval", approvalId: row.id };
  }

  if (permissionLevel !== "autonomous") {
    throw new Error(
      `Unknown permission level "${permissionLevel}" for skill "${HANDOFF_SKILL_NAME}"`,
    );
  }

  try {
    const row = await handoffs.create({
      companyId,
      fromAgentId: agentId,
      toAgentId,
      fromIssueId: input.fromIssueId ?? null,
      request: input.request,
      context: input.context,
    });
    return {
      ok: true,
      status: "created",
      handoffId: row.id,
      toAgentId: row.toAgentId,
      toIssueId: row.toIssueId,
    };
  } catch (err) {
    logger.error({ err, companyId, agentId }, "agent.handoff: create failed");
    throw err;
  }
}
