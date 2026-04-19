import { useState, useEffect, useMemo } from "react";
import { Link, useNavigate, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { agentStatusDot, agentStatusDotDefault } from "../lib/status-colors";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { relativeTime, cn, agentRouteRef, agentUrl } from "../lib/utils";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Bot, Plus, List, GitBranch, SlidersHorizontal, LayoutGrid, DollarSign, CornerDownRight, Users, UserPlus } from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent } from "@founderos/shared";

import { getAdapterLabel } from "../adapters/adapter-display-registry";
import { AgentProviderBadge } from "../components/AgentProviderBadge";
import { AgentIcon } from "../components/AgentIconPicker";

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

type FilterTab = "all" | "active" | "paused" | "error";

function matchesFilter(status: string, tab: FilterTab, showTerminated: boolean): boolean {
  if (status === "terminated") return showTerminated;
  if (tab === "all") return true;
  if (tab === "active") return status === "active" || status === "running" || status === "idle";
  if (tab === "paused") return status === "paused";
  if (tab === "error") return status === "error";
  return true;
}

function filterAgents(agents: Agent[], tab: FilterTab, showTerminated: boolean): Agent[] {
  return agents
    .filter((a) => matchesFilter(a.status, tab, showTerminated))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function filterOrgTree(nodes: OrgNode[], tab: FilterTab, showTerminated: boolean): OrgNode[] {
  return nodes
    .reduce<OrgNode[]>((acc, node) => {
      const filteredReports = filterOrgTree(node.reports, tab, showTerminated);
      if (matchesFilter(node.status, tab, showTerminated) || filteredReports.length > 0) {
        acc.push({ ...node, reports: filteredReports });
      }
      return acc;
    }, [])
    .sort((a, b) => a.name.localeCompare(b.name));
}

type ProviderFilter = "all" | "anthropic" | "openai" | "google" | "other";
const PROVIDER_FILTER_KEY = "founderos.agents.providerFilter";

function isValidProviderFilter(v: string | null): v is ProviderFilter {
  return v === "all" || v === "anthropic" || v === "openai" || v === "google" || v === "other";
}

function agentProviderFamily(adapterType: string | null | undefined): ProviderFilter {
  if (!adapterType) return "other";
  if (adapterType === "claude_local" || adapterType === "claude_api") return "anthropic";
  if (adapterType === "codex_local" || adapterType === "openai_api") return "openai";
  if (adapterType === "gemini_local") return "google";
  return "other";
}

/**
 * Prune an org tree to only branches where the leaf agent matches the
 * selected provider. A parent node is kept if it — or any descendant — is
 * a match. Prevents the filter from collapsing manager→report structure
 * when the manager happens to run on a different provider.
 */
function countNonZeroFamilies(counts: Record<ProviderFilter, number>): number {
  let n = 0;
  for (const fam of ["anthropic", "openai", "google", "other"] as const) {
    if (counts[fam] > 0) n++;
  }
  return n;
}

function filterOrgByProvider(
  nodes: OrgNode[],
  family: Exclude<ProviderFilter, "all">,
  agentMap: Map<string, Agent>,
): OrgNode[] {
  return nodes
    .reduce<OrgNode[]>((acc, node) => {
      const descendants = filterOrgByProvider(node.reports ?? [], family, agentMap);
      const agent = agentMap.get(node.id);
      const selfMatches = agent && agentProviderFamily(agent.adapterType) === family;
      if (selfMatches || descendants.length > 0) {
        acc.push({ ...node, reports: descendants });
      }
      return acc;
    }, []);
}

export function Agents() {
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile } = useSidebar();
  const pathSegment = location.pathname.split("/").pop() ?? "all";
  const tab: FilterTab = (pathSegment === "all" || pathSegment === "active" || pathSegment === "paused" || pathSegment === "error") ? pathSegment : "all";
  const [view, setView] = useState<"list" | "org" | "roster">("roster");
  const forceListView = isMobile;
  const effectiveView: "list" | "org" | "roster" = forceListView ? "list" : view;
  const [showTerminated, setShowTerminated] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [providerFilter, setProviderFilterState] = useState<ProviderFilter>(() => {
    try {
      const stored = localStorage.getItem(PROVIDER_FILTER_KEY);
      return isValidProviderFilter(stored) ? stored : "all";
    } catch {
      return "all";
    }
  });
  const setProviderFilter = (v: ProviderFilter) => {
    setProviderFilterState(v);
    try { localStorage.setItem(PROVIDER_FILTER_KEY, v); } catch { /* quota / incognito */ }
  };

  const { data: agents, isLoading, error } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: orgTree } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId && effectiveView === "org",
  });

  const { data: runs } = useQuery({
    queryKey: queryKeys.heartbeats(selectedCompanyId!),
    queryFn: () => heartbeatsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  // Map agentId -> first live run + live run count
  const liveRunByAgent = useMemo(() => {
    const map = new Map<string, { runId: string; liveCount: number }>();
    for (const r of runs ?? []) {
      if (r.status !== "running" && r.status !== "queued") continue;
      const existing = map.get(r.agentId);
      if (existing) {
        existing.liveCount += 1;
        continue;
      }
      map.set(r.agentId, { runId: r.id, liveCount: 1 });
    }
    return map;
  }, [runs]);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Team" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Users} message="Select a company to view your team." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const filteredByStatus = filterAgents(agents ?? [], tab, showTerminated);
  const filtered =
    providerFilter === "all"
      ? filteredByStatus
      : filteredByStatus.filter((a) => agentProviderFamily(a.adapterType) === providerFilter);
  const orgFilteredByStatus = filterOrgTree(orgTree ?? [], tab, showTerminated);
  const filteredOrg =
    providerFilter === "all"
      ? orgFilteredByStatus
      : filterOrgByProvider(orgFilteredByStatus, providerFilter, agentMap);

  // Count agents per provider family for the filter chips.
  const providerCounts = useMemo(() => {
    const counts: Record<ProviderFilter, number> = { all: 0, anthropic: 0, openai: 0, google: 0, other: 0 };
    for (const a of agents ?? []) {
      counts.all++;
      counts[agentProviderFamily(a.adapterType)]++;
    }
    return counts;
  }, [agents]);

  const activeCount = (agents ?? []).filter((a) => a.status === "active" || a.status === "running" || a.status === "idle").length;
  const totalCount = (agents ?? []).filter((a) => a.status !== "terminated").length;

  return (
    <div className="space-y-6">
      {/* Page header — editorial, business-serious. Gives the Team page a
          clear identity instead of jumping straight into tabs + filters. */}
      <header className="flex flex-col gap-1.5 pt-1">
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Your team
        </div>
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <h1 className="font-display text-[32px] md:text-[40px] leading-[1.05] tracking-tight text-foreground">
            {totalCount === 0
              ? "No teammates yet"
              : `${totalCount} ${totalCount === 1 ? "teammate" : "teammates"} on the roster`}
          </h1>
          {totalCount > 0 && (
            <span className="text-[12px] text-muted-foreground tabular-nums">
              {activeCount} ready · {totalCount - activeCount} off
            </span>
          )}
        </div>
      </header>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={tab} onValueChange={(v) => navigate(`/agents/${v}`)}>
          <PageTabBar
            items={[
              { value: "all", label: "All" },
              { value: "active", label: "Active" },
              { value: "paused", label: "Paused" },
              { value: "error", label: "Error" },
            ]}
            value={tab}
            onValueChange={(v) => navigate(`/agents/${v}`)}
          />
        </Tabs>
        <div className="flex items-center gap-2">
          {/* Filters */}
          <div className="relative">
            <button
              className={cn(
                "flex items-center gap-1.5 px-2 py-1.5 text-xs transition-colors border border-border",
                filtersOpen || showTerminated ? "text-foreground bg-accent" : "text-muted-foreground hover:bg-accent/50"
              )}
              onClick={() => setFiltersOpen(!filtersOpen)}
            >
              <SlidersHorizontal className="h-3 w-3" />
              Filters
              {showTerminated && <span className="ml-0.5 px-1 bg-foreground/10 rounded text-[10px]">1</span>}
            </button>
            {filtersOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 w-48 border border-border bg-popover shadow-md p-1">
                <button
                  className="flex items-center gap-2 w-full px-2 py-1.5 text-xs text-left hover:bg-accent/50 transition-colors"
                  onClick={() => setShowTerminated(!showTerminated)}
                >
                  <span className={cn(
                    "flex items-center justify-center h-3.5 w-3.5 border border-border rounded-sm",
                    showTerminated && "bg-foreground"
                  )}>
                    {showTerminated && <span className="text-background text-[10px] leading-none">&#10003;</span>}
                  </span>
                  Show terminated
                </button>
              </div>
            )}
          </div>
          {/* View toggle */}
          {!forceListView && (
            <div className="flex items-center border border-border">
              <button
                aria-label="Roster view"
                title="Roster"
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "roster" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => setView("roster")}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </button>
              <button
                aria-label="List view"
                title="List"
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "list" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => setView("list")}
              >
                <List className="h-3.5 w-3.5" />
              </button>
              <button
                aria-label="Org chart view"
                title="Org chart"
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "org" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => setView("org")}
              >
                <GitBranch className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <Button size="sm" variant="outline" onClick={openNewAgent}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Hire teammate
          </Button>
        </div>
      </div>

      {/* Provider-family chip row — only when multiple families are in play */}
      {(agents?.length ?? 0) > 0 && countNonZeroFamilies(providerCounts) > 1 && (
        <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
          <span className="text-muted-foreground">Provider:</span>
          {(["all", "anthropic", "openai", "google", "other"] as ProviderFilter[]).map((fam) => {
            const count = providerCounts[fam];
            if (fam !== "all" && count === 0) return null;
            const active = providerFilter === fam;
            const label = fam === "all" ? "All" : fam === "anthropic" ? "Claude" : fam === "openai" ? "OpenAI" : fam === "google" ? "Gemini" : "Other";
            return (
              <button
                key={fam}
                type="button"
                onClick={() => setProviderFilter(fam)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 transition-colors",
                  active
                    ? "border-[var(--brand)] bg-[color:color-mix(in_oklch,var(--brand)_10%,transparent)] text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground hover:border-[color:color-mix(in_oklch,var(--brand)_40%,var(--border))]",
                )}
              >
                <span>{label}</span>
                <span className="tabular-nums text-muted-foreground">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {filtered.length > 0 && (
        <p className="text-xs text-muted-foreground">{filtered.length} {filtered.length !== 1 ? "teammates" : "teammate"}</p>
      )}

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {agents && agents.length === 0 && (
        <EmptyState
          icon={UserPlus}
          message="Hire your first teammate to get started."
          action="Hire teammate"
          onAction={openNewAgent}
        />
      )}

      {/* Roster view — team-card grid */}
      {effectiveView === "roster" && filtered.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((agent) => {
            const liveRun = liveRunByAgent.get(agent.id);
            const reportsTo = agent.reportsTo
              ? agentMap.get(agent.reportsTo)?.name ?? null
              : null;
            return (
              <TeammateCard
                key={agent.id}
                agent={agent}
                reportsTo={reportsTo}
                liveRun={liveRun ?? null}
                roleLabel={roleLabels[agent.role] ?? agent.role}
              />
            );
          })}
        </div>
      )}
      {effectiveView === "roster" && agents && agents.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No teammates match the selected filter.
        </p>
      )}

      {/* List view */}
      {effectiveView === "list" && filtered.length > 0 && (
        <div className="border border-border">
          {filtered.map((agent) => {
            return (
              <EntityRow
                key={agent.id}
                title={agent.name}
                subtitle={`${roleLabels[agent.role] ?? agent.role}${agent.title ? ` - ${agent.title}` : ""}`}
                to={agentUrl(agent)}
                className={agent.pausedAt && tab !== "paused" ? "opacity-50" : ""}
                leading={
                  <span className="relative flex h-2.5 w-2.5">
                    <span
                      className={`absolute inline-flex h-full w-full rounded-full ${agentStatusDot[agent.status] ?? agentStatusDotDefault}`}
                    />
                  </span>
                }
                trailing={
                  <div className="flex items-center gap-3">
                    <span className="sm:hidden">
                      {liveRunByAgent.has(agent.id) ? (
                        <LiveRunIndicator
                          agentRef={agentRouteRef(agent)}
                          runId={liveRunByAgent.get(agent.id)!.runId}
                          liveCount={liveRunByAgent.get(agent.id)!.liveCount}
                        />
                      ) : (
                        <StatusBadge status={agent.status} />
                      )}
                    </span>
                    <div className="hidden sm:flex items-center gap-3">
                      {liveRunByAgent.has(agent.id) && (
                        <LiveRunIndicator
                          agentRef={agentRouteRef(agent)}
                          runId={liveRunByAgent.get(agent.id)!.runId}
                          liveCount={liveRunByAgent.get(agent.id)!.liveCount}
                        />
                      )}
                      <AgentProviderBadge
                        adapterType={agent.adapterType}
                        model={
                          typeof (agent.adapterConfig as Record<string, unknown> | undefined)?.model === "string"
                            ? ((agent.adapterConfig as Record<string, unknown>).model as string)
                            : null
                        }
                      />
                      <span className="text-xs text-muted-foreground w-16 text-right">
                        {agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "—"}
                      </span>
                      <span className="w-20 flex justify-end">
                        <StatusBadge status={agent.status} />
                      </span>
                    </div>
                  </div>
                }
              />
            );
          })}
        </div>
      )}

      {effectiveView === "list" && agents && agents.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No teammates match the selected filter.
        </p>
      )}

      {/* Org chart view */}
      {effectiveView === "org" && filteredOrg.length > 0 && (
        <div className="border border-border py-1">
          {filteredOrg.map((node) => (
            <OrgTreeNode key={node.id} node={node} depth={0} agentMap={agentMap} liveRunByAgent={liveRunByAgent} tab={tab} />
          ))}
        </div>
      )}

      {effectiveView === "org" && orgTree && orgTree.length > 0 && filteredOrg.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No teammates match the selected filter.
        </p>
      )}

      {effectiveView === "org" && orgTree && orgTree.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No organizational hierarchy defined.
        </p>
      )}
    </div>
  );
}

function OrgTreeNode({
  node,
  depth,
  agentMap,
  liveRunByAgent,
  tab,
}: {
  node: OrgNode;
  depth: number;
  agentMap: Map<string, Agent>;
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
  tab: FilterTab;
}) {
  const agent = agentMap.get(node.id);

  const statusColor = agentStatusDot[node.status] ?? agentStatusDotDefault;

  return (
    <div style={{ paddingLeft: depth * 24 }}>
      <Link
        to={agent ? agentUrl(agent) : `/agents/${node.id}`}
        className={cn("flex items-center gap-3 px-3 py-2 hover:bg-accent/30 transition-colors w-full text-left no-underline text-inherit", agent?.pausedAt && tab !== "paused" && "opacity-50")}
      >
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className={`absolute inline-flex h-full w-full rounded-full ${statusColor}`} />
        </span>
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium">{node.name}</span>
          <span className="text-xs text-muted-foreground ml-2">
            {roleLabels[node.role] ?? node.role}
            {agent?.title ? ` - ${agent.title}` : ""}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="sm:hidden">
            {liveRunByAgent.has(node.id) ? (
              <LiveRunIndicator
                agentRef={agent ? agentRouteRef(agent) : node.id}
                runId={liveRunByAgent.get(node.id)!.runId}
                liveCount={liveRunByAgent.get(node.id)!.liveCount}
              />
            ) : (
              <StatusBadge status={node.status} />
            )}
          </span>
          <div className="hidden sm:flex items-center gap-3">
            {liveRunByAgent.has(node.id) && (
              <LiveRunIndicator
                agentRef={agent ? agentRouteRef(agent) : node.id}
                runId={liveRunByAgent.get(node.id)!.runId}
                liveCount={liveRunByAgent.get(node.id)!.liveCount}
              />
            )}
            {agent && (
              <>
                <AgentProviderBadge
                  adapterType={agent.adapterType}
                  model={
                    typeof (agent.adapterConfig as Record<string, unknown> | undefined)?.model === "string"
                      ? ((agent.adapterConfig as Record<string, unknown>).model as string)
                      : null
                  }
                />
                <span className="text-xs text-muted-foreground w-16 text-right">
                  {agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "—"}
                </span>
              </>
            )}
            <span className="w-20 flex justify-end">
              <StatusBadge status={node.status} />
            </span>
          </div>
        </div>
      </Link>
      {node.reports && node.reports.length > 0 && (
        <div className="border-l border-border/50 ml-4">
          {node.reports.map((child) => (
            <OrgTreeNode key={child.id} node={child} depth={depth + 1} agentMap={agentMap} liveRunByAgent={liveRunByAgent} tab={tab} />
          ))}
        </div>
      )}
    </div>
  );
}

function LiveRunIndicator({
  agentRef,
  runId,
  liveCount,
}: {
  agentRef: string;
  runId: string;
  liveCount: number;
}) {
  return (
    <Link
      to={`/agents/${agentRef}/runs/${runId}`}
      className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/10 hover:bg-blue-500/20 transition-colors no-underline"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="relative flex h-2 w-2">
        <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
      </span>
      <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">
        Working{liveCount > 1 ? ` · ${liveCount}` : ""}
      </span>
    </Link>
  );
}

/**
 * Roster-view card — each teammate as a hire-style card rather than a
 * data-table row. Shows avatar, name, title/role, live-work indicator,
 * who they report to, provider, and monthly comp.
 *
 * The goal is to make the founder feel like they're looking at an actual
 * team roster instead of a list of "agents". All copy is employee-style
 * (Working now / Paused / Out-of-budget) and the salary chip makes the
 * budget feel concrete.
 */
function TeammateCard({
  agent,
  reportsTo,
  liveRun,
  roleLabel,
}: {
  agent: Agent;
  reportsTo: string | null;
  liveRun: { runId: string; liveCount: number } | null;
  roleLabel: string;
}) {
  const isPaused = agent.pausedAt != null;
  const statusLabel =
    liveRun != null
      ? "Working"
      : agent.status === "error"
        ? "Blocked"
        : agent.status === "paused" || isPaused
          ? "Paused"
          : agent.status === "terminated"
            ? "Off-boarded"
            : "Ready";
  // Small colored dot + short label — reads as a database cell, not a
  // loud status chip. Matches the restrained Notion/Coda tone.
  const dotClass =
    liveRun != null
      ? "bg-blue-500"
      : agent.status === "error"
        ? "bg-red-500"
        : agent.status === "paused" || isPaused
          ? "bg-amber-500"
          : agent.status === "terminated"
            ? "bg-muted-foreground/50"
            : "bg-emerald-500";

  const adapterModel =
    typeof (agent.adapterConfig as Record<string, unknown> | undefined)?.model === "string"
      ? ((agent.adapterConfig as Record<string, unknown>).model as string)
      : null;

  return (
    <Link
      to={agentUrl(agent)}
      className={cn(
        "group flex flex-col rounded-lg border bg-card p-5 no-underline transition-all",
        "border-border hover:border-foreground/25 hover:shadow-[0_1px_3px_rgba(0,0,0,0.04),0_4px_8px_rgba(0,0,0,0.04)]",
        isPaused && "opacity-70",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted">
          <AgentIcon icon={agent.icon} className="h-4 w-4 text-foreground/80" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="truncate text-[14px] font-semibold text-foreground tracking-tight">{agent.name}</div>
          <div className="text-[12px] text-muted-foreground truncate mt-0.5">
            {agent.title || roleLabel}
          </div>
          {reportsTo && (
            <div className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
              <CornerDownRight className="h-3 w-3" />
              <span className="truncate">{reportsTo}</span>
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className={cn("inline-block h-1.5 w-1.5 rounded-full", dotClass)} />
        <span className="font-medium text-foreground/80">{statusLabel}</span>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 pt-3 border-t border-border/60">
        <AgentProviderBadge adapterType={agent.adapterType} model={adapterModel} />
        <span className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground tabular-nums">
          <DollarSign className="h-3 w-3" />
          {Math.round((agent.budgetMonthlyCents ?? 0) / 100)}/mo
        </span>
      </div>

      <BudgetBar
        spentCents={agent.spentMonthlyCents ?? 0}
        budgetCents={agent.budgetMonthlyCents ?? 0}
      />
    </Link>
  );
}

/**
 * Compact monthly-budget utilization bar for the roster view. Surfaces
 * how much of each teammate's comp has been spent this month so founders
 * see salary burn without drilling into the cost pages. Hidden when
 * budget is unlimited (0 == no cap).
 */
function BudgetBar({ spentCents, budgetCents }: { spentCents: number; budgetCents: number }) {
  if (budgetCents <= 0) return null;
  const pct = Math.min(100, Math.round((spentCents / budgetCents) * 100));
  const overBudget = spentCents > budgetCents;
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground tabular-nums mb-1.5">
        <span>${(spentCents / 100).toFixed(0)} spent</span>
        <span>{pct}%</span>
      </div>
      <div className="h-[3px] rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            overBudget ? "bg-red-500" : pct >= 85 ? "bg-amber-500" : "bg-foreground/70",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
