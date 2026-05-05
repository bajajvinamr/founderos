import { Link } from "@/lib/router";
import { Circle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "../lib/timeAgo";

export type DepartmentHealth = "green" | "yellow" | "red" | "grey";

export interface DepartmentStatusCardProps {
  departmentId: string;
  label: string;
  icon: LucideIcon;
  health: DepartmentHealth;
  /** Number of open insights surfaced for this department. */
  openInsights: number;
  /** Number of pending approvals attributed to this department's agents. */
  pendingApprovals: number;
  /** Number of stalled (paused) workflows — company-scoped today. */
  stalledWorkflows: number;
  /** ISO timestamp of the most-recent activity across this department's
   *  agents (heartbeat OR runtime updatedAt, whichever is later). */
  lastActivity: string | null;
  agentCount: number;
}

const HEALTH_RING: Record<DepartmentHealth, string> = {
  green: "fill-emerald-500 text-emerald-500",
  yellow: "fill-amber-500 text-amber-500",
  red: "fill-red-500 text-red-500",
  grey: "fill-muted-foreground/40 text-muted-foreground/40",
};

const HEALTH_LABEL: Record<DepartmentHealth, string> = {
  green: "Healthy",
  yellow: "Attention",
  red: "Action needed",
  grey: "Not configured",
};

export function DepartmentStatusCard({
  departmentId,
  label,
  icon: Icon,
  health,
  openInsights,
  pendingApprovals,
  stalledWorkflows,
  lastActivity,
  agentCount,
}: DepartmentStatusCardProps) {
  return (
    <Link
      to={`/departments/${departmentId}`}
      className="block rounded-md border border-border bg-card px-4 py-3 no-underline text-inherit hover:bg-accent/30 transition-colors"
      aria-label={`${label} department — ${HEALTH_LABEL[health]}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <Icon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground truncate">{label}</p>
            <p className="text-xs text-muted-foreground tabular-nums mt-0.5">
              {agentCount === 0
                ? "No teammates"
                : `${agentCount} teammate${agentCount === 1 ? "" : "s"}`}
            </p>
          </div>
        </div>
        <Circle
          className={cn("h-2.5 w-2.5 shrink-0 mt-1.5", HEALTH_RING[health])}
          aria-hidden="true"
        />
      </div>

      {/* Four-counter row — matches MetricCard / FinanceKindCard density.
          Hidden when the dept is grey since every counter would be 0
          and the row would just add visual noise. */}
      {agentCount > 0 && (
        <dl className="grid grid-cols-4 gap-2 mt-3">
          <CounterCell label="Insights" value={openInsights} />
          <CounterCell
            label="Approvals"
            value={pendingApprovals}
            tone={pendingApprovals > 0 ? "warn" : "default"}
          />
          <CounterCell
            label="Stalled"
            value={stalledWorkflows}
            tone={stalledWorkflows > 0 ? "warn" : "default"}
          />
          <CounterCell
            label="Last seen"
            value={lastActivity ? timeAgo(lastActivity) : "—"}
            mono
          />
        </dl>
      )}
    </Link>
  );
}

interface CounterCellProps {
  label: string;
  value: string | number;
  tone?: "default" | "warn";
  mono?: boolean;
}

function CounterCell({ label, value, tone = "default", mono = false }: CounterCellProps) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
        {label}
      </dt>
      <dd
        className={cn(
          "text-xs font-medium tabular-nums truncate",
          mono ? "text-muted-foreground" : "text-foreground",
          tone === "warn" && "text-amber-600 dark:text-amber-400",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
