// @vitest-environment node — pure logic is tested in ConnectorHealthGrid.test.tsx
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { queryKeys } from "../lib/queryKeys";
import { integrationHealthApi, type ConnectorHealth, type ConnectorHealthStatus } from "../api/integration-health";
import { timeAgo } from "../lib/timeAgo";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { ConnectorHealth, ConnectorHealthStatus };

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Map a ConnectorHealthStatus to a Tailwind pill colour token. */
export function statusPillClass(status: ConnectorHealthStatus): string {
  switch (status) {
    case "connected":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300";
    case "syncing":
      return "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
    case "failed":
      return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
    case "never_connected":
      return "bg-muted text-muted-foreground";
  }
}

/** Map a ConnectorHealthStatus to a human-readable label. */
export function statusLabel(status: ConnectorHealthStatus): string {
  switch (status) {
    case "connected":       return "Connected";
    case "syncing":         return "Syncing";
    case "failed":          return "Failed";
    case "never_connected": return "Not connected";
  }
}

/** Dot indicator colour class. */
export function dotClass(status: ConnectorHealthStatus): string {
  switch (status) {
    case "connected":       return "bg-emerald-500";
    case "syncing":         return "bg-amber-500 animate-pulse";
    case "failed":          return "bg-red-500";
    case "never_connected": return "bg-muted-foreground/40";
  }
}

// ---------------------------------------------------------------------------
// Source card
// ---------------------------------------------------------------------------

interface SourceCardProps {
  connector: ConnectorHealth;
  onRetry?: (source: string) => void;
}

const SOURCE_LABELS: Record<string, string> = {
  stripe:   "Stripe",
  posthog:  "PostHog",
  linkedin: "LinkedIn",
  notion:   "Notion",
  slack:    "Slack",
  hubspot:  "HubSpot",
};

function SourceCard({ connector, onRetry }: SourceCardProps) {
  const { source, status, lastSync, lastError, retryAvailable } = connector;
  const label = SOURCE_LABELS[source] ?? source;

  return (
    <div
      className="rounded-md border border-border bg-card px-4 py-3 flex flex-col gap-2"
      aria-label={`${label} — ${statusLabel(status)}`}
    >
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn("h-2 w-2 rounded-full shrink-0", dotClass(status))}
            aria-hidden="true"
          />
          <span className="text-sm font-medium text-foreground truncate">{label}</span>
        </div>
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
            statusPillClass(status),
          )}
        >
          {statusLabel(status)}
        </span>
      </div>

      {/* Last sync time */}
      <p className="text-[11px] text-muted-foreground tabular-nums">
        {lastSync
          ? <>Synced {timeAgo(lastSync)}</>
          : <span className="text-muted-foreground/60">Never synced</span>}
      </p>

      {/* Error message */}
      {lastError && status === "failed" && (
        <p className="text-[11px] text-red-600 dark:text-red-400 truncate" title={lastError}>
          {lastError}
        </p>
      )}

      {/* Retry button */}
      {retryAvailable && onRetry && (
        <button
          type="button"
          onClick={() => onRetry(source)}
          className="mt-1 inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors w-fit"
          aria-label={`Retry ${label} connection`}
        >
          <RefreshCw className="h-3 w-3" />
          Retry
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grid component (wired to tanstack-query)
// ---------------------------------------------------------------------------

interface ConnectorHealthGridProps {
  companyId: string;
  /** Called when user clicks Retry on a failed source. Caller handles the reconnect flow. */
  onRetry?: (source: string) => void;
}

export function ConnectorHealthGrid({ companyId, onRetry }: ConnectorHealthGridProps) {
  const { data: connectors = [], isLoading } = useQuery({
    queryKey: queryKeys.integrationHealth.list(companyId),
    queryFn: () => integrationHealthApi.listHealth(companyId),
    enabled: !!companyId,
    staleTime: 30_000, // 30s — health status changes slowly
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="rounded-md border border-border bg-card/50 px-4 py-3 h-[90px] animate-pulse"
            aria-hidden="true"
          />
        ))}
      </div>
    );
  }

  return (
    <section aria-label="Connector health">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Connector Health
        </h3>
        <p className="text-xs text-muted-foreground tabular-nums">
          {connectors.filter((c) => c.status === "connected").length} / {connectors.length} connected
        </p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {connectors.map((connector) => (
          <SourceCard
            key={connector.source}
            connector={connector}
            onRetry={onRetry}
          />
        ))}
      </div>
    </section>
  );
}
