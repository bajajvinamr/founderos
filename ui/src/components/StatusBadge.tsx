import { cn } from "../lib/utils";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";

/**
 * Friendly employee-style labels for raw agent status values. Keeps the
 * underlying state model unchanged — only the presentation moves from
 * machine-ish ("running", "idle") to people-ish ("Working", "Ready").
 */
const STATUS_LABEL: Record<string, string> = {
  active: "Ready",
  idle: "Ready",
  running: "Working",
  paused: "Paused",
  error: "Blocked",
  terminated: "Off-boarded",
};

function friendlyStatus(status: string): string {
  return STATUS_LABEL[status] ?? status.replace("_", " ");
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        statusBadge[status] ?? statusBadgeDefault
      )}
    >
      {friendlyStatus(status)}
    </span>
  );
}
