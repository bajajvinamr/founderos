/**
 * Inline pill that surfaces runner-liveness for a company. Shown next to
 * the page title when at least one byo_runner agent is configured. Polls
 * `/api/companies/:id/runner-status` every 10 s and renders:
 *
 *   - Green "Runner online (N)"      — at least one token has lastSeenAt < 30 s
 *   - Yellow "Runner stale"          — token(s) exist but none online
 *   - Red   "No runners installed"   — token list is empty
 *
 * The pill itself is a button that opens RunnerInstallDialog for token
 * management (issue / revoke).
 */

import { useQuery } from "@tanstack/react-query";
import { runnerApi, type RunnerTokenSummary } from "@/api/runner";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 10_000;

export type RunnerStatusKind = "online" | "stale" | "missing" | "loading" | "error";

export function classifyRunnerStatus(tokens: RunnerTokenSummary[]): {
  kind: RunnerStatusKind;
  onlineCount: number;
} {
  if (tokens.length === 0) return { kind: "missing", onlineCount: 0 };
  const onlineCount = tokens.filter((t) => t.online).length;
  if (onlineCount > 0) return { kind: "online", onlineCount };
  return { kind: "stale", onlineCount: 0 };
}

export interface RunnerStatusPillProps {
  companyId: string;
  /** Click handler — typically opens the install dialog. */
  onClick?: () => void;
  className?: string;
}

export function RunnerStatusPill({ companyId, onClick, className }: RunnerStatusPillProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["runner-status", companyId],
    queryFn: () => runnerApi.status(companyId),
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    staleTime: POLL_INTERVAL_MS / 2,
  });

  const { kind, onlineCount } = isLoading
    ? { kind: "loading" as const, onlineCount: 0 }
    : isError || !data
      ? { kind: "error" as const, onlineCount: 0 }
      : classifyRunnerStatus(data.tokens);

  const { dotColor, label } = renderForKind(kind, onlineCount);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs font-medium hover:bg-muted transition-colors",
        className,
      )}
      aria-label={label}
      data-testid="runner-status-pill"
    >
      <span
        className={cn("inline-block h-2 w-2 rounded-full", dotColor)}
        data-testid="runner-status-dot"
      />
      <span>{label}</span>
    </button>
  );
}

function renderForKind(kind: RunnerStatusKind, onlineCount: number): { dotColor: string; label: string } {
  switch (kind) {
    case "online":
      return { dotColor: "bg-emerald-500", label: `Runner online${onlineCount > 1 ? ` (${onlineCount})` : ""}` };
    case "stale":
      return { dotColor: "bg-amber-500", label: "Runner stale" };
    case "missing":
      return { dotColor: "bg-rose-500", label: "Install runner" };
    case "error":
      return { dotColor: "bg-rose-500", label: "Runner status unavailable" };
    case "loading":
    default:
      return { dotColor: "bg-muted", label: "Checking runner…" };
  }
}
