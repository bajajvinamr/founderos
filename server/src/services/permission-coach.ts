import type { Db } from "@founderos/db";
import { and, eq, gte } from "drizzle-orm";
import { approvals, agents } from "@founderos/db";

export interface PermissionCoachRecommendation {
  agentId: string;
  agentName: string;
  currentLevel: string;
  approvedCount: number;
  rejectedCount: number;
  rate: number;
  recommendation: "upgrade" | "downgrade" | "hold";
  targetLevel?: string;
}

/**
 * Compute permission level upgrade/downgrade recommendations for a company
 * based on approval history from the last 30 days.
 *
 * Rules:
 * - approve -> autonomous if rate >= 0.92 AND approvedCount >= 10
 * - autonomous -> approve if rejectedCount >= 3 in last 30 days
 * - suggest -> approve if rate >= 0.85 AND count >= 5
 * - else -> hold
 */
export async function computeCoachingRecommendations(
  db: Db,
  companyId: string,
): Promise<PermissionCoachRecommendation[]> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Get all agents for this company
  const companyAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.companyId, companyId));

  const recommendations: PermissionCoachRecommendation[] = [];

  for (const agent of companyAgents) {
    // Count approvals and rejections from this agent in the last 30 days
    const recentApprovals = await db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, companyId),
          eq(approvals.requestedByAgentId, agent.id),
          gte(approvals.createdAt, thirtyDaysAgo),
        ),
      );

    const approvedCount = recentApprovals.filter(
      (a) => a.status === "approved",
    ).length;
    const rejectedCount = recentApprovals.filter(
      (a) => a.status === "rejected",
    ).length;
    const totalCount = approvedCount + rejectedCount;

    if (totalCount === 0) {
      // No recent approvals, skip this agent
      continue;
    }

    const rate = approvedCount / totalCount;
    const currentLevel = agent.permissionLevel || "approve";

    let recommendation: "upgrade" | "downgrade" | "hold" = "hold";
    let targetLevel: string | undefined;

    if (currentLevel === "approve") {
      // Consider upgrade to autonomous
      if (rate >= 0.92 && approvedCount >= 10) {
        recommendation = "upgrade";
        targetLevel = "autonomous";
      }
    } else if (currentLevel === "autonomous") {
      // Consider downgrade to approve if trust regressed
      if (rejectedCount >= 3) {
        recommendation = "downgrade";
        targetLevel = "approve";
      }
    } else if (currentLevel === "suggest") {
      // Consider upgrade to approve
      if (rate >= 0.85 && totalCount >= 5) {
        recommendation = "upgrade";
        targetLevel = "approve";
      }
    }

    if (recommendation !== "hold") {
      recommendations.push({
        agentId: agent.id,
        agentName: agent.name,
        currentLevel,
        approvedCount,
        rejectedCount,
        rate,
        recommendation,
        targetLevel,
      });
    }
  }

  return recommendations;
}

/**
 * Apply a permission level upgrade/downgrade for an agent.
 * Returns true on success, throws on error.
 */
export async function applyPermissionUpgrade(
  db: Db,
  agentId: string,
  companyId: string,
  targetLevel: string,
): Promise<boolean> {
  const agent = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .then((rows) => rows[0] ?? null);

  if (!agent) {
    throw new Error("Agent not found");
  }

  // Update the agent's permission level
  await db
    .update(agents)
    .set({
      permissionLevel: targetLevel,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, agentId));

  return true;
}
