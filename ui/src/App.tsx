import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "@/lib/router";
import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Layout } from "./components/Layout";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { FounderOnboardingWizard } from "./components/onboarding/FounderOnboardingWizard";
import { authApi } from "./api/auth";

/**
 * Feature flag for the opinionated 6-step founder onboarding (Wave 15A).
 * Defaults to ON in dev so every local run exercises the new flow; ships
 * OFF in prod until the new bootstrap API is vetted end-to-end.
 * Set `VITE_FOUNDEROS_ONBOARDING_V2=false` in dev to fall back.
 */
const FOUNDEROS_ONBOARDING_V2: boolean = (() => {
  const raw = import.meta.env.VITE_FOUNDEROS_ONBOARDING_V2;
  if (raw === undefined || raw === null || raw === "") {
    return import.meta.env.DEV === true;
  }
  return raw !== "false" && raw !== "0";
})();
import { healthApi } from "./api/health";

// Hot-path pages are imported eagerly — first paint after login hits these.
import { Dashboard } from "./pages/Dashboard";
import { Companies } from "./pages/Companies";
import { Agents } from "./pages/Agents";
import { Issues } from "./pages/Issues";
import { Inbox } from "./pages/Inbox";
import { AuthPage } from "./pages/Auth";
import { Landing } from "./pages/Landing";
import { NotFoundPage } from "./pages/NotFound";

// Everything else is lazy — downloaded on first navigation, not on app load.
// Grouped by workflow so hover-prefetch can preload a related cluster later.
const AgentDetail = lazy(() => import("./pages/AgentDetail").then((m) => ({ default: m.AgentDetail })));
const NewAgent = lazy(() => import("./pages/NewAgent").then((m) => ({ default: m.NewAgent })));
const HireTeammate = lazy(() => import("./pages/HireTeammate").then((m) => ({ default: m.HireTeammate })));
const Projects = lazy(() => import("./pages/Projects").then((m) => ({ default: m.Projects })));
const ProjectDetail = lazy(() => import("./pages/ProjectDetail").then((m) => ({ default: m.ProjectDetail })));
const ProjectWorkspaceDetail = lazy(() => import("./pages/ProjectWorkspaceDetail").then((m) => ({ default: m.ProjectWorkspaceDetail })));
const IssueDetail = lazy(() => import("./pages/IssueDetail").then((m) => ({ default: m.IssueDetail })));
const Routines = lazy(() => import("./pages/Routines").then((m) => ({ default: m.Routines })));
const RoutineDetail = lazy(() => import("./pages/RoutineDetail").then((m) => ({ default: m.RoutineDetail })));
const ExecutionWorkspaceDetail = lazy(() => import("./pages/ExecutionWorkspaceDetail").then((m) => ({ default: m.ExecutionWorkspaceDetail })));
const Goals = lazy(() => import("./pages/Goals").then((m) => ({ default: m.Goals })));
const GoalDetail = lazy(() => import("./pages/GoalDetail").then((m) => ({ default: m.GoalDetail })));
const Approvals = lazy(() => import("./pages/Approvals").then((m) => ({ default: m.Approvals })));
const ApprovalDetail = lazy(() => import("./pages/ApprovalDetail").then((m) => ({ default: m.ApprovalDetail })));
const DecisionsInbox = lazy(() => import("./pages/DecisionsInbox").then((m) => ({ default: m.DecisionsInbox })));
const Costs = lazy(() => import("./pages/Costs").then((m) => ({ default: m.Costs })));
const Activity = lazy(() => import("./pages/Activity").then((m) => ({ default: m.Activity })));
const AuditLog = lazy(() => import("./pages/AuditLog").then((m) => ({ default: m.AuditLog })));
const CompanySettings = lazy(() => import("./pages/CompanySettings").then((m) => ({ default: m.CompanySettings })));
const CompanySkills = lazy(() => import("./pages/CompanySkills").then((m) => ({ default: m.CompanySkills })));
const CompanyExport = lazy(() => import("./pages/CompanyExport").then((m) => ({ default: m.CompanyExport })));
const CompanyImport = lazy(() => import("./pages/CompanyImport").then((m) => ({ default: m.CompanyImport })));
const DesignGuide = lazy(() => import("./pages/DesignGuide").then((m) => ({ default: m.DesignGuide })));
const InstanceGeneralSettings = lazy(() => import("./pages/InstanceGeneralSettings").then((m) => ({ default: m.InstanceGeneralSettings })));
const InstanceSettings = lazy(() => import("./pages/InstanceSettings").then((m) => ({ default: m.InstanceSettings })));
const InstanceExperimentalSettings = lazy(() => import("./pages/InstanceExperimentalSettings").then((m) => ({ default: m.InstanceExperimentalSettings })));
const InstanceProvidersSettings = lazy(() => import("./pages/InstanceProvidersSettings").then((m) => ({ default: m.InstanceProvidersSettings })));
const InstanceAdminMembers = lazy(() => import("./pages/InstanceAdminMembers").then((m) => ({ default: m.InstanceAdminMembers })));
const LegalTerms = lazy(() => import("./pages/LegalTerms").then((m) => ({ default: m.LegalTerms })));
const LegalPrivacy = lazy(() => import("./pages/LegalPrivacy").then((m) => ({ default: m.LegalPrivacy })));
const PluginManager = lazy(() => import("./pages/PluginManager").then((m) => ({ default: m.PluginManager })));
const PluginSettings = lazy(() => import("./pages/PluginSettings").then((m) => ({ default: m.PluginSettings })));
const AdapterManager = lazy(() => import("./pages/AdapterManager").then((m) => ({ default: m.AdapterManager })));
const PluginPage = lazy(() => import("./pages/PluginPage").then((m) => ({ default: m.PluginPage })));
const IssueChatUxLab = lazy(() => import("./pages/IssueChatUxLab").then((m) => ({ default: m.IssueChatUxLab })));
const RunTranscriptUxLab = lazy(() => import("./pages/RunTranscriptUxLab").then((m) => ({ default: m.RunTranscriptUxLab })));
const OrgChart = lazy(() => import("./pages/OrgChart").then((m) => ({ default: m.OrgChart })));
const DepartmentConsole = lazy(() => import("./pages/DepartmentConsole").then((m) => ({ default: m.DepartmentConsole })));
const Integrations = lazy(() => import("./pages/Integrations").then((m) => ({ default: m.Integrations })));
const BoardClaimPage = lazy(() => import("./pages/BoardClaim").then((m) => ({ default: m.BoardClaimPage })));
const CliAuthPage = lazy(() => import("./pages/CliAuth").then((m) => ({ default: m.CliAuthPage })));
const InviteLandingPage = lazy(() => import("./pages/InviteLanding").then((m) => ({ default: m.InviteLandingPage })));
const WeeklyWrap = lazy(() => import("./pages/WeeklyWrap").then((m) => ({ default: m.WeeklyWrap })));
const Conversations = lazy(() => import("./pages/Conversations").then((m) => ({ default: m.Conversations })));
const ForgotPassword = lazy(() => import("./pages/ForgotPassword").then((m) => ({ default: m.ForgotPassword })));
const ResetPassword = lazy(() => import("./pages/ResetPassword").then((m) => ({ default: m.ResetPassword })));
const NotificationsSettings = lazy(() => import("./pages/Settings/Notifications").then((m) => ({ default: m.NotificationsSettings })));
import { queryKeys } from "./lib/queryKeys";
import { useCompany } from "./context/CompanyContext";
import { useDialog } from "./context/DialogContext";
import { loadLastInboxTab } from "./lib/inbox";
import { shouldRedirectCompanylessRouteToOnboarding } from "./lib/onboarding-route";

function BootstrapPendingPage({ hasActiveInvite = false }: { hasActiveInvite?: boolean }) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">Instance setup required</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {hasActiveInvite
            ? "No instance admin exists yet. A bootstrap invite is already active. Check your FounderOS startup logs for the first admin invite URL, or run this command to rotate it:"
            : "No instance admin exists yet. Run this command in your FounderOS environment to generate the first admin invite URL:"}
        </p>
        <pre className="mt-4 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
{`pnpm founderos auth bootstrap-ceo`}
        </pre>
      </div>
    </div>
  );
}

function CloudAccessGate() {
  const location = useLocation();
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as
        | { deploymentMode?: "local_trusted" | "authenticated"; bootstrapStatus?: "ready" | "bootstrap_pending" }
        | undefined;
      return data?.deploymentMode === "authenticated" && data.bootstrapStatus === "bootstrap_pending"
        ? 2000
        : false;
    },
    refetchIntervalInBackground: true,
  });

  const isAuthenticatedMode = healthQuery.data?.deploymentMode === "authenticated";
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: isAuthenticatedMode,
    retry: false,
  });

  if (healthQuery.isLoading || (isAuthenticatedMode && sessionQuery.isLoading)) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  if (healthQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">
        {healthQuery.error instanceof Error ? healthQuery.error.message : "Failed to load app state"}
      </div>
    );
  }

  // Supabase/Clerk first-user-wins: send unauthenticated visitors to /auth
  // even when the instance is "bootstrap_pending". The first authenticated
  // request from the new user auto-promotes them to instance admin via
  // actorMiddleware → runPostSignupBootstrap, flipping status to ready.
  // Only show the legacy CLI-invite page to already-signed-in users who
  // somehow hit this state (better-auth deployments without post-signup hook).
  if (isAuthenticatedMode && healthQuery.data?.bootstrapStatus === "bootstrap_pending") {
    if (sessionQuery.data) {
      return <BootstrapPendingPage hasActiveInvite={healthQuery.data.bootstrapInviteActive} />;
    }
    // Fall through to the unauthenticated routing block below.
  }

  if (isAuthenticatedMode && !sessionQuery.data) {
    // Unauthenticated users landing on the root path get the public
    // marketing page, not the bare sign-in form. Deep links into protected
    // surfaces still go straight to /auth so the next= param round-trips.
    if (location.pathname === "/" || location.pathname === "") {
      return <Navigate to="/landing" replace />;
    }
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/auth?next=${next}`} replace />;
  }

  return (
    <Suspense fallback={<LazyRouteFallback />}>
      <Outlet />
    </Suspense>
  );
}

/** Lightweight placeholder while a lazy page chunk is downloading. */
function LazyRouteFallback() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="h-5 w-5 rounded-full border-2 border-muted-foreground/20 border-t-[var(--brand)] animate-spin" />
    </div>
  );
}

function boardRoutes() {
  return (
    <>
      <Route index element={<Navigate to="dashboard" replace />} />
      <Route path="dashboard" element={<Dashboard />} />
      <Route path="onboarding" element={<OnboardingRoutePage />} />
      <Route path="companies" element={<Companies />} />
      <Route path="company/settings" element={<CompanySettings />} />
      <Route path="company/export/*" element={<CompanyExport />} />
      <Route path="company/import" element={<CompanyImport />} />
      <Route path="skills/*" element={<CompanySkills />} />
      <Route path="settings" element={<LegacySettingsRedirect />} />
      <Route path="settings/*" element={<LegacySettingsRedirect />} />
      <Route path="plugins/:pluginId" element={<PluginPage />} />
      <Route path="org" element={<OrgChart />} />
      <Route path="departments" element={<Navigate to="/departments/chief-of-staff" replace />} />
      <Route path="departments/:departmentId" element={<DepartmentConsole />} />
      <Route path="agents" element={<Navigate to="/agents/all" replace />} />
      <Route path="agents/all" element={<Agents />} />
      <Route path="agents/active" element={<Agents />} />
      <Route path="agents/paused" element={<Agents />} />
      <Route path="agents/error" element={<Agents />} />
      <Route path="agents/new" element={<NewAgent />} />
      <Route path="hire" element={<HireTeammate />} />
      <Route path="agents/:agentId" element={<AgentDetail />} />
      <Route path="agents/:agentId/:tab" element={<AgentDetail />} />
      <Route path="agents/:agentId/runs/:runId" element={<AgentDetail />} />
      <Route path="projects" element={<Projects />} />
      <Route path="projects/:projectId" element={<ProjectDetail />} />
      <Route path="projects/:projectId/overview" element={<ProjectDetail />} />
      <Route path="projects/:projectId/issues" element={<ProjectDetail />} />
      <Route path="projects/:projectId/issues/:filter" element={<ProjectDetail />} />
      <Route path="projects/:projectId/workspaces/:workspaceId" element={<ProjectWorkspaceDetail />} />
      <Route path="projects/:projectId/workspaces" element={<ProjectDetail />} />
      <Route path="projects/:projectId/configuration" element={<ProjectDetail />} />
      <Route path="projects/:projectId/budget" element={<ProjectDetail />} />
      <Route path="issues" element={<Issues />} />
      <Route path="issues/all" element={<Navigate to="/issues" replace />} />
      <Route path="issues/active" element={<Navigate to="/issues" replace />} />
      <Route path="issues/backlog" element={<Navigate to="/issues" replace />} />
      <Route path="issues/done" element={<Navigate to="/issues" replace />} />
      <Route path="issues/recent" element={<Navigate to="/issues" replace />} />
      <Route path="issues/:issueId" element={<IssueDetail />} />
      <Route path="routines" element={<Routines />} />
      <Route path="routines/:routineId" element={<RoutineDetail />} />
      <Route path="execution-workspaces/:workspaceId" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/configuration" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/issues" element={<ExecutionWorkspaceDetail />} />
      <Route path="goals" element={<Goals />} />
      <Route path="goals/:goalId" element={<GoalDetail />} />
      <Route path="approvals" element={<Navigate to="/approvals/pending" replace />} />
      <Route path="approvals/pending" element={<Approvals />} />
      <Route path="approvals/all" element={<Approvals />} />
      <Route path="approvals/:approvalId" element={<ApprovalDetail />} />
      <Route path="decisions" element={<DecisionsInbox />} />
      <Route path="costs" element={<Costs />} />
      <Route path="integrations" element={<Integrations />} />
      <Route path="activity" element={<Activity />} />
      <Route path="audit" element={<AuditLog />} />
      <Route path="weekly" element={<WeeklyWrap />} />
      <Route path="conversations" element={<Conversations />} />
      <Route path="conversations/:convId" element={<Conversations />} />
      <Route path="inbox" element={<InboxRootRedirect />} />
      <Route path="inbox/mine" element={<Inbox />} />
      <Route path="inbox/recent" element={<Inbox />} />
      <Route path="inbox/unread" element={<Inbox />} />
      <Route path="inbox/all" element={<Inbox />} />
      <Route path="inbox/new" element={<Navigate to="/inbox/mine" replace />} />
      <Route path="design-guide" element={<DesignGuide />} />
      <Route path="tests/ux/chat" element={<IssueChatUxLab />} />
      <Route path="tests/ux/runs" element={<RunTranscriptUxLab />} />
      <Route path="instance/settings/adapters" element={<AdapterManager />} />
      <Route path=":pluginRoutePath" element={<PluginPage />} />
      <Route path="*" element={<NotFoundPage scope="board" />} />
    </>
  );
}

function InboxRootRedirect() {
  return <Navigate to={`/inbox/${loadLastInboxTab()}`} replace />;
}

function LegacySettingsRedirect() {
  const location = useLocation();
  return <Navigate to={`/instance/settings/general${location.search}${location.hash}`} replace />;
}

function OnboardingRoutePage() {
  const { companies } = useCompany();
  const { openOnboarding } = useDialog();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();
  const matchedCompany = companyPrefix
    ? companies.find((company) => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase()) ?? null
    : null;

  const title = matchedCompany
    ? `Hire another teammate into ${matchedCompany.name}`
    : companies.length > 0
      ? "Create another company"
      : "Create your first company";
  const description = matchedCompany
    ? "Run onboarding again to hire a teammate and seed a starter task for this company."
    : companies.length > 0
      ? "Run onboarding again to create another company and hire its first teammate."
      : "Get started by creating a company and hiring your first teammate.";

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <div className="mt-4">
          <Button
            onClick={() =>
              matchedCompany
                ? openOnboarding({ initialStep: 2, companyId: matchedCompany.id })
                : openOnboarding()
            }
          >
            {matchedCompany ? "Hire teammate" : "Start onboarding"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CompanyRootRedirect() {
  const { companies, selectedCompany, loading } = useCompany();
  const location = useLocation();

  if (loading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (!targetCompany) {
    if (
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: location.pathname,
        hasCompanies: false,
      })
    ) {
      return <Navigate to="/onboarding" replace />;
    }
    return <NoCompaniesStartPage />;
  }

  return <Navigate to={`/${targetCompany.issuePrefix}/dashboard`} replace />;
}

function UnprefixedBoardRedirect() {
  const location = useLocation();
  const { companies, selectedCompany, loading } = useCompany();

  if (loading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (!targetCompany) {
    if (
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: location.pathname,
        hasCompanies: false,
      })
    ) {
      return <Navigate to="/onboarding" replace />;
    }
    return <NoCompaniesStartPage />;
  }

  return (
    <Navigate
      to={`/${targetCompany.issuePrefix}${location.pathname}${location.search}${location.hash}`}
      replace
    />
  );
}

function NoCompaniesStartPage() {
  const { openOnboarding } = useDialog();

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">Create your first company</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Get started by creating a company.
        </p>
        <div className="mt-4">
          <Button onClick={() => openOnboarding()}>New Company</Button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  return (
    <>
      <Routes>
        <Route path="landing" element={<Landing />} />
        <Route path="auth" element={<AuthPage />} />
        <Route
          path="auth/forgot"
          element={
            <Suspense fallback={<LazyRouteFallback />}>
              <ForgotPassword />
            </Suspense>
          }
        />
        <Route
          path="auth/reset"
          element={
            <Suspense fallback={<LazyRouteFallback />}>
              <ResetPassword />
            </Suspense>
          }
        />
        <Route path="legal/terms" element={<LegalTerms />} />
        <Route path="legal/privacy" element={<LegalPrivacy />} />
        <Route path="board-claim/:token" element={<BoardClaimPage />} />
        <Route path="cli-auth/:id" element={<CliAuthPage />} />
        <Route path="invite/:token" element={<InviteLandingPage />} />

        <Route element={<CloudAccessGate />}>
          <Route index element={<CompanyRootRedirect />} />
          <Route path="onboarding" element={<OnboardingRoutePage />} />
          <Route path="instance" element={<Navigate to="/instance/settings/general" replace />} />
          <Route path="instance/members" element={<Navigate to="/instance/settings/members" replace />} />
          <Route path="instance/settings" element={<Layout />}>
            <Route index element={<Navigate to="general" replace />} />
            <Route path="general" element={<InstanceGeneralSettings />} />
            <Route path="members" element={<InstanceAdminMembers />} />
            <Route path="providers" element={<InstanceProvidersSettings />} />
            <Route path="heartbeats" element={<InstanceSettings />} />
            <Route path="experimental" element={<InstanceExperimentalSettings />} />
            <Route path="plugins" element={<PluginManager />} />
            <Route path="plugins/:pluginId" element={<PluginSettings />} />
            <Route path="adapters" element={<AdapterManager />} />
          </Route>
          <Route path="settings/notifications" element={<Layout />}>
            <Route index element={<NotificationsSettings />} />
          </Route>
          <Route path="companies" element={<UnprefixedBoardRedirect />} />
          <Route path="issues" element={<UnprefixedBoardRedirect />} />
          <Route path="issues/:issueId" element={<UnprefixedBoardRedirect />} />
          <Route path="routines" element={<UnprefixedBoardRedirect />} />
          <Route path="routines/:routineId" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/*" element={<UnprefixedBoardRedirect />} />
          <Route path="settings" element={<LegacySettingsRedirect />} />
          <Route path="settings/*" element={<LegacySettingsRedirect />} />
          <Route path="agents" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/new" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId/:tab" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId/runs/:runId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/overview" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/issues" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/issues/:filter" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/workspaces" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/workspaces/:workspaceId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/configuration" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId/configuration" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId/issues" element={<UnprefixedBoardRedirect />} />
          <Route path="tests/ux/chat" element={<UnprefixedBoardRedirect />} />
          <Route path="tests/ux/runs" element={<UnprefixedBoardRedirect />} />
          <Route path="conversations" element={<UnprefixedBoardRedirect />} />
          <Route path="conversations/:convId" element={<UnprefixedBoardRedirect />} />
          <Route path=":companyPrefix" element={<Layout />}>
            {boardRoutes()}
          </Route>
          <Route path="*" element={<NotFoundPage scope="global" />} />
        </Route>
      </Routes>
      {FOUNDEROS_ONBOARDING_V2 ? <FounderOnboardingWizard /> : <OnboardingWizard />}
    </>
  );
}
