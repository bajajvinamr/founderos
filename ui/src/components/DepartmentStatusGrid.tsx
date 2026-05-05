import { useQuery } from "@tanstack/react-query";
import { departmentStatusApi, type DepartmentId } from "../api/department-status";
import { queryKeys } from "../lib/queryKeys";
import { DEPARTMENTS, getDepartmentById } from "../lib/departments";
import { DepartmentStatusCard } from "./DepartmentStatusCard";

interface DepartmentStatusGridProps {
  companyId: string;
}

// The endpoint returns the five "insight departments" — these are the slugs
// that map to the live rollup. The UI's broader DEPARTMENTS list (which
// includes engineering + ops) is filtered down to this set; we don't render
// cards for departments without a server rollup.
const REPORTED_DEPARTMENT_IDS: DepartmentId[] = [
  "chief-of-staff",
  "growth",
  "content",
  "crm",
  "finance",
];

export function DepartmentStatusGrid({ companyId }: DepartmentStatusGridProps) {
  const { data } = useQuery({
    queryKey: queryKeys.departments.status(companyId),
    queryFn: () => departmentStatusApi.get(companyId),
    enabled: !!companyId,
    // Department status is a derived rollup — refresh frequently enough
    // that errored agents and approval surges don't sit stale on the
    // Dashboard, but not so often we hammer the server. 30s matches the
    // dashboard polling cadence.
    refetchInterval: 30_000,
  });

  return (
    <section aria-label="Department status">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Department Status
        </h3>
        <p className="text-xs text-muted-foreground tabular-nums">
          {REPORTED_DEPARTMENT_IDS.length} departments
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
        {REPORTED_DEPARTMENT_IDS.map((deptId) => {
          const meta = getDepartmentById(deptId);
          // Should always resolve since DEPARTMENT_IDS is a subset of
          // DEPARTMENTS — but guard so a future renaming doesn't crash the
          // dashboard.
          if (!meta) return null;
          const rollup = data?.[deptId];
          return (
            <DepartmentStatusCard
              key={deptId}
              departmentId={deptId}
              label={meta.label}
              icon={meta.icon}
              health={rollup?.health ?? "grey"}
              openInsights={rollup?.openInsights ?? 0}
              pendingApprovals={rollup?.pendingApprovals ?? 0}
              stalledWorkflows={rollup?.stalledWorkflows ?? 0}
              lastActivity={rollup?.lastActivity ?? null}
              agentCount={rollup?.agentCount ?? 0}
            />
          );
        })}
      </div>
      {/* DEPARTMENTS (engineering, ops) without server rollups are
          intentionally not surfaced here — the Dashboard shows the five
          INSIGHT_DEPARTMENTS only. Re-introduce engineering/ops when the
          server endpoint expands to cover them. */}
      <div className="sr-only" aria-hidden="true">
        {DEPARTMENTS.length}
      </div>
    </section>
  );
}
