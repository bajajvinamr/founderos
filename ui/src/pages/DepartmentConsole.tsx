import { useEffect, useMemo } from "react";
import { useParams, useSearchParams, useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { Gauge, GitBranch, AlertTriangle, UserPlus } from "lucide-react";
import { Tabs } from "@/components/ui/tabs";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { DEPARTMENTS, getDepartmentById, agentsInDepartment } from "../lib/departments";
import { PageTabBar } from "../components/PageTabBar";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentIcon } from "../components/AgentIconPicker";
import { AgentProviderBadge } from "../components/AgentProviderBadge";
import { agentUrl, cn } from "../lib/utils";
import { Link } from "@/lib/router";
import { AGENT_ROLE_LABELS } from "@founderos/shared";
import type { Agent } from "@founderos/shared";

type DepartmentTab = "team" | "kpis" | "workflows" | "decisions";

const VALID_TABS: DepartmentTab[] = ["team", "kpis", "workflows", "decisions"];

function isValidTab(v: string | null): v is DepartmentTab {
  return VALID_TABS.includes(v as DepartmentTab);
}

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

export function DepartmentConsole() {
  const { departmentId } = useParams<{ departmentId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();

  const rawTab = searchParams.get("tab");
  const activeTab: DepartmentTab = isValidTab(rawTab) ? rawTab : "team";

  const department = departmentId ? getDepartmentById(departmentId) : undefined;

  useEffect(() => {
    if (department) {
      setBreadcrumbs([{ label: "Departments" }, { label: department.label }]);
    } else {
      setBreadcrumbs([{ label: "Departments" }]);
    }
  }, [department, setBreadcrumbs]);

  const { data: agents, isLoading: agentsLoading } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: approvals } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!, "pending"),
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
  });

  const deptAgents = useMemo(() => {
    if (!department || !agents) return [];
    return agentsInDepartment(department.id, agents);
  }, [department, agents, departmentId]);

  const pendingDecisionCount = useMemo(() => {
    if (!approvals || !department || !agents) return 0;
    const deptAgentIds = new Set(deptAgents.map((a) => a.id));
    return approvals.filter(
      (ap) => ap.status === "pending" && ap.requestedByAgentId != null && deptAgentIds.has(ap.requestedByAgentId),
    ).length;
  }, [approvals, deptAgents, agents, department]);

  if (!department) {
    return (
      <EmptyState
        icon={AlertTriangle}
        message="Department not found."
      />
    );
  }

  if (agentsLoading) {
    return <PageSkeleton variant="list" />;
  }

  const DeptIcon = department.icon;

  function setTab(tab: DepartmentTab) {
    setSearchParams({ tab });
  }

  const tabItems = [
    { value: "team", label: `Team${deptAgents.length > 0 ? ` · ${deptAgents.length}` : ""}` },
    { value: "kpis", label: "KPIs" },
    { value: "workflows", label: "Workflows" },
    {
      value: "decisions",
      label: pendingDecisionCount > 0 ? `Decisions · ${pendingDecisionCount}` : "Decisions",
    },
  ];

  return (
    <div className="space-y-6">
      {/* Editorial page header */}
      <header className="flex flex-col gap-1.5 pt-1">
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          <DeptIcon className="h-3.5 w-3.5" />
          <span>Departments</span>
        </div>
        <h1 className="font-display text-[32px] md:text-[40px] leading-[1.05] tracking-tight text-foreground">
          {department.label}
        </h1>
        <p className="text-sm text-muted-foreground">{department.sublabel}</p>
      </header>

      {/* Tab bar */}
      <Tabs value={activeTab} onValueChange={(v) => setTab(v as DepartmentTab)}>
        <PageTabBar
          items={tabItems}
          value={activeTab}
          onValueChange={(v) => setTab(v as DepartmentTab)}
          align="start"
        />
      </Tabs>

      {/* Tab content */}
      {activeTab === "team" && (
        <TeamTab agents={deptAgents} departmentLabel={department.label} />
      )}
      {activeTab === "kpis" && <KpisTab />}
      {activeTab === "workflows" && <WorkflowsTab />}
      {activeTab === "decisions" && <DecisionsTab />}
    </div>
  );
}

function TeamTab({ agents, departmentLabel }: { agents: Agent[]; departmentLabel: string }) {
  if (agents.length === 0) {
    return (
      <EmptyState
        icon={UserPlus}
        message={`No teammates in ${departmentLabel} yet. Hire one.`}
        action="Hire teammate"
        onAction={() => {
          window.location.href = "/agents/new";
        }}
      />
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {agents.map((agent) => (
        <DepartmentAgentCard key={agent.id} agent={agent} />
      ))}
    </div>
  );
}

function DepartmentAgentCard({ agent }: { agent: Agent }) {
  const isPaused = agent.pausedAt != null;
  const statusLabel =
    agent.status === "error"
      ? "Blocked"
      : agent.status === "paused" || isPaused
        ? "Paused"
        : agent.status === "terminated"
          ? "Off-boarded"
          : "Ready";

  const dotClass =
    agent.status === "error"
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
          <div className="truncate text-[14px] font-semibold text-foreground tracking-tight">
            {agent.name}
          </div>
          <div className="text-[12px] text-muted-foreground truncate mt-0.5">
            {agent.title || roleLabels[agent.role] || agent.role}
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className={cn("inline-block h-1.5 w-1.5 rounded-full", dotClass)} />
        <span className="font-medium text-foreground/80">{statusLabel}</span>
      </div>

      <div className="mt-3 flex items-center justify-end pt-3 border-t border-border/60">
        <AgentProviderBadge adapterType={agent.adapterType} model={adapterModel} />
      </div>
    </Link>
  );
}

function PlaceholderTab({
  icon: Icon,
  message,
}: {
  icon: React.ElementType;
  message: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center gap-4">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border">
        <Icon className="h-5 w-5 text-muted-foreground/70" />
      </div>
      <p className="text-sm text-muted-foreground max-w-sm">{message}</p>
    </div>
  );
}

function KpisTab() {
  return (
    <PlaceholderTab
      icon={Gauge}
      message="Coming soon — department KPIs wired to integrations."
    />
  );
}

function WorkflowsTab() {
  return (
    <PlaceholderTab
      icon={GitBranch}
      message="Coming soon — filtered issues/routines scoped to this department."
    />
  );
}

function DecisionsTab() {
  return (
    <PlaceholderTab
      icon={AlertTriangle}
      message="Coming soon — approvals queued for this department."
    />
  );
}
