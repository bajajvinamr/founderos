import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "@/lib/router";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatActivityVerb } from "../lib/activity-format";
import { timeAgo } from "../lib/timeAgo";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { History, Bot, User, Cpu, ChevronDown, ChevronRight } from "lucide-react";
import type { ActivityEvent, Agent } from "@founderos/shared";
import { LineageTrace } from "../components/LineageTrace";

// ─── Helpers ─────────────────────────────────────────────────────────────────

type DateRange = "24h" | "7d" | "30d" | "all";
type ActorTypeFilter = "all" | "user" | "agent" | "system";

function cutoffForRange(range: DateRange): Date | null {
  const now = new Date();
  if (range === "24h") return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (range === "7d") return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (range === "30d") return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  return null;
}

function formatAbsoluteDate(date: Date | string): string {
  return new Date(date).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function detailsPreview(details: Record<string, unknown> | null): string {
  if (!details) return "—";
  const json = JSON.stringify(details);
  return json.length > 80 ? json.slice(0, 80) + "…" : json;
}

function buildCsv(events: ActivityEvent[], agentMap: Map<string, Agent>): string {
  const header = ["timestamp", "actor_type", "actor_name", "action", "entity_type", "entity_id", "details"];
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const rows = events.map((e) => {
    const actorName = resolveActorName(e, agentMap);
    return [
      formatAbsoluteDate(e.createdAt),
      e.actorType,
      actorName,
      e.action,
      e.entityType,
      e.entityId,
      e.details ? JSON.stringify(e.details) : "",
    ].map(escape).join(",");
  });
  return [header.join(","), ...rows].join("\n");
}

function resolveActorName(event: ActivityEvent, agentMap: Map<string, Agent>): string {
  if (event.actorType === "agent") {
    return agentMap.get(event.actorId)?.name ?? agentMap.get(event.agentId ?? "")?.name ?? event.actorId.slice(0, 8);
  }
  if (event.actorType === "system") return "System";
  return "You";
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ActorPill({ actorType }: { actorType: "agent" | "user" | "system" }) {
  if (actorType === "agent") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
        <Bot className="h-2.5 w-2.5" />
        agent
      </span>
    );
  }
  if (actorType === "system") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
        <Cpu className="h-2.5 w-2.5" />
        system
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-teal-100 px-1.5 py-0.5 text-[10px] font-medium text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">
      <User className="h-2.5 w-2.5" />
      user
    </span>
  );
}

interface EventRowProps {
  event: ActivityEvent;
  agentMap: Map<string, Agent>;
}

function EventRow({ event, agentMap }: EventRowProps) {
  const [expanded, setExpanded] = useState(false);
  const actorName = resolveActorName(event, agentMap);
  const verb = formatActivityVerb(event.action, event.details, { agentMap });

  return (
    <>
      <tr
        className="border-b border-border hover:bg-accent/30 cursor-pointer transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <td className="py-2 px-3 font-mono text-[12px] text-muted-foreground tabular-nums whitespace-nowrap" title={formatAbsoluteDate(event.createdAt)}>
          <span className="flex items-center gap-1">
            {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
            {timeAgo(event.createdAt)}
          </span>
        </td>
        <td className="py-2 px-3 text-[13px]">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-foreground">{actorName}</span>
            <ActorPill actorType={event.actorType} />
          </div>
        </td>
        <td className="py-2 px-3 text-[13px] text-foreground">{verb}</td>
        <td className="py-2 px-3 font-mono text-[12px] text-muted-foreground whitespace-nowrap">
          {event.entityType
            ? <>{event.entityType} · {shortId(event.entityId)}</>
            : "—"}
        </td>
        <td className="py-2 px-3 font-mono text-[12px] text-muted-foreground max-w-[200px] truncate">
          {detailsPreview(event.details)}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border bg-muted/20">
          <td colSpan={5} className="px-4 py-3 space-y-3">
            <pre className="text-[11px] font-mono text-muted-foreground whitespace-pre-wrap break-all">
              {event.details ? JSON.stringify(event.details, null, 2) : "No details."}
            </pre>
            <LineageTrace logId={event.id} />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function AuditLog() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams, setSearchParams] = useSearchParams();

  const actionFilter = searchParams.get("action") ?? "all";
  const actorFilter = (searchParams.get("actor") ?? "all") as ActorTypeFilter;
  const rangeFilter = (searchParams.get("range") ?? "7d") as DateRange;
  const searchQuery = searchParams.get("q") ?? "";

  function setParam(key: string, value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set(key, value);
      return next;
    });
  }

  useEffect(() => {
    setBreadcrumbs([{ label: "Audit" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.activity(selectedCompanyId!),
    queryFn: () => activityApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  void session; // available for future actor name enrichment

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  // Distinct action values for the dropdown
  const distinctActions = useMemo(() => {
    if (!data) return [] as string[];
    return [...new Set(data.map((e) => e.action))].sort();
  }, [data]);

  // Apply all four filters client-side
  const filtered = useMemo(() => {
    if (!data) return [] as ActivityEvent[];
    const cutoff = cutoffForRange(rangeFilter);
    return data.filter((e) => {
      if (actionFilter !== "all" && e.action !== actionFilter) return false;
      if (actorFilter !== "all" && e.actorType !== actorFilter) return false;
      if (cutoff && new Date(e.createdAt) < cutoff) return false;
      if (searchQuery) {
        const actorName = resolveActorName(e, agentMap).toLowerCase();
        const q = searchQuery.toLowerCase();
        if (
          !e.action.toLowerCase().includes(q) &&
          !actorName.includes(q) &&
          !e.entityType.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [data, actionFilter, actorFilter, rangeFilter, searchQuery, agentMap]);

  // Header count: events in selected range (before action/actor/search filters)
  const rangeCount = useMemo(() => {
    if (!data) return 0;
    const cutoff = cutoffForRange(rangeFilter);
    return cutoff ? data.filter((e) => new Date(e.createdAt) >= cutoff).length : data.length;
  }, [data, rangeFilter]);

  const rangeLabel: Record<DateRange, string> = {
    "24h": "the last 24 hours",
    "7d": "the last 7 days",
    "30d": "the last 30 days",
    "all": "all time",
  };

  function downloadCsv() {
    const csv = buildCsv(filtered, agentMap);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={History} message="Select a company to view the audit log." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <p className="text-[10px] font-semibold tracking-widest uppercase text-muted-foreground mb-1">
          Audit Log
        </p>
        <h1 className="font-display text-3xl tracking-tight text-foreground">
          {rangeCount} event{rangeCount !== 1 ? "s" : ""} in {rangeLabel[rangeFilter]}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every approval, every shift, every spend, every agent action.
        </p>
      </div>

      {/* Filter toolbar */}
      <div className="sticky top-0 z-10 bg-background border-y border-border py-2 flex flex-wrap items-center gap-2">
        {/* Action */}
        <Select value={actionFilter} onValueChange={(v) => setParam("action", v)}>
          <SelectTrigger className="h-8 text-xs w-[180px]">
            <SelectValue placeholder="All actions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            {distinctActions.map((a) => (
              <SelectItem key={a} value={a}>{a}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Actor type */}
        <Select value={actorFilter} onValueChange={(v) => setParam("actor", v)}>
          <SelectTrigger className="h-8 text-xs w-[140px]">
            <SelectValue placeholder="All actors" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actors</SelectItem>
            <SelectItem value="user">User</SelectItem>
            <SelectItem value="agent">Agent</SelectItem>
            <SelectItem value="system">System</SelectItem>
          </SelectContent>
        </Select>

        {/* Date range */}
        <Select value={rangeFilter} onValueChange={(v) => setParam("range", v)}>
          <SelectTrigger className="h-8 text-xs w-[130px]">
            <SelectValue placeholder="Last 7d" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="24h">Last 24h</SelectItem>
            <SelectItem value="7d">Last 7d</SelectItem>
            <SelectItem value="30d">Last 30d</SelectItem>
            <SelectItem value="all">All time</SelectItem>
          </SelectContent>
        </Select>

        {/* Search */}
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setParam("q", e.target.value)}
          placeholder="Search events…"
          className="h-8 rounded-md border border-input bg-background px-3 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring w-[200px]"
        />

        <div className="ml-auto">
          <Button variant="outline" size="sm" onClick={downloadCsv}>
            Export CSV
          </Button>
        </div>
      </div>

      {/* Event table */}
      {filtered.length === 0 ? (
        <EmptyState icon={History} message="No events match this filter." />
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="py-2 px-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                  Time
                </th>
                <th className="py-2 px-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                  Actor
                </th>
                <th className="py-2 px-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                  Action
                </th>
                <th className="py-2 px-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                  Entity
                </th>
                <th className="py-2 px-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                  Details
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((event) => (
                <EventRow key={event.id} event={event} agentMap={agentMap} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
