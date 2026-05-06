import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  GitCommit,
  Lightbulb,
  CheckCircle2,
  Activity,
  Workflow as WorkflowIcon,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useState } from "react";
import { auditLineageApi, type LineageExpansion } from "../api/audit-lineage";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

/**
 * Lineage trace (S6.3) — collapsible viewer for a single activity_log
 * row's full upstream provenance.
 *
 * Renders the chain as: events → insights → approval(s) → action.
 * Each section is empty-state-friendly: when a layer has no entries,
 * it's hidden rather than showing a forced "no data" placeholder. A
 * row with no lineage at all (pre-S6 or missing lineage_refs) collapses
 * to just the action's own entry.
 *
 * Usage:
 *   <LineageTrace logId={auditEntry.id} />
 *
 * Mounts as an expandable disclosure inside a parent audit list — the
 * outer list provides the title + actor; this component fills in the
 * "trace" affordance underneath.
 */
export function LineageTrace({ logId }: { logId: string }) {
  const [open, setOpen] = useState(false);

  const expandQuery = useQuery({
    queryKey: queryKeys.auditLineage.expand(logId),
    queryFn: () => auditLineageApi.expand(logId),
    enabled: open, // lazy — don't fetch until user opens
  });

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
      >
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        {open ? "Hide trace" : "Show trace"}
      </button>

      {open && (
        <div className="mt-2 pl-4 border-l border-border">
          {expandQuery.isLoading && (
            <p className="text-[11px] text-muted-foreground">Loading…</p>
          )}
          {expandQuery.error && (
            <p className="text-[11px] text-destructive">
              Failed to load:{" "}
              {expandQuery.error instanceof Error
                ? expandQuery.error.message
                : "unknown error"}
            </p>
          )}
          {expandQuery.data && <LineageBody data={expandQuery.data} />}
        </div>
      )}
    </div>
  );
}

function LineageBody({ data }: { data: LineageExpansion }) {
  const isEmpty =
    data.events.length === 0 &&
    data.insights.length === 0 &&
    data.approvals.length === 0 &&
    !data.workflow &&
    !data.workflowRun;

  if (isEmpty) {
    return (
      <p className="text-[11px] text-muted-foreground py-1">
        No upstream lineage captured for this entry.
      </p>
    );
  }

  return (
    <div className="space-y-2 py-1">
      {data.events.length > 0 && (
        <Layer
          icon={<Activity className="size-3" />}
          label="Triggering events"
          count={data.events.length}
        >
          {data.events.map((e) => (
            <Row key={e.id} primary={e.eventName} secondary={`${e.source} · ${formatTs(e.occurredAt)}`} />
          ))}
        </Layer>
      )}

      {data.insights.length > 0 && (
        <>
          {data.events.length > 0 && <Connector />}
          <Layer
            icon={<Lightbulb className="size-3" />}
            label="Insights"
            count={data.insights.length}
          >
            {data.insights.map((ins) => (
              <Row
                key={ins.id}
                primary={ins.title}
                secondary={`${ins.department} · ${ins.kind} · confidence ${(ins.confidence * 100).toFixed(0)}%`}
              />
            ))}
          </Layer>
        </>
      )}

      {data.approvals.length > 0 && (
        <>
          {(data.events.length > 0 || data.insights.length > 0) && <Connector />}
          <Layer
            icon={<CheckCircle2 className="size-3" />}
            label="Approvals"
            count={data.approvals.length}
          >
            {data.approvals.map((a) => (
              <Row
                key={a.id}
                primary={a.type}
                secondary={`${a.status}${a.decidedAt ? " · " + formatTs(a.decidedAt) : ""}`}
              />
            ))}
          </Layer>
        </>
      )}

      {data.workflow && (
        <>
          {(data.events.length > 0 || data.insights.length > 0 || data.approvals.length > 0) && (
            <Connector />
          )}
          <Layer
            icon={<WorkflowIcon className="size-3" />}
            label="Workflow"
            count={1}
          >
            <Row
              primary={data.workflow.name}
              secondary={`${data.workflow.template} · L${data.workflow.autonomyLevel}`}
            />
          </Layer>
        </>
      )}

      <Connector />
      <Layer icon={<GitCommit className="size-3" />} label="Action" count={1}>
        <Row
          primary={data.log.action}
          secondary={`${data.log.actorType} · ${formatTs(data.log.createdAt)}`}
        />
      </Layer>
    </div>
  );
}

function Layer({
  icon,
  label,
  count,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        {icon}
        <span>
          {label}
          <span className="ml-1 tabular-nums">({count})</span>
        </span>
      </div>
      <div className="mt-1 space-y-0.5">{children}</div>
    </div>
  );
}

function Row({ primary, secondary }: { primary: string; secondary: string }) {
  return (
    <div className="text-[12px] flex items-baseline gap-2">
      <span className="font-medium text-foreground truncate">{primary}</span>
      <span className="text-[11px] text-muted-foreground tabular-nums truncate">
        {secondary}
      </span>
    </div>
  );
}

function Connector() {
  return (
    <div className="flex items-center gap-1 pl-1 text-muted-foreground/50">
      <ArrowRight className={cn("size-3 rotate-90")} />
    </div>
  );
}

function formatTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
