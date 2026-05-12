import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { authApi } from "../api/auth";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { MetricCard } from "../components/MetricCard";
import { EmptyState } from "../components/EmptyState";
import { OnboardingWizardNew } from "../components/OnboardingWizardNew";
import { CompanyPulseWidget } from "../components/CompanyPulseWidget";
import { CompanyMemoryCard } from "../components/CompanyMemoryCard";
import { CompanyProvidersWidget } from "../components/CompanyProvidersWidget";
import { PendingOutcomesBanner } from "../components/PendingOutcomesBanner";
import { FounderBriefing } from "../components/FounderBriefing";
import { FirstRunProgressCard } from "../components/FirstRunProgressCard";
import { DepartmentStatusGrid } from "../components/DepartmentStatusGrid";
import { CapitalAllocationCard } from "../components/CapitalAllocationCard";
import { TopBlockersWidget } from "../components/dashboard/TopBlockersWidget";
import { QuickWinsWidget } from "../components/dashboard/QuickWinsWidget";
import { YesterdayWidget } from "../components/dashboard/YesterdayWidget";
import { DecisionsInbox } from "./DecisionsInbox";
import { StatusIcon } from "../components/StatusIcon";
import { RunnerInstallDialog } from "../components/RunnerInstallDialog";
import { runnerApi } from "../api/runner";
import { isHostedRunnerAdapter } from "../lib/runner-adapter-types";

import { Identity } from "../components/Identity";
import { AgentRunStatus } from "../components/AgentRunStatus";
import { timeAgo } from "../lib/timeAgo";
import { Bot, CircleDot, ShieldCheck, LayoutDashboard, PauseCircle, Terminal } from "lucide-react";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { ChartCard, PriorityChart, IssueStatusChart, SuccessRateChart } from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import { ProductTour } from "../components/ProductTour";
import type { Agent, Issue } from "@founderos/shared";
import { PluginSlotOutlet } from "@/plugins/slots";

function getRecentIssues(issues: Issue[]): Issue[] {
  return [...issues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();

  // TA05 — runner install dialog state
  const [runnerDialogOpen, setRunnerDialogOpen] = useState(false);

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // TA05 — runner status query. Reuses the same query key as RunnerStatusPill
  // so React Query dedupes the network call when both render simultaneously.
  // Enabled only when the company has at least one hosted-runner agent so we
  // don't fire runner-status requests for founders who don't use BYO runner.
  const hasHostedRunner = useMemo(
    () => agents?.some((a) => isHostedRunnerAdapter(a.adapterType ?? null)) ?? false,
    [agents],
  );
  const { data: runnerStatus } = useQuery({
    queryKey: ["runner-status", selectedCompanyId],
    queryFn: () => runnerApi.status(selectedCompanyId!),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    staleTime: 5_000,
    enabled: !!selectedCompanyId && hasHostedRunner,
  });

  // Show "Connect your runner" CTA when: there are hosted-runner agents,
  // and no token is currently online (missing = no tokens; stale = tokens
  // exist but none seen within 30s). Hidden once any token goes online.
  const showRunnerConnectCta = useMemo(() => {
    if (!hasHostedRunner) return false;
    if (!runnerStatus) return false;
    return !runnerStatus.tokens.some((t) => t.online);
  }, [hasHostedRunner, runnerStatus]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Dashboard" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // P8.a (BL-021): activity API is still needed by <FounderBriefing> for the
  // morning-brief narrative. The visible Recent Activity feed was removed
  // but this query has to stay or the briefing loses its inputs.
  const { data: activity } = useQuery({
    queryKey: queryKeys.activity(selectedCompanyId!),
    queryFn: () => activityApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: runs } = useQuery({
    queryKey: queryKeys.heartbeats(selectedCompanyId!),
    queryFn: () => heartbeatsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const recentIssues = issues ? getRecentIssues(issues) : [];

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return <OnboardingWizardNew />;
    }
    return (
      <EmptyState icon={LayoutDashboard} message="Create or select a company to view the dashboard." />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  const hasNoAgents = agents !== undefined && agents.length === 0;

  const selectedCompany = companies?.find((c) => c.id === selectedCompanyId);
  const companyMetrics = (selectedCompany as { metrics?: unknown } | undefined)?.metrics as
    | import("../components/CompanyPulseWidget").CompanyMetrics
    | undefined;

  return (
    <div className="space-y-8">
      {session?.user?.id && selectedCompanyId && (
        <ProductTour userId={session.user.id} companyId={selectedCompanyId} />
      )}
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {/* S3.10 — magic activation gate. Only renders while a first-run is
          in flight for this company; auto-fires the "Your first brief is
          ready" toast on completion and unmounts after a short cooldown. */}
      {selectedCompanyId && <FirstRunProgressCard companyId={selectedCompanyId} />}

      {/* The Morning Brief — what a founder actually wants in their first 30
          seconds of the day. Narrative + decisions + wins. Everything that
          follows (pulse widget, metric cards, charts) is for "dig deeper". */}
      <FounderBriefing
        companyName={selectedCompany?.name}
        summary={data}
        activity={activity}
        agents={agents}
        issues={issues}
        metrics={companyMetrics}
        companyId={selectedCompanyId}
      />

      <CompanyPulseWidget companyName={selectedCompany?.name} metrics={companyMetrics} />
      {selectedCompanyId && <PendingOutcomesBanner companyId={selectedCompanyId} />}

      {/* P8.c (BL-023): Top Blockers + Quick Wins fill the dashboard slot
          cleared by BL-021 (#171). Both are founder-language, scan-in-5s
          surfaces. Top Blockers aggregates pending approvals + errored
          agents (the two existing "needs you" signals); Quick Wins ships
          static for now — see QuickWinsWidget for the BL-022 follow-up. */}
      {selectedCompanyId && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <TopBlockersWidget companyId={selectedCompanyId} />
          <QuickWinsWidget companyId={selectedCompanyId} />
        </div>
      )}

      {/* P8.b (BL-022): "What we shipped yesterday" — Haiku-generated founder-
          language summary of the last 24h's task completions. Renders below
          the TopBlockers/QuickWins row so the three P8 widgets read top-to-
          bottom as: "what needs you / what you could ask / what already
          shipped". Empty state is reassuring; LLM failure silently falls
          back to raw titles server-side. */}
      {selectedCompanyId && <YesterdayWidget companyId={selectedCompanyId} />}

      {/* S1.6 — Decision Inbox (compact) — pending approvals visible without
          a click. Full inbox lives at /approvals. */}
      <DecisionsInbox compact />

      {/* S1.1 — Department Status grid. Health rollup per department:
          green/yellow/red/grey based on agent state + open approvals +
          last-heartbeat freshness. Click-through to /departments/:id. */}
      {selectedCompanyId && <DepartmentStatusGrid companyId={selectedCompanyId} />}

      {/* S1.2 — Capital Allocation placeholder (the 4th CoS dashboard
          module per the PRD). Real ROI ranking lands when S2 integrations
          sync and S3.8 channel-recommender runs. */}
      <CapitalAllocationCard />

      {/* TODO(BL-021 follow-up): relocate Permission Coach to a Setup-area page.
          Removed from dashboard in P8.a (autoloop cycle 8) to clear noise
          before P8.b/P8.c land. Registering a Setup → PermissionCoach route
          touches `ui/src/lib/company-routes.ts` (Tier-3 nav structure) and
          `Sidebar.tsx`, both forbidden under the autoloop's Tier-1 boundary —
          escalate to SIGNOFFS to land the relocation. Component file
          `components/PermissionCoachCard.tsx` is preserved. */}
      <div data-tour="memory">
        <CompanyMemoryCard companyId={selectedCompanyId} />
      </div>
      <div data-tour="departments">
        <CompanyProvidersWidget companyId={selectedCompanyId ?? undefined} />
      </div>

      {hasNoAgents && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/25 dark:bg-amber-950/60">
          <div className="flex items-center gap-2.5">
            <Bot className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-sm text-amber-900 dark:text-amber-100">
              Your team is empty.
            </p>
          </div>
          <button
            onClick={() => openOnboarding({ initialStep: 2, companyId: selectedCompanyId! })}
            className="text-sm font-medium text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100 underline underline-offset-2 shrink-0"
          >
            Hire your first teammate
          </button>
        </div>
      )}

      {/* TA05 — "Connect your runner" CTA. Surfaces when the founder has
          hosted-runner agents but no token is currently online. Uses the
          same runner-status query key as RunnerStatusPill (React Query
          dedupes the network call). Hidden once any token goes online. */}
      {showRunnerConnectCta && selectedCompanyId && (
        <div
          data-testid="runner-connect-cta"
          className="flex items-center justify-between gap-3 rounded-md border border-violet-300 bg-violet-50 px-4 py-3 dark:border-violet-500/25 dark:bg-violet-950/60"
        >
          <div className="flex items-center gap-2.5">
            <Terminal className="h-4 w-4 text-violet-600 dark:text-violet-400 shrink-0" />
            <div>
              <p className="text-sm font-medium text-violet-900 dark:text-violet-100">
                Your runner isn't connected
              </p>
              <p className="text-xs text-violet-700 dark:text-violet-300">
                Agents won't run until you start the local runner daemon.
              </p>
            </div>
          </div>
          <button
            onClick={() => setRunnerDialogOpen(true)}
            className="text-sm font-medium text-violet-700 hover:text-violet-900 dark:text-violet-300 dark:hover:text-violet-100 underline underline-offset-2 shrink-0"
          >
            Get setup instructions
          </button>
        </div>
      )}

      <ActiveAgentsPanel companyId={selectedCompanyId!} />

      {data && (
        <>
          {data.budgets.activeIncidents > 0 ? (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-red-500/20 bg-[linear-gradient(180deg,rgba(255,80,80,0.12),rgba(255,255,255,0.02))] px-4 py-3">
              <div className="flex items-start gap-2.5">
                <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
                <div>
                  <p className="text-sm font-medium text-red-50">
                    {data.budgets.activeIncidents} active budget incident{data.budgets.activeIncidents === 1 ? "" : "s"}
                  </p>
                  <p className="text-xs text-red-100/70">
                    {data.budgets.pausedAgents} teammates paused · {data.budgets.pausedProjects} projects paused · {data.budgets.pendingApprovals} pending budget approvals
                  </p>
                </div>
              </div>
              <Link to="/costs" className="text-sm underline underline-offset-2 text-red-100">
                Open budgets
              </Link>
            </div>
          ) : null}

          {/* P8.a (BL-021): removed "Month spend" MetricCard (raw cost widget)
              from the dashboard. Full cost detail lives at /costs and is
              still reachable from the active-budget-incident banner above. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            <MetricCard
              icon={Bot}
              value={data.agents.active + data.agents.running + data.agents.paused + data.agents.error}
              label="Team size"
              to="/agents"
              description={
                <span>
                  {data.agents.running} working · {data.agents.paused} paused · {data.agents.error} blocked
                </span>
              }
            />
            <MetricCard
              icon={CircleDot}
              value={data.tasks.inProgress}
              label="Work in flight"
              to="/issues"
              description={
                <span>
                  {data.tasks.open} open · {data.tasks.blocked} blocked
                </span>
              }
            />
            <MetricCard
              icon={ShieldCheck}
              value={data.pendingApprovals + data.budgets.pendingApprovals}
              label="Pending approvals"
              to="/approvals"
              description={
                <span>
                  {data.budgets.pendingApprovals > 0
                    ? `${data.budgets.pendingApprovals} budget overrides awaiting review`
                    : "Awaiting board review"}
                </span>
              }
            />
          </div>

          {/* P8.a (BL-021): removed "Work sessions" RunActivityChart to clear
              dashboard noise. Run-level breakdown is available on
              /agents/:id/runs and the recent-runs strip below still surfaces
              the latest 8 sessions inline. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <ChartCard title="Work by priority" subtitle="Last 14 days">
              <PriorityChart issues={issues ?? []} />
            </ChartCard>
            <ChartCard title="Work by status" subtitle="Last 14 days">
              <IssueStatusChart issues={issues ?? []} />
            </ChartCard>
            <ChartCard title="Session success rate" subtitle="Last 14 days">
              <SuccessRateChart runs={runs ?? []} />
            </ChartCard>
          </div>

          <PluginSlotOutlet
            slotTypes={["dashboardWidget"]}
            context={{ companyId: selectedCompanyId }}
            className="grid gap-4 md:grid-cols-2"
            itemClassName="rounded-lg border bg-card p-4 shadow-sm"
          />

          {runs && runs.length > 0 && (
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                Recent Runs
              </h3>
              <div className="border border-border divide-y divide-border overflow-hidden rounded">
                {runs.slice(0, 8).map((run) => {
                  const agent = agentMap.get(run.agentId);
                  const agentRef = agent
                    ? (agent.urlKey ?? agent.id)
                    : run.agentId;
                  return (
                    <Link
                      key={run.id}
                      to={`/agents/${agentRef}/runs/${run.id}`}
                      className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-accent/50 transition-colors no-underline text-inherit"
                    >
                      <AgentRunStatus run={run} compact />
                      <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
                        {agent?.name ?? "Unknown agent"}
                      </span>
                      <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                        {timeAgo(run.startedAt ?? run.createdAt)}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}

          {/* P8.a (BL-021): removed Recent Activity feed (dashboard noise).
              Full activity log lives at /activity. Recent Tasks stays as the
              single below-the-fold list. */}
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
              Recent Tasks
            </h3>
            {recentIssues.length === 0 ? (
              <div className="border border-border p-4">
                <p className="text-sm text-muted-foreground">No tasks yet.</p>
              </div>
            ) : (
              <div className="border border-border divide-y divide-border overflow-hidden">
                {recentIssues.slice(0, 10).map((issue) => (
                  <Link
                    key={issue.id}
                    to={`/issues/${issue.identifier ?? issue.id}`}
                    className="px-4 py-3 text-sm cursor-pointer hover:bg-accent/50 transition-colors no-underline text-inherit block"
                  >
                    <div className="flex items-start gap-2 sm:items-center sm:gap-3">
                      {/* Status icon - left column on mobile */}
                      <span className="shrink-0 sm:hidden">
                        <StatusIcon status={issue.status} />
                      </span>

                      {/* Right column on mobile: title + metadata stacked */}
                      <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
                        <span className="line-clamp-2 text-sm sm:order-2 sm:flex-1 sm:min-w-0 sm:line-clamp-none sm:truncate">
                          {issue.title}
                        </span>
                        <span className="flex items-center gap-2 sm:order-1 sm:shrink-0">
                          <span className="hidden sm:inline-flex"><StatusIcon status={issue.status} /></span>
                          <span className="text-xs font-mono text-muted-foreground">
                            {issue.identifier ?? issue.id.slice(0, 8)}
                          </span>
                          {issue.assigneeAgentId && (() => {
                            const name = agentName(issue.assigneeAgentId);
                            return name
                              ? <span className="hidden sm:inline-flex"><Identity name={name} size="sm" /></span>
                              : null;
                          })()}
                          <span className="text-xs text-muted-foreground sm:hidden">&middot;</span>
                          <span className="text-xs text-muted-foreground shrink-0 sm:order-last">
                            {timeAgo(issue.updatedAt)}
                          </span>
                        </span>
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

        </>
      )}

      {/* TA05 — RunnerInstallDialog for the "Connect your runner" CTA above. */}
      {selectedCompanyId && (
        <RunnerInstallDialog
          open={runnerDialogOpen}
          onOpenChange={setRunnerDialogOpen}
          companyId={selectedCompanyId}
        />
      )}
    </div>
  );
}
