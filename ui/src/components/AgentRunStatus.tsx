import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { RotateCcw, AlertTriangle, XCircle, Slash, Loader2, Clock, CheckCircle2, Timer } from "lucide-react";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Heartbeat run status used by the UI. We keep this narrow so all callers must
 * agree on the canonical set — matches HEARTBEAT_RUN_STATUSES in @founderos/shared.
 */
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export interface AgentRunStatusRun {
  id: string;
  status: RunStatus | string;
  startedAt: string | Date | null;
  finishedAt: string | Date | null;
  error?: string | null;
  errorCode?: string | null;
}

export interface AgentRunStatusProps {
  run: AgentRunStatusRun;
  /** Shows "Cancel" button after HINT_HOLD_SEC while run is active. */
  onCancel?: () => void;
  isCancelling?: boolean;
  /** Shows "Retry" button when terminal state is failure-like. */
  onRetry?: () => void;
  isRetrying?: boolean;
  /** Compact layout for row/list surfaces. */
  compact?: boolean;
  className?: string;
}

// -----------------------------------------------------------------------------
// Status pill — single source of truth for run state visuals.
// -----------------------------------------------------------------------------

const STATUS_META: Record<RunStatus, { label: string; icon: typeof CheckCircle2; className: string; animate?: boolean }> = {
  queued: {
    label: "Queued",
    icon: Clock,
    className: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300",
  },
  running: {
    label: "Running",
    icon: Loader2,
    className: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300",
    animate: true,
  },
  succeeded: {
    label: "Completed",
    icon: CheckCircle2,
    className: "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300",
  },
  failed: {
    label: "Failed",
    icon: XCircle,
    className: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
  },
  cancelled: {
    label: "Cancelled",
    icon: Slash,
    className: "bg-muted text-muted-foreground",
  },
  timed_out: {
    label: "Timed out",
    icon: Timer,
    className: "bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300",
  },
};

function coerceStatus(status: string): RunStatus {
  if (status in STATUS_META) return status as RunStatus;
  return "queued";
}

export function RunStatusPill({ status, className }: { status: string; className?: string }) {
  const meta = STATUS_META[coerceStatus(status)];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        meta.className,
        className,
      )}
    >
      <Icon className={cn("h-3 w-3", meta.animate && "animate-spin")} />
      {meta.label}
    </span>
  );
}

// -----------------------------------------------------------------------------
// Error-reason taxonomy — maps backend errorCode strings to UI copy.
//
// Backend codes observed in heartbeat.ts + adapter packages:
//   timeout, cancelled, adapter_failed, process_lost, agent_not_found,
//   claude_auth_required, gemini_auth_required, openclaw_gateway_*
//
// We also provide guesses for invalid_api_key / rate_limited based on the
// error message text since the adapter surfaces those through adapter_failed.
// -----------------------------------------------------------------------------

export interface RunErrorReason {
  code: string;
  title: string;
  description: string;
  retryable: boolean;
}

export function resolveRunErrorReason(run: AgentRunStatusRun): RunErrorReason {
  const code = (run.errorCode ?? "").toLowerCase();
  const message = (run.error ?? "").toLowerCase();

  if (code === "cancelled" || run.status === "cancelled") {
    return {
      code: "cancelled",
      title: "You cancelled this run.",
      description: "No tokens were charged past the point of cancellation.",
      retryable: true,
    };
  }

  if (code === "timeout" || run.status === "timed_out") {
    return {
      code: "timeout",
      title: "The model took too long.",
      description: "Try again, or break the task into smaller pieces.",
      retryable: true,
    };
  }

  if (
    code === "claude_auth_required" ||
    code === "gemini_auth_required" ||
    message.includes("401") ||
    message.includes("invalid api key") ||
    message.includes("invalid_api_key") ||
    message.includes("authentication")
  ) {
    return {
      code: "invalid_api_key",
      title: "Your Anthropic key was rejected.",
      description: "Check your key in Settings → Providers.",
      retryable: false,
    };
  }

  if (
    message.includes("rate limit") ||
    message.includes("rate_limited") ||
    message.includes("429") ||
    message.includes("too many requests")
  ) {
    return {
      code: "rate_limited",
      title: "Hit Anthropic's rate limit.",
      description: "Retrying in 30s.",
      retryable: true,
    };
  }

  if (code === "process_lost" || code === "adapter_failed" || code === "agent_not_found" || code.startsWith("openclaw_gateway_")) {
    return {
      code: "adapter_crashed",
      title: "Something broke inside the agent runner.",
      description: "Try again; if it keeps happening, send us the run ID.",
      retryable: true,
    };
  }

  return {
    code: "unknown",
    title: "Unknown error.",
    description: `Run ID: ${run.id}. Contact support.`,
    retryable: true,
  };
}

// -----------------------------------------------------------------------------
// Elapsed-time hook — ticks every second while the run is active.
// -----------------------------------------------------------------------------

const HINT_HOLD_SEC = 15;
const CANCEL_HOLD_SEC = 30;

function parseDate(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const ms = typeof value === "string" ? new Date(value).getTime() : value.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

export function useRunElapsedSec(run: AgentRunStatusRun): number {
  const isActive = run.status === "running" || run.status === "queued";
  const startMs = parseDate(run.startedAt);
  const [elapsed, setElapsed] = useState<number>(() => {
    if (!startMs) return 0;
    return Math.max(0, Math.round((Date.now() - startMs) / 1000));
  });

  useEffect(() => {
    if (!isActive || !startMs) return;
    setElapsed(Math.max(0, Math.round((Date.now() - startMs) / 1000)));
    const id = window.setInterval(() => {
      setElapsed(Math.max(0, Math.round((Date.now() - startMs) / 1000)));
    }, 1000);
    return () => window.clearInterval(id);
  }, [isActive, startMs]);

  return elapsed;
}

// -----------------------------------------------------------------------------
// Main component — composes pill + elapsed timer + cancel/retry + error card.
// -----------------------------------------------------------------------------

export function AgentRunStatus({
  run,
  onCancel,
  isCancelling = false,
  onRetry,
  isRetrying = false,
  compact = false,
  className,
}: AgentRunStatusProps) {
  const status = coerceStatus(run.status);
  const isActive = status === "running" || status === "queued";
  const isFailureLike = status === "failed" || status === "timed_out";
  const elapsedSec = useRunElapsedSec(run);

  const showHint = isActive && elapsedSec >= HINT_HOLD_SEC;
  const showCancel = isActive && elapsedSec >= CANCEL_HOLD_SEC && !!onCancel;
  const reason = isFailureLike ? resolveRunErrorReason(run) : null;

  if (compact) {
    return (
      <span className={cn("inline-flex items-center gap-2 text-xs", className)}>
        <RunStatusPill status={status} />
        {isActive && (
          <span className="text-muted-foreground tabular-nums">Running {formatElapsed(elapsedSec)}</span>
        )}
      </span>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <RunStatusPill status={status} />
        {isActive && (
          <span className="text-xs text-muted-foreground tabular-nums">Running {formatElapsed(elapsedSec)}</span>
        )}
        {showCancel && (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive text-xs h-6 px-2"
            onClick={onCancel}
            disabled={isCancelling}
          >
            {isCancelling ? "Cancelling…" : "Cancel"}
          </Button>
        )}
      </div>
      {showHint && (
        <p className="text-xs text-muted-foreground">This may take up to 60 seconds.</p>
      )}
      {reason && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs dark:border-red-900/50 dark:bg-red-950/40">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1 space-y-1 min-w-0">
              <p className="font-medium text-red-900 dark:text-red-100">{reason.title}</p>
              <p className="text-red-800/80 dark:text-red-200/80">{reason.description}</p>
              {run.error && (
                <p className="text-[11px] text-red-700/70 dark:text-red-300/60 break-words">
                  Details: {run.error}
                </p>
              )}
              {reason.retryable && onRetry && (
                <div className="pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={onRetry}
                    disabled={isRetrying}
                  >
                    <RotateCcw className="h-3.5 w-3.5 mr-1" />
                    {isRetrying ? "Retrying…" : "Retry"}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
