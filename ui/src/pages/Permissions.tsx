import { useQuery } from "@tanstack/react-query";
import { Shield, AlertTriangle, ArrowRight, Lock } from "lucide-react";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import {
  permissionsApi,
  AUTONOMY_LABELS,
  AUTONOMY_DESCRIPTIONS,
  type PermissionsMatrixDepartment,
  type PermissionsMatrixWorkflow,
} from "../api/permissions";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

/**
 * Permissions matrix (S6.1) — read-only matrix of department × workflow
 * autonomy.
 *
 * Edits flow back through the existing endpoints:
 *   - Per-dept autonomy: PATCH /api/companies/:id/departments/:deptId
 *     (UI page: /departments)
 *   - Per-workflow autonomy: PATCH /api/companies/:id/workflows/:wfId
 *     (UI page: /departments/:dept/workflows/:wf — links rendered below)
 *   - Master switch: instance settings → Lifecycle CRM → autonomous email
 *
 * Read-only first because every autonomy=4 promotion is a council-gated
 * change. The matrix is the *visibility* layer; the existing detail pages
 * keep the audit trail and gate logic.
 */
export function Permissions() {
  const { selectedCompanyId } = useCompany();

  if (!selectedCompanyId) {
    return (
      <div className="rounded-lg border border-border bg-muted/20 px-6 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          Select a company to view its permissions matrix.
        </p>
      </div>
    );
  }

  return <PermissionsMatrixView companyId={selectedCompanyId} />;
}

function PermissionsMatrixView({ companyId }: { companyId: string }) {
  const matrixQuery = useQuery({
    queryKey: queryKeys.permissions.matrix(companyId),
    queryFn: () => permissionsApi.matrix(companyId),
  });

  if (matrixQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }
  if (matrixQuery.error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
        Failed to load matrix:{" "}
        {matrixQuery.error instanceof Error
          ? matrixQuery.error.message
          : "unknown error"}
      </div>
    );
  }
  if (!matrixQuery.data) return null;

  const matrix = matrixQuery.data;
  const totalWorkflows = matrix.departments.reduce(
    (sum, d) => sum + d.workflows.length,
    0,
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-1.5 pt-1">
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Permissions
        </div>
        <h1 className="font-display text-[32px] md:text-[40px] leading-[1.05] tracking-tight text-foreground">
          Authority matrix
        </h1>
        <p className="text-[12px] text-muted-foreground tabular-nums">
          <span className="font-medium text-foreground">
            {matrix.departments.length} departments
          </span>
          <span className="mx-2 text-muted-foreground/40">·</span>
          <span className="font-medium text-foreground">
            {totalWorkflows} {totalWorkflows === 1 ? "workflow" : "workflows"}
          </span>
          <span className="mx-2 text-muted-foreground/40">·</span>
          autonomous email{" "}
          <span
            className={cn(
              "font-medium",
              matrix.autonomousMasterSwitch
                ? "text-amber-700 dark:text-amber-400"
                : "text-foreground",
            )}
          >
            {matrix.autonomousMasterSwitch ? "ENABLED" : "disabled"}
          </span>
        </p>
      </header>

      {matrix.autonomousMasterSwitch && (
        <div className="rounded-lg border border-amber-300/40 bg-amber-50 dark:bg-amber-950/20 px-4 py-3 text-sm flex items-start gap-2">
          <AlertTriangle className="size-4 text-amber-700 dark:text-amber-400 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium text-amber-900 dark:text-amber-300">
              Autonomous email is enabled instance-wide.
            </p>
            <p className="text-xs text-amber-800/80 dark:text-amber-300/80 mt-1">
              Workflows at autonomy=4 will execute customer-facing actions
              without human approval. Review the matrix below carefully.
            </p>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-medium mb-3 flex items-center gap-2">
          <Shield className="size-4 text-muted-foreground" />
          Authority levels
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          {[1, 2, 3, 4].map((lvl) => (
            <div
              key={lvl}
              className="rounded-md border border-border bg-background px-3 py-2"
            >
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-xs text-muted-foreground">
                  L{lvl}
                </span>
                <span className="font-medium text-sm">
                  {AUTONOMY_LABELS[lvl]}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {AUTONOMY_DESCRIPTIONS[lvl]}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        {matrix.departments.map((dept) => (
          <DepartmentCard
            key={dept.id}
            companyId={companyId}
            dept={dept}
          />
        ))}
      </div>
    </div>
  );
}

function DepartmentCard({
  companyId,
  dept,
}: {
  companyId: string;
  dept: PermissionsMatrixDepartment;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold">{dept.label}</h3>
          <p className="text-[11px] text-muted-foreground">
            Department default:{" "}
            <AutonomyBadge level={dept.deptAutonomy} />
          </p>
        </div>
        <Link
          to="/departments"
          className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          Edit defaults
          <ArrowRight className="size-3" />
        </Link>
      </div>

      {dept.workflows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground py-2">
          No workflows configured.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {dept.workflows.map((wf) => (
            <WorkflowRow key={wf.id} companyId={companyId} wf={wf} />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkflowRow({
  companyId,
  wf,
}: {
  companyId: string;
  wf: PermissionsMatrixWorkflow;
}) {
  return (
    <div className="py-2.5 flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{wf.name}</span>
          {wf.source === "override" && (
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              override
            </span>
          )}
          {wf.status !== "active" && (
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
              {wf.status}
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground tabular-nums truncate">
          {wf.template}
        </p>
      </div>
      <AutonomyBadge level={wf.autonomy} />
      <Link
        to={`/companies/${companyId}/workflows/${wf.id}`}
        className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 flex-shrink-0"
        title="Edit this workflow's autonomy"
      >
        Edit
        <ArrowRight className="size-3" />
      </Link>
    </div>
  );
}

function AutonomyBadge({ level }: { level: number }) {
  // Visual ladder: lower levels = neutral, level 4 = warn (autonomous)
  const tone =
    level === 4
      ? "bg-amber-100 dark:bg-amber-950/40 text-amber-900 dark:text-amber-300 border-amber-300/40"
      : level === 3
        ? "bg-blue-50 dark:bg-blue-950/30 text-blue-900 dark:text-blue-300 border-blue-300/30"
        : "bg-muted text-foreground border-border";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border tabular-nums",
        tone,
      )}
    >
      {level === 4 && <Lock className="size-3" />}
      L{level} · {AUTONOMY_LABELS[level]}
    </span>
  );
}
