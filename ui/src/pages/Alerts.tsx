import { useEffect, useMemo } from "react";
import { Link, useSearchParams } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ShieldCheck, Bot, Activity, Plug, ArrowRight } from "lucide-react";
import { Tabs } from "@/components/ui/tabs";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { PageTabBar } from "../components/PageTabBar";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { agentUrl } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import type { Agent } from "@founderos/shared";

type AlertsTab = "all" | "escalations" | "approvals" | "anomalies" | "integrations";

const VALID_TABS: AlertsTab[] = ["all", "escalations", "approvals", "anomalies", "integrations"];

function isValidTab(v: string | null): v is AlertsTab {
  return VALID_TABS.includes(v as AlertsTab);
}

export function Alerts() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams, setSearchParams] = useSearchParams();

  const rawTab = searchParams.get("tab");
  const activeTab: AlertsTab = isValidTab(rawTab) ? rawTab : "all";

  useEffect(() => {
    setBreadcrumbs([{ label: "Alerts" }]);
  }, [setBreadcrumbs]);

  const { data: agents = [], isLoading: agentsLoading } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: approvals = [] } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!, "pending"),
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
  });

  const escalatedAgents = useMemo(
    () => agents.filter((a) => a.status === "error"),
    [agents],
  );
  const pendingApprovalsCount = approvals.length;
  // S3.2 will populate; S2.7 will populate.
  const kpiAnomalies = 0;
  const integrationFailures = 0;
  const totalAlerts =
    escalatedAgents.length + pendingApprovalsCount + kpiAnomalies + integrationFailures;

  const tabItems = [
    { value: "all", label: totalAlerts > 0 ? `All · ${totalAlerts}` : "All" },
    {
      value: "escalations",
      label:
        escalatedAgents.length > 0
          ? `Escalations · ${escalatedAgents.length}`
          : "Escalations",
    },
    {
      value: "approvals",
      label:
        pendingApprovalsCount > 0
          ? `Approvals · ${pendingApprovalsCount}`
          : "Approvals",
    },
    { value: "anomalies", label: "KPI anomalies" },
    { value: "integrations", label: "Integration failures" },
  ];

  if (!selectedCompanyId) {
    return <EmptyState icon={AlertTriangle} message="Select a company to view alerts." />;
  }

  if (agentsLoading) {
    return <PageSkeleton variant="list" />;
  }

  function setTab(tab: AlertsTab) {
    setSearchParams({ tab });
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-[11px] font-medium tracking-widest text-muted-foreground uppercase">
          Alerts Center
        </p>
        <h1 className="font-display text-3xl tracking-tight text-foreground">
          {totalAlerts === 0
            ? "Nothing on fire."
            : totalAlerts === 1
              ? "1 thing needs your attention"
              : `${totalAlerts} things need your attention`}
        </h1>
      </header>

      <Tabs value={activeTab} onValueChange={(v) => setTab(v as AlertsTab)}>
        <PageTabBar
          align="start"
          items={tabItems}
          value={activeTab}
          onValueChange={(v) => setTab(v as AlertsTab)}
        />
      </Tabs>

      {(activeTab === "all" || activeTab === "escalations") && (
        <EscalationsSection agents={escalatedAgents} />
      )}

      {(activeTab === "all" || activeTab === "approvals") && (
        <ApprovalsSection count={pendingApprovalsCount} />
      )}

      {(activeTab === "all" || activeTab === "anomalies") && (
        <PlaceholderSection
          icon={Activity}
          title="KPI anomalies"
          body="Surfaced automatically when your Chief of Staff detects a KPI moving outside its baseline."
          coming="Activates after S3.2 (KPI anomaly detection job)"
        />
      )}

      {(activeTab === "all" || activeTab === "integrations") && (
        <PlaceholderSection
          icon={Plug}
          title="Integration failures"
          body="Sync errors and webhook drops across Stripe / PostHog / LinkedIn / HubSpot etc."
          coming="Activates after S2.7 (connector health monitor)"
        />
      )}
    </div>
  );
}

function EscalationsSection({ agents }: { agents: Agent[] }) {
  if (agents.length === 0) {
    return (
      <section aria-label="Agent escalations">
        <SectionHeader icon={Bot} title="Agent escalations" />
        <EmptyState icon={Bot} message="All teammates are running cleanly." />
      </section>
    );
  }

  return (
    <section aria-label="Agent escalations">
      <SectionHeader icon={Bot} title="Agent escalations" count={agents.length} />
      <div className="rounded-md border border-border divide-y divide-border overflow-hidden">
        {agents.map((agent) => (
          <Link
            key={agent.id}
            to={agentUrl(agent)}
            className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-accent/30 transition-colors no-underline text-inherit"
          >
            <Bot className="h-4 w-4 text-red-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-medium text-foreground truncate">{agent.name}</p>
              <p className="text-xs text-muted-foreground truncate">
                {agent.role}
                {agent.pauseReason ? ` · ${agent.pauseReason}` : " · in error state"}
              </p>
            </div>
            <span className="text-xs text-muted-foreground tabular-nums shrink-0">
              {timeAgo(agent.updatedAt)}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function ApprovalsSection({ count }: { count: number }) {
  return (
    <section aria-label="Approvals">
      <SectionHeader icon={ShieldCheck} title="Approvals" count={count > 0 ? count : undefined} />
      {count === 0 ? (
        <EmptyState icon={ShieldCheck} message="All caught up. No decisions waiting." />
      ) : (
        <div className="rounded-md border border-border bg-card px-4 py-4">
          <p className="text-sm text-muted-foreground">
            {count} pending approval{count === 1 ? "" : "s"}.
            <Link
              to="/approvals"
              className="ml-2 inline-flex items-center gap-1 text-foreground hover:underline no-underline"
            >
              Open the Decision Inbox
              <ArrowRight className="h-3 w-3" />
            </Link>
          </p>
        </div>
      )}
    </section>
  );
}

function PlaceholderSection({
  icon: Icon,
  title,
  body,
  coming,
}: {
  icon: typeof AlertTriangle;
  title: string;
  body: string;
  coming: string;
}) {
  return (
    <section aria-label={title}>
      <SectionHeader icon={Icon} title={title} />
      <div className="rounded-md border border-dashed border-border bg-card px-4 py-6 space-y-2">
        <p className="text-sm text-muted-foreground">{body}</p>
        <p className="text-xs text-muted-foreground/70 italic">{coming}</p>
      </div>
    </section>
  );
}

function SectionHeader({
  icon: Icon,
  title,
  count,
}: {
  icon: typeof AlertTriangle;
  title: string;
  count?: number;
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon className="h-4 w-4 text-muted-foreground" />
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {typeof count === "number" && count > 0 && (
        <span className="font-mono text-xs text-muted-foreground tabular-nums">{count}</span>
      )}
    </div>
  );
}
