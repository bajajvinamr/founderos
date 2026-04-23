/**
 * Agent-to-agent handoff service.
 *
 * A handoff lets the CoS (or any agent) dispatch a scoped sub-task to
 * another department agent (Growth / Content / Finance). Handoffs are
 * a first-class primitive so we can show the chain in the UI and
 * reason about who did what.
 *
 * Lifecycle:
 *   pending → accepted → in_progress → completed
 *                                    ↘ failed
 *                      ↘ rejected
 *
 * On create, we also create an `issue` assigned to the receiving agent
 * so the handoff shows up in that agent's queue like any other work.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { agents, agentHandoffs, companies, issues } from "@founderos/db";
import { randomUUID } from "node:crypto";
import { logActivity } from "./activity-log.js";

export type HandoffStatus =
  | "pending"
  | "accepted"
  | "in_progress"
  | "completed"
  | "rejected"
  | "failed";

export interface CreateHandoffInput {
  companyId: string;
  fromAgentId: string;
  toAgentId: string;
  fromIssueId?: string | null;
  request: string;
  context?: Record<string, unknown>;
}

export interface CompleteHandoffInput {
  result: string;
  resultRef?: string | null;
}

export function agentHandoffService(db: Db) {
  async function create(input: CreateHandoffInput) {
    if (input.fromAgentId === input.toAgentId) {
      throw new Error("Handoff source and target must be different agents");
    }
    // Validate both agents belong to the company (defense-in-depth against
    // the route-level check).
    const roster = await db
      .select({ id: agents.id, companyId: agents.companyId, role: agents.role, name: agents.name })
      .from(agents)
      .where(inArray(agents.id, [input.fromAgentId, input.toAgentId]));
    const from = roster.find((r) => r.id === input.fromAgentId);
    const to = roster.find((r) => r.id === input.toAgentId);
    if (!from || !to) throw new Error("Handoff references unknown agent");
    if (from.companyId !== input.companyId || to.companyId !== input.companyId) {
      throw new Error("Handoff agents must belong to this company");
    }

    const [company] = await db
      .select({ id: companies.id, issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, input.companyId));
    if (!company) throw new Error("Company not found");

    const prefix = company.issuePrefix ?? "FOU";
    const issueIdentifier = `${prefix}-HO-${Date.now().toString(36).toUpperCase()}`;

    const [createdIssue] = await db
      .insert(issues)
      .values({
        companyId: input.companyId,
        identifier: issueIdentifier,
        title: `Handoff from ${from.name ?? from.role} → ${to.name ?? to.role}`,
        description: input.request,
        status: "todo",
        priority: "medium",
        assigneeAgentId: input.toAgentId,
      } as typeof issues.$inferInsert)
      .returning({ id: issues.id });

    const [row] = await db
      .insert(agentHandoffs)
      .values({
        companyId: input.companyId,
        fromAgentId: input.fromAgentId,
        toAgentId: input.toAgentId,
        fromIssueId: input.fromIssueId ?? null,
        toIssueId: createdIssue?.id ?? null,
        request: input.request,
        context: input.context ?? {},
        status: "pending",
      })
      .returning();

    await logActivity(db, {
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.fromAgentId,
      agentId: input.fromAgentId,
      action: "agent.handoff_created",
      entityType: "handoff",
      entityId: row.id,
      details: {
        handoffId: row.id,
        fromAgentId: input.fromAgentId,
        fromAgentRole: from.role,
        toAgentId: input.toAgentId,
        toAgentRole: to.role,
        requestPreview: input.request.slice(0, 280),
        toIssueId: createdIssue?.id ?? null,
      },
    }).catch(() => {});

    return row;
  }

  async function accept(id: string) {
    const [row] = await db
      .update(agentHandoffs)
      .set({ status: "accepted", acceptedAt: new Date() })
      .where(and(eq(agentHandoffs.id, id), eq(agentHandoffs.status, "pending")))
      .returning();
    if (!row) return null;
    await logActivity(db, {
      companyId: row.companyId,
      actorType: "agent",
      actorId: row.toAgentId,
      agentId: row.toAgentId,
      action: "agent.handoff_accepted",
      entityType: "handoff",
      entityId: row.id,
      details: { handoffId: row.id },
    }).catch(() => {});
    return row;
  }

  async function markInProgress(id: string) {
    const [row] = await db
      .update(agentHandoffs)
      .set({ status: "in_progress" })
      .where(
        and(
          eq(agentHandoffs.id, id),
          inArray(agentHandoffs.status, ["pending", "accepted"]),
        ),
      )
      .returning();
    return row ?? null;
  }

  async function complete(id: string, input: CompleteHandoffInput) {
    const [row] = await db
      .update(agentHandoffs)
      .set({
        status: "completed",
        completedAt: new Date(),
        result: input.result,
        resultRef: input.resultRef ?? null,
      })
      .where(
        and(
          eq(agentHandoffs.id, id),
          inArray(agentHandoffs.status, ["pending", "accepted", "in_progress"]),
        ),
      )
      .returning();
    if (!row) return null;
    await logActivity(db, {
      companyId: row.companyId,
      actorType: "agent",
      actorId: row.toAgentId,
      agentId: row.toAgentId,
      action: "agent.handoff_completed",
      entityType: "handoff",
      entityId: row.id,
      details: {
        handoffId: row.id,
        resultPreview: input.result.slice(0, 280),
        resultRef: input.resultRef ?? null,
      },
    }).catch(() => {});
    return row;
  }

  async function reject(id: string, reason: string) {
    const [row] = await db
      .update(agentHandoffs)
      .set({
        status: "rejected",
        completedAt: new Date(),
        result: reason,
      })
      .where(
        and(
          eq(agentHandoffs.id, id),
          inArray(agentHandoffs.status, ["pending", "accepted"]),
        ),
      )
      .returning();
    if (!row) return null;
    await logActivity(db, {
      companyId: row.companyId,
      actorType: "agent",
      actorId: row.toAgentId,
      agentId: row.toAgentId,
      action: "agent.handoff_rejected",
      entityType: "handoff",
      entityId: row.id,
      details: { handoffId: row.id, reason: reason.slice(0, 280) },
    }).catch(() => {});
    return row;
  }

  async function getById(id: string) {
    const [row] = await db.select().from(agentHandoffs).where(eq(agentHandoffs.id, id));
    return row ?? null;
  }

  async function listForCompany(companyId: string, opts?: { status?: HandoffStatus; limit?: number }) {
    const conditions = [eq(agentHandoffs.companyId, companyId)];
    if (opts?.status) conditions.push(eq(agentHandoffs.status, opts.status));
    return db
      .select()
      .from(agentHandoffs)
      .where(and(...conditions))
      .orderBy(desc(agentHandoffs.createdAt))
      .limit(opts?.limit ?? 100);
  }

  async function listForIssue(issueId: string) {
    // Upstream (handoff whose child issue is this one) and downstream (handoffs
    // originating from this issue).
    const rows = await db
      .select()
      .from(agentHandoffs)
      .where(
        and(
          // eq against each candidate — Drizzle's or() isn't re-exported here
          // so we union in JS via two queries. Cheap at expected volumes.
          eq(agentHandoffs.toIssueId, issueId),
        ),
      );
    const downstream = await db
      .select()
      .from(agentHandoffs)
      .where(eq(agentHandoffs.fromIssueId, issueId));
    const seen = new Set<string>();
    const all = [...rows, ...downstream].filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
    return all.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async function findAgentByRoleSlug(companyId: string, roleSlug: string) {
    const [row] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.role, roleSlug)));
    return row?.id ?? null;
  }

  return {
    create,
    accept,
    markInProgress,
    complete,
    reject,
    getById,
    listForCompany,
    listForIssue,
    findAgentByRoleSlug,
  };
}

export type AgentHandoffService = ReturnType<typeof agentHandoffService>;

// Keep a usable placeholder for callers that want a stable handle even
// when the service is bound lazily.
export const _handoffUuid = randomUUID;
