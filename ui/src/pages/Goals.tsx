import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import type { Agent, Goal } from "@founderos/shared";
import { goalsApi } from "../api/goals";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import { Target, Plus } from "lucide-react";

export type DriftBand = "ontrack" | "behind" | "atrisk" | "cancelled";

export interface DriftSnapshot {
  band: DriftBand;
  /** 0–100; higher = more drift. */
  score: number;
  label: string;
}

/**
 * Layout-time drift derivation from Goal.status. The data model does not yet
 * surface a target/current pair, so the page renders a status-derived signal
 * until the backing fields ship. Strict mapping keeps colors stable across
 * renders and avoids the OKR-spreadsheet feel: every goal still gets a band.
 *
 * TODO(W3-schema): replace with goal.drift_band once the backing column ships.
 * The switch below is exhaustive over `GoalStatus`; the never-narrowing default
 * guarantees a compile error if a new status is added without a band mapping.
 */
export function deriveDrift(goal: Goal): DriftSnapshot {
  switch (goal.status) {
    case "achieved":
      return { band: "ontrack", score: 0, label: "Achieved" };
    case "active":
      return { band: "ontrack", score: 20, label: "On track" };
    case "planned":
      return { band: "behind", score: 55, label: "Behind plan" };
    case "cancelled":
      // Cancelled goals are TERMINATED, not at-risk-of-failing. Render with a
      // neutral band so founders don't read a false "this is going wrong" signal.
      return { band: "cancelled", score: 0, label: "Cancelled" };
    default: {
      // Exhaustiveness check — fails at compile time if a new GoalStatus is
      // added without a case above. At runtime, fall back to a neutral band.
      const _exhaustive: never = goal.status;
      void _exhaustive;
      return { band: "cancelled", score: 0, label: "Unknown" };
    }
  }
}

function driftBarClasses(band: DriftBand): string {
  if (band === "ontrack") return "bg-emerald-500/80";
  if (band === "behind") return "bg-amber-500/80";
  if (band === "atrisk") return "bg-rose-500/80";
  return "bg-muted-foreground/40";
}

function driftDotClasses(band: DriftBand): string {
  if (band === "ontrack") return "bg-emerald-500";
  if (band === "behind") return "bg-amber-500";
  if (band === "atrisk") return "bg-rose-500";
  return "bg-muted-foreground/50";
}

function levelLabel(level: Goal["level"]): string {
  switch (level) {
    case "company":
      return "Company";
    case "team":
      return "Team";
    case "agent":
      return "Agent";
    case "task":
      return "Task";
    default:
      return level;
  }
}

interface GoalRowProps {
  goal: Goal;
  agentsById: Map<string, Agent>;
}

function GoalRow({ goal, agentsById }: GoalRowProps) {
  const drift = deriveDrift(goal);
  const ownerAgent = goal.ownerAgentId ? agentsById.get(goal.ownerAgentId) : null;
  const updatedLabel = new Date(goal.updatedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const ariaLabel = `Goal: ${goal.title}, ${drift.label}`;

  return (
    <Link
      to={`/goals/${goal.id}`}
      role="article"
      aria-label={ariaLabel}
      className={cn(
        "block border-b border-border px-4 py-3 text-sm no-underline text-inherit",
        "transition-colors hover:bg-accent/50",
      )}
    >
      <div className="flex items-start gap-3">
        <Target className="h-4 w-4 mt-0.5 text-muted-foreground/70 shrink-0" />
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground capitalize shrink-0">
              {levelLabel(goal.level)}
            </span>
            <span className="truncate font-medium">{goal.title}</span>
          </div>
          <div className="flex items-center gap-3">
            <div
              role="progressbar"
              aria-valuenow={drift.score}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Drift score ${drift.score} of 100`}
              className="relative h-1.5 w-40 max-w-[40%] overflow-hidden rounded-full bg-muted"
            >
              <span
                className={cn("absolute inset-y-0 left-0", driftBarClasses(drift.band))}
                style={{ width: `${Math.min(100, Math.max(6, drift.score))}%` }}
              />
            </div>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                aria-hidden="true"
                className={cn("h-2 w-2 rounded-full", driftDotClasses(drift.band))}
              />
              {drift.label}
            </span>
            <span className="text-xs text-muted-foreground">
              Updated {updatedLabel}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Contributors:</span>
            {ownerAgent ? (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5"
                title={ownerAgent.name}
              >
                <span className="text-foreground">{ownerAgent.name}</span>
              </span>
            ) : (
              <span className="italic">unassigned</span>
            )}
          </div>
        </div>
        <StatusBadge status={goal.status} />
      </div>
    </Link>
  );
}

export function Goals() {
  const { selectedCompanyId } = useCompany();
  const { openNewGoal } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Goals" }]);
  }, [setBreadcrumbs]);

  const { data: goals, isLoading, error } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentsById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents ?? []) map.set(agent.id, agent);
    return map;
  }, [agents]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Target} message="Select a company to view goals." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-bold tracking-tight">Goals</h1>
          <p className="text-sm text-muted-foreground">
            Where the team's headed
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => openNewGoal()} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          New goal
        </Button>
      </header>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {goals && goals.length === 0 && (
        <EmptyState
          icon={Target}
          message="No goals tracked."
          action="Create your first goal"
          onAction={() => openNewGoal()}
        />
      )}

      {goals && goals.length > 0 && (
        <div className="border border-border">
          {goals.map((goal) => (
            <GoalRow key={goal.id} goal={goal} agentsById={agentsById} />
          ))}
        </div>
      )}
    </div>
  );
}
