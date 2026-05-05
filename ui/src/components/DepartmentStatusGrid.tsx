import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { queryKeys } from "../lib/queryKeys";
import { DEPARTMENTS, agentsInDepartment, departmentForRole } from "../lib/departments";
import { DepartmentStatusCard, type DepartmentHealth } from "./DepartmentStatusCard";
import type { Agent, Approval } from "@founderos/shared";

const STALE_ACTIVITY_MS = 24 * 60 * 60 * 1000; // 24h
const APPROVAL_RED_THRESHOLD = 5;

interface DepartmentStatusGridProps {
  companyId: string;
}

export interface DepartmentRollup {
  departmentId: string;
  agentCount: number;
  unresolvedApprovals: number;
  lastActivityAt: Date | null;
  health: DepartmentHealth;
}

/**
 * Pure rollup logic — exported for unit testing without mounting React.
 *
 * Health rules:
 *   red    = any agent in `error` status OR unresolvedApprovals > 5
 *   yellow = lastActivityAt missing or > 24h ago (and dept is configured)
 *   grey   = agentCount === 0 (department not staffed)
 *   green  = else
 */
export function computeDepartmentRollup(
  departmentId: string,
  agents: Agent[],
  approvals: Approval[],
): DepartmentRollup {
  const deptAgents = agentsInDepartment(departmentId, agents);
  const agentCount = deptAgents.length;

  const agentIdSet = new Set(deptAgents.map((a) => a.id));
  const deptApprovals = approvals.filter(
    (a) => a.requestedByAgentId !== null && agentIdSet.has(a.requestedByAgentId),
  );
  const unresolvedApprovals = deptApprovals.length;

  const lastActivityAt = deptAgents
    .map((a) => a.lastHeartbeatAt)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

  let health: DepartmentHealth;
  const hasError = deptAgents.some((a) => a.status === "error");
  if (agentCount === 0) {
    health = "grey";
  } else if (hasError || unresolvedApprovals > APPROVAL_RED_THRESHOLD) {
    health = "red";
  } else if (
    lastActivityAt === null ||
    Date.now() - lastActivityAt.getTime() > STALE_ACTIVITY_MS
  ) {
    health = "yellow";
  } else {
    health = "green";
  }

  return {
    departmentId,
    agentCount,
    unresolvedApprovals,
    lastActivityAt,
    health,
  };
}

export function DepartmentStatusGrid({ companyId }: DepartmentStatusGridProps) {
  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const { data: approvals = [] } = useQuery({
    queryKey: queryKeys.approvals.list(companyId, "pending"),
    queryFn: () => approvalsApi.list(companyId, "pending"),
    enabled: !!companyId,
  });

  // Suppress unused import warning when departmentForRole stays unused after future tweaks.
  void departmentForRole;

  return (
    <section aria-label="Department status">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Department Status
        </h3>
        <p className="text-xs text-muted-foreground tabular-nums">
          {DEPARTMENTS.length} departments
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
        {DEPARTMENTS.map((dept) => {
          const rollup = computeDepartmentRollup(dept.id, agents, approvals);
          return (
            <DepartmentStatusCard
              key={dept.id}
              departmentId={dept.id}
              label={dept.label}
              icon={dept.icon}
              agentCount={rollup.agentCount}
              health={rollup.health}
              unresolvedApprovals={rollup.unresolvedApprovals}
              lastActivityAt={rollup.lastActivityAt}
            />
          );
        })}
      </div>
    </section>
  );
}
