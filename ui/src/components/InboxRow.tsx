import { useState } from "react";
import {
  CheckCircle2,
  AlertTriangle,
  GitBranch,
  AtSign,
  Clock,
  Archive,
  ChevronRight,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { QuickApprove, DisabledQuickApprove } from "./QuickApprove";

export type InboxRowSource = "approval" | "issue" | "decision" | "mention";
export type InboxRowRisk = "high" | "medium" | "low" | null;

export interface InboxRowProps {
  id: string;
  title: string;
  context: string;
  source: InboxRowSource;
  risk: InboxRowRisk;
  /** Display string for age, e.g. "8m ago". Parent computes; row only renders. */
  age: string;
  onOpenDetail: () => void;
  onSnooze: (until: Date) => void;
  onArchive: () => void;
  /**
   * Approval handler — only invoked from the inline QuickApprove path.
   * Required when source === "approval".
   */
  onApprove?: (id: string) => void;
  /** Undo handler for the optimistic approval. */
  onUndo?: (id: string) => void;
}

const sourceIconMap: Record<InboxRowSource, React.ComponentType<{ className?: string }>> = {
  approval: CheckCircle2,
  issue: AlertTriangle,
  decision: GitBranch,
  mention: AtSign,
};

const sourceLabel: Record<InboxRowSource, string> = {
  approval: "Approval",
  issue: "Issue",
  decision: "Decision",
  mention: "Mention",
};

function riskPillClass(risk: InboxRowRisk): string {
  if (risk === "high")
    return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  if (risk === "medium")
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (risk === "low")
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  return "";
}

/**
 * Default snooze target: 4 hours from now. Parents can override by passing
 * a custom `onSnooze` that ignores the timestamp.
 */
function defaultSnoozeUntil(): Date {
  const d = new Date();
  d.setHours(d.getHours() + 4);
  return d;
}

/**
 * Single inbox-queue row. Spec: docs/design/founderos-frontend-plan/03-work-surfaces.md §A.
 *
 * Renders: source-icon · title · 1-line context · age · risk-pill.
 * Inline actions on hover: QuickApprove (when approval+low-risk), snooze, archive, open detail.
 * Stateless beyond local hover affordance — all mutations bubble via callback props.
 */
export function InboxRow({
  id,
  title,
  context,
  source,
  risk,
  age,
  onOpenDetail,
  onSnooze,
  onArchive,
  onApprove,
  onUndo,
}: InboxRowProps) {
  const [isHover, setIsHover] = useState(false);
  const SourceIcon = sourceIconMap[source];
  const showQuickApprove = source === "approval" && Boolean(onApprove) && Boolean(onUndo);

  return (
    <div
      data-testid="inbox-row"
      data-row-id={id}
      data-source={source}
      data-risk={risk ?? "none"}
      className="group flex items-center gap-3 rounded-md border border-border/60 bg-card px-3 py-2 transition-colors hover:bg-accent/30"
      onMouseEnter={() => setIsHover(true)}
      onMouseLeave={() => setIsHover(false)}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/80">
        <SourceIcon
          className="h-4 w-4 text-muted-foreground"
          aria-label={sourceLabel[source]}
        />
      </div>

      <button
        type="button"
        onClick={onOpenDetail}
        data-testid="inbox-row-open"
        className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded-sm"
      >
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{title}</span>
          {risk && (
            <Badge
              variant="outline"
              data-testid="inbox-row-risk"
              className={cn(
                "shrink-0 px-1.5 py-0 text-[10px] uppercase tracking-wide",
                riskPillClass(risk),
              )}
            >
              {risk}
            </Badge>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground">{context}</div>
      </button>

      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{age}</span>

      {showQuickApprove && (
        risk === "low" ? (
          <QuickApprove
            rowId={id}
            risk={risk}
            onApprove={onApprove!}
            onUndo={onUndo!}
          />
        ) : (
          <DisabledQuickApprove
            tooltip="High-risk — review details first"
            onClick={onOpenDetail}
          />
        )
      )}

      <div
        className={cn(
          "flex shrink-0 items-center gap-1 transition-opacity",
          isHover ? "opacity-100" : "opacity-0",
        )}
        data-testid="inbox-row-actions"
      >
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Snooze"
          onClick={() => onSnooze(defaultSnoozeUntil())}
        >
          <Clock />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Archive"
          onClick={onArchive}
        >
          <Archive />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="View detail"
          onClick={onOpenDetail}
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
