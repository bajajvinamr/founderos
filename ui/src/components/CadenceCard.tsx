import { CalendarClock, MoreHorizontal, Pause, Play, Settings2, SkipForward } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { RoutineListItem, RoutineRunSummary } from "@founderos/shared";

// Component-local Cadence types — server-side type names (RoutineListItem) live
// in @founderos/shared and are out of W2.3 rename scope. We alias here so the
// component reads as Cadence-native while the data shape stays compatible.
export type Cadence = RoutineListItem;
export type CadenceRunSummary = RoutineRunSummary;

export type CadenceTimelineStatus = "success" | "failed" | "skipped" | "pending";

interface CadenceTimelineDot {
  key: string;
  status: CadenceTimelineStatus;
  ariaLabel: string;
}

interface CadenceCardProps {
  cadence: Cadence;
  scheduleLabel: string;
  agentName: string | null;
  agentIcon?: string | null;
  isStatusPending?: boolean;
  isRunning?: boolean;
  onTogglePause: () => void;
  onSkipNext: () => void;
  onEdit: () => void;
  onOpenDetail: () => void;
}

function formatRelative(value: Date | string | null | undefined, suffix: "ago" | "from now"): string {
  if (!value) return "—";
  const ts = typeof value === "string" ? new Date(value).getTime() : value.getTime();
  if (Number.isNaN(ts)) return "—";
  const diffMs = suffix === "ago" ? Date.now() - ts : ts - Date.now();
  if (diffMs < 0 && suffix === "from now") {
    const overdueMin = Math.floor(-diffMs / 60_000);
    return `overdue ${overdueMin}m`;
  }
  const minutes = Math.max(0, Math.floor(diffMs / 60_000));
  if (minutes < 60) return `${minutes}m ${suffix}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${suffix}`;
  const days = Math.floor(hours / 24);
  return `${days}d ${suffix}`;
}

function runStatusToTimeline(status: string | null | undefined): CadenceTimelineStatus {
  if (!status) return "pending";
  const normalized = status.toLowerCase();
  if (normalized.includes("fail") || normalized.includes("error")) return "failed";
  if (normalized.includes("skip") || normalized.includes("coalesce")) return "skipped";
  if (
    normalized.includes("complete") ||
    normalized.includes("succeed") ||
    normalized === "ok" ||
    normalized === "done"
  ) {
    return "success";
  }
  return "pending";
}

function dotColorClass(status: CadenceTimelineStatus): string {
  switch (status) {
    case "success":
      return "bg-emerald-500";
    case "failed":
      return "bg-red-500";
    case "skipped":
      return "bg-muted-foreground/50";
    case "pending":
      return "border border-border bg-transparent";
  }
}

function buildTimeline(cadence: Cadence): CadenceTimelineDot[] {
  const lastRuns: CadenceRunSummary[] = cadence.lastRun ? [cadence.lastRun] : [];
  const pastDots: CadenceTimelineDot[] = lastRuns.slice(0, 5).map((run) => ({
    key: run.id,
    status: runStatusToTimeline(run.status),
    ariaLabel: `Run ${new Date(run.triggeredAt).toLocaleString()}: ${run.status ?? "unknown"}`,
  }));

  // Pad with placeholder past dots up to 5 (each represents an unknown past slot).
  while (pastDots.length < 5) {
    pastDots.unshift({
      key: `placeholder-${pastDots.length}`,
      status: "skipped",
      ariaLabel: "No prior run",
    });
  }

  const nextTrigger = cadence.triggers?.find((trigger) => trigger.enabled && trigger.nextRunAt);
  const nextDot: CadenceTimelineDot = {
    key: "next",
    status: "pending",
    ariaLabel: nextTrigger?.nextRunAt
      ? `Next run ${new Date(nextTrigger.nextRunAt).toLocaleString()}`
      : "No upcoming run",
  };

  return [...pastDots, nextDot];
}

function pickPrimaryTrigger(cadence: Cadence) {
  return cadence.triggers?.find((trigger) => trigger.enabled) ?? cadence.triggers?.[0] ?? null;
}

export function CadenceCard({
  cadence,
  scheduleLabel,
  agentName,
  isStatusPending = false,
  isRunning = false,
  onTogglePause,
  onSkipNext,
  onEdit,
  onOpenDetail,
}: CadenceCardProps) {
  const isPaused = cadence.status === "paused";
  const isArchived = cadence.status === "archived";
  const isActive = cadence.status === "active";
  const lastRunStatus = runStatusToTimeline(cadence.lastRun?.status);
  const consecutiveFailing = lastRunStatus === "failed";
  const primaryTrigger = pickPrimaryTrigger(cadence);
  const timeline = buildTimeline(cadence);
  const lastRunLabel = cadence.lastRun?.triggeredAt
    ? `Last ran ${formatRelative(cadence.lastRun.triggeredAt, "ago")}`
    : "Never run";
  const nextRunLabel = primaryTrigger?.nextRunAt
    ? `next ${formatRelative(primaryTrigger.nextRunAt, "from now")}`
    : "no schedule";

  const ariaLabel = `Cadence: ${cadence.title}, ${
    primaryTrigger?.nextRunAt ? `next run ${nextRunLabel}` : "no schedule"
  }, status ${cadence.status}`;

  return (
    <Card
      role="article"
      aria-label={ariaLabel}
      data-testid="cadence-card"
      data-cadence-id={cadence.id}
      className={[
        "group relative flex flex-col gap-4 p-5 transition-opacity",
        isPaused ? "opacity-60" : "",
        consecutiveFailing ? "border-l-4 border-l-red-500" : "",
        isArchived ? "opacity-40" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-pointer rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        aria-label={`Open ${cadence.title} history`}
        onClick={onOpenDetail}
      />

      <div className="relative z-10 flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
          <CalendarClock className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-foreground">{cadence.title}</h3>
            {isPaused ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Paused
              </span>
            ) : null}
            {isArchived ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Archived
              </span>
            ) : null}
            {isActive && consecutiveFailing ? (
              <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400">
                Last run failed — see history.
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span
              className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-0.5"
              data-testid="cadence-schedule-chip"
            >
              {scheduleLabel}
            </span>
            {agentName ? (
              <span className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-0.5">
                {agentName}
              </span>
            ) : null}
          </div>
        </div>

        <div className="relative z-20" onClick={(event) => event.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`More actions for ${cadence.title}`}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onOpenDetail}>Open history</DropdownMenuItem>
              <DropdownMenuItem onClick={onEdit}>Edit cadence</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={onSkipNext}
                disabled={!isActive || isRunning}
              >
                Skip next
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onTogglePause}
                disabled={isStatusPending || isArchived}
              >
                {isPaused ? "Resume" : "Pause"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="relative z-10 space-y-2" data-testid="cadence-timeline">
        <div className="text-xs text-muted-foreground">
          {lastRunLabel} <span className="text-muted-foreground/50">·</span> {nextRunLabel}
        </div>
        <div className="flex items-center gap-2" aria-label="Recent run timeline">
          {timeline.map((dot, index) => (
            <div key={dot.key} className="flex items-center gap-2">
              <span
                className={`inline-block h-2.5 w-2.5 rounded-full ${dotColorClass(dot.status)}`}
                role="img"
                aria-label={dot.ariaLabel}
                data-status={dot.status}
              />
              {index < timeline.length - 1 ? (
                <span className="h-px w-3 bg-border/70" aria-hidden="true" />
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div
        className="relative z-20 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3"
        onClick={(event) => event.stopPropagation()}
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={onTogglePause}
          disabled={isStatusPending || isArchived}
          aria-label={isPaused ? `Resume ${cadence.title}` : `Pause ${cadence.title}`}
        >
          {isPaused ? (
            <>
              <Play className="mr-1.5 h-3.5 w-3.5" />
              Resume
            </>
          ) : (
            <>
              <Pause className="mr-1.5 h-3.5 w-3.5" />
              Pause
            </>
          )}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onSkipNext}
          disabled={!isActive || isRunning}
          aria-label={`Skip next ${cadence.title} run`}
        >
          <SkipForward className="mr-1.5 h-3.5 w-3.5" />
          Skip once
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onEdit}
          aria-label={`Edit ${cadence.title}`}
        >
          <Settings2 className="mr-1.5 h-3.5 w-3.5" />
          Edit cadence
        </Button>
      </div>
    </Card>
  );
}
