/**
 * Department Status rollup (S3.4).
 *
 *   GET /api/companies/:id/department-status
 *
 * Returns a per-department health rollup for the five INSIGHT_DEPARTMENTS
 * (chief-of-staff, growth, content, crm, finance). Replaces the placeholder
 * client-side rollup that lived in `ui/src/components/DepartmentStatusGrid.tsx`
 * (S1.1) — moves the source-of-truth to the server so it stays consistent
 * across surfaces (Dashboard + CoS console + future weekly digest).
 *
 * Health rules per department:
 *   red    — any agent in `error` runtime state (read agentRuntimeState.lastRunStatus)
 *            OR pendingApprovals > 5
 *            OR any open insight with kind='kpi_anomaly' AND
 *               evidence->>'severity' = 'critical'
 *   yellow — stalledWorkflows > 2 (routines.status='paused' is the closest
 *            existing semantic — there is no `workflows` table yet, but
 *            `routines` is the production scheduling primitive; a paused
 *            routine is exactly a "stalled workflow" from the founder's POV.)
 *            OR last activity > 24h ago
 *   green  — else
 *   grey   — department has no agents (not configured)
 *
 * Implementation notes:
 * - One query per dimension (agents, runtime states, approvals, insights,
 *   routines), all scoped on companyId. Total: 5 round-trips. The dataset is
 *   tiny (single founder's company, < 50 agents, < 200 approvals) so this is
 *   strictly cheaper than a hand-written join and easier to reason about.
 * - We use `.where(and(...))` everywhere — chained `.where()` REPLACES in
 *   Drizzle (see vinamr-invariants.md). The JSONB filter on insight evidence
 *   uses `sql\`evidence->>'severity' = 'critical'\`` because Drizzle's `.eq()`
 *   doesn't compose with arrow path operators.
 * - lastActivity is the max of:
 *     a. agents.lastHeartbeatAt (the wakeup ping)
 *     b. agentRuntimeState.updatedAt (any tick that updated runtime — covers
 *        agents that ran but didn't beat heartbeat in the same window)
 *   This matches the Dashboard "agent last seen" field semantics.
 */

import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@founderos/db";
import {
  agents,
  agentRuntimeState,
  approvals,
  insights,
  routines,
} from "@founderos/db";
import type { AgentRole } from "@founderos/shared";
import { assertCompanyAccess } from "./authz.js";

// ── Role → Department map ────────────────────────────────────────────────
//
// Mirror of `ui/src/lib/departments.ts` department-for-role mapping, but
// projected onto the 5 INSIGHT_DEPARTMENTS that this endpoint reports.
// Roles outside this map (cto, engineer, devops, qa, general) don't surface
// in any of the five departments — by design; engineering + ops are tracked
// elsewhere.

const ROLE_TO_DEPARTMENT: Partial<Record<AgentRole, DepartmentId>> = {
  ceo: "chief-of-staff",
  cmo: "growth",
  pm: "growth",
  designer: "content",
  researcher: "content",
  cfo: "finance",
};

export const DEPARTMENT_IDS = [
  "chief-of-staff",
  "growth",
  "content",
  "crm",
  "finance",
] as const;
export type DepartmentId = (typeof DEPARTMENT_IDS)[number];

export type DepartmentHealth = "green" | "yellow" | "red" | "grey";

export interface DepartmentRollup {
  health: DepartmentHealth;
  openInsights: number;
  pendingApprovals: number;
  stalledWorkflows: number;
  lastActivity: string | null;
  agentCount: number;
}

export type DepartmentStatusResponse = Record<DepartmentId, DepartmentRollup>;

// ── Thresholds (mirrored in the spec) ────────────────────────────────────

const PENDING_APPROVAL_RED_THRESHOLD = 5;
const STALLED_WORKFLOW_YELLOW_THRESHOLD = 2;
const STALE_ACTIVITY_MS = 24 * 60 * 60 * 1000;

export function departmentStatusRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:id/department-status", async (req, res) => {
    const companyId = req.params.id as string;
    assertCompanyAccess(req, companyId);

    // (1) Agents — drives department membership + agentCount.
    const agentRows = await db
      .select({
        id: agents.id,
        role: agents.role,
        status: agents.status,
        lastHeartbeatAt: agents.lastHeartbeatAt,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    // (2) Runtime states — `lastRunStatus='error'` is the red trigger.
    const runtimeRows = await db
      .select({
        agentId: agentRuntimeState.agentId,
        lastRunStatus: agentRuntimeState.lastRunStatus,
        updatedAt: agentRuntimeState.updatedAt,
      })
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.companyId, companyId));

    // (3) Pending approvals — only `status='pending'` count toward the gate.
    const approvalRows = await db
      .select({
        id: approvals.id,
        requestedByAgentId: approvals.requestedByAgentId,
      })
      .from(approvals)
      .where(
        and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")),
      );

    // (4) Open insights, kind=kpi_anomaly, severity=critical (in evidence
    //     JSONB). The arrow operator can't be expressed via Drizzle helpers
    //     so we drop to a raw SQL fragment for the JSONB path filter only.
    const criticalAnomalyRows = await db
      .select({
        department: insights.department,
        id: insights.id,
      })
      .from(insights)
      .where(
        and(
          eq(insights.companyId, companyId),
          eq(insights.kind, "kpi_anomaly"),
          eq(insights.status, "open"),
          sql`${insights.evidence}->>'severity' = 'critical'`,
        ),
      );

    // (4b) All open insights (any kind) — counted into `openInsights`.
    const openInsightRows = await db
      .select({
        department: insights.department,
        id: insights.id,
      })
      .from(insights)
      .where(
        and(eq(insights.companyId, companyId), eq(insights.status, "open")),
      );

    // (5) Routines — `status='paused'` is the production analogue of a
    //     "stalled workflow" until the workflows table actually exists.
    //     Routines aren't department-tagged in the schema (yet), so the
    //     count is per-company and applied uniformly to every department.
    //     This is intentionally conservative: a single paused company-wide
    //     routine surfaces "yellow" on every dept that's otherwise green,
    //     which is the right founder-facing signal ("something's not
    //     running").
    const stalledRoutineRows = await db
      .select({ id: routines.id })
      .from(routines)
      .where(
        and(eq(routines.companyId, companyId), eq(routines.status, "paused")),
      );
    const stalledWorkflowsCount = stalledRoutineRows.length;

    // ── Aggregate ────────────────────────────────────────────────────────

    const runtimeByAgent = new Map(runtimeRows.map((r) => [r.agentId, r]));

    // Group agents by department.
    const agentsByDept = new Map<DepartmentId, typeof agentRows>();
    for (const dept of DEPARTMENT_IDS) agentsByDept.set(dept, []);
    for (const a of agentRows) {
      const dept = ROLE_TO_DEPARTMENT[a.role as AgentRole];
      if (!dept) continue;
      agentsByDept.get(dept)!.push(a);
    }

    // Group critical anomalies + all-open-insights by department.
    const criticalByDept = new Map<string, number>();
    for (const r of criticalAnomalyRows) {
      criticalByDept.set(r.department, (criticalByDept.get(r.department) ?? 0) + 1);
    }
    const openInsightsByDept = new Map<string, number>();
    for (const r of openInsightRows) {
      openInsightsByDept.set(
        r.department,
        (openInsightsByDept.get(r.department) ?? 0) + 1,
      );
    }

    const response: DepartmentStatusResponse = Object.fromEntries(
      DEPARTMENT_IDS.map((dept) => [dept, emptyRollup()]),
    ) as DepartmentStatusResponse;

    for (const dept of DEPARTMENT_IDS) {
      const deptAgents = agentsByDept.get(dept) ?? [];
      const agentCount = deptAgents.length;
      const agentIdSet = new Set(deptAgents.map((a) => a.id));

      const pendingApprovals = approvalRows.filter(
        (a) =>
          a.requestedByAgentId !== null && agentIdSet.has(a.requestedByAgentId),
      ).length;

      const openInsightCount = openInsightsByDept.get(dept) ?? 0;
      const criticalAnomalyCount = criticalByDept.get(dept) ?? 0;

      // Last activity: max(lastHeartbeatAt across dept agents,
      //                    agentRuntimeState.updatedAt across dept agents)
      let lastActivityAt: Date | null = null;
      for (const a of deptAgents) {
        if (a.lastHeartbeatAt && (!lastActivityAt || a.lastHeartbeatAt > lastActivityAt)) {
          lastActivityAt = a.lastHeartbeatAt;
        }
        const rt = runtimeByAgent.get(a.id);
        if (rt?.updatedAt && (!lastActivityAt || rt.updatedAt > lastActivityAt)) {
          lastActivityAt = rt.updatedAt;
        }
      }

      // Error-state agents: any dept agent whose runtime row has
      // lastRunStatus='error'.
      const hasErroredAgent = deptAgents.some((a) => {
        const rt = runtimeByAgent.get(a.id);
        return rt?.lastRunStatus === "error";
      });

      const isStale =
        lastActivityAt === null ||
        Date.now() - lastActivityAt.getTime() > STALE_ACTIVITY_MS;

      let health: DepartmentHealth;
      if (agentCount === 0) {
        health = "grey";
      } else if (
        hasErroredAgent ||
        pendingApprovals > PENDING_APPROVAL_RED_THRESHOLD ||
        criticalAnomalyCount > 0
      ) {
        health = "red";
      } else if (
        stalledWorkflowsCount > STALLED_WORKFLOW_YELLOW_THRESHOLD ||
        isStale
      ) {
        health = "yellow";
      } else {
        health = "green";
      }

      response[dept] = {
        health,
        openInsights: openInsightCount,
        pendingApprovals,
        stalledWorkflows: stalledWorkflowsCount,
        lastActivity: lastActivityAt ? lastActivityAt.toISOString() : null,
        agentCount,
      };
    }

    res.json(response);
  });

  return router;
}

function emptyRollup(): DepartmentRollup {
  return {
    health: "grey",
    openInsights: 0,
    pendingApprovals: 0,
    stalledWorkflows: 0,
    lastActivity: null,
    agentCount: 0,
  };
}
