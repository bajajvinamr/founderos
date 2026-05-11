import { ChevronRight } from "lucide-react";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";

/**
 * A single row in the Today decision list.
 *
 * Per `02-calm-surfaces.md §A.3`:
 *   - Leading colored dot (priority signal).
 *   - Single-sentence verb-voiced title (e.g., "Stripe webhook idempotency
 *     — needs your sign-off"). NOT noun phrases.
 *   - Optional context line: `from {source} · {timeAgo} · flagged by {agent}`.
 *   - Trailing chevron.
 *   - Entire row is the click target. Routes to the existing
 *     `/approvals/:id` per scope-fence (§12) — the approval detail page
 *     layout is intentionally untouched.
 */

export type DecisionPriority = "high" | "medium" | "low";

export interface DecisionBriefData {
  id: string;
  priority: DecisionPriority;
  /** Verb-voiced sentence; sentence-case; no trailing period required. */
  title: string;
  /** Optional one-line context (source, age, agent). */
  context?: string;
  /** Existing /approvals/:id URL (per scope-fence §12). */
  href: string;
}

export interface DecisionBriefProps {
  decision: DecisionBriefData;
}

const PRIORITY_DOT_CLASS: Record<DecisionPriority, string> = {
  high: "bg-red-500",
  medium: "bg-yellow-500",
  low: "bg-muted-foreground/40",
};

const PRIORITY_LABEL: Record<DecisionPriority, string> = {
  high: "high priority",
  medium: "medium priority",
  low: "low priority",
};

export function DecisionBrief({ decision }: DecisionBriefProps) {
  return (
    <Link
      to={decision.href}
      aria-label={`${decision.title}, ${PRIORITY_LABEL[decision.priority]}`}
      className={cn(
        "group flex items-start gap-3 px-4 py-3 transition-colors",
        "hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
      )}
    >
      <span
        className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", PRIORITY_DOT_CLASS[decision.priority])}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium leading-snug text-foreground">
          {decision.title}
        </div>
        {decision.context && (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {decision.context}
          </div>
        )}
      </div>
      <ChevronRight
        className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
        aria-hidden="true"
      />
    </Link>
  );
}
