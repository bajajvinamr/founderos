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
  agentCount: number;
  health: DepartmentHealth;
  unresolvedApprovals: number;
  lastActivityAt: Date | null;
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
  agentCount,
  health,
  unresolvedApprovals,
  lastActivityAt,
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
              {unresolvedApprovals > 0 && (
                <>
                  <span className="mx-1.5">·</span>
                  <span className="text-amber-600 dark:text-amber-400">
                    {unresolvedApprovals} pending
                  </span>
                </>
              )}
            </p>
          </div>
        </div>
        <Circle
          className={cn("h-2.5 w-2.5 shrink-0 mt-1.5", HEALTH_RING[health])}
          aria-hidden="true"
        />
      </div>
      {lastActivityAt && agentCount > 0 && (
        <p className="text-[11px] text-muted-foreground/70 mt-2 tabular-nums">
          Last activity {timeAgo(lastActivityAt)}
        </p>
      )}
    </Link>
  );
}
