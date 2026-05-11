import { useEffect, useMemo, useCallback, useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useLocation, useSearchParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import { IssueDetailSheet, ISSUE_DETAIL_SHEET_PARAM } from "../components/IssueDetailSheet";
import { CircleDot } from "lucide-react";

export function Issues() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  // Track the row that opened the sheet so we can restore focus when it
  // closes (RV-007 HIGH #2 — spec §6.2 "Focus returns to the row that was
  // selected"). Without this, Radix Sheet has no element to return focus to
  // and focus drops onto document.body.
  const lastFocusedRowRef = useRef<HTMLElement | null>(null);

  // Per `docs/design/founderos-frontend-plan/03-work-surfaces.md` §B.6: row
  // click opens the detail sheet in-place (URL reflects `?row=<id>`) instead
  // of full-page navigation. We layer this on top of the existing IssueRow
  // <Link> by intercepting clicks at the page-container level — preserves all
  // existing row markup, data-testid attributes, and keyboard affordances.
  // Modifier-clicks (cmd/ctrl/middle/shift) fall through to native navigation.
  const handleRowClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    const link = target?.closest("[data-inbox-issue-link]") as HTMLAnchorElement | null;
    if (!link) return;
    const href = link.getAttribute("href") ?? "";
    // `createIssueDetailPath(id)` → `/issues/<id>`; pull the trailing segment.
    const match = href.match(/\/issues\/([^/?#]+)/);
    if (!match) return;
    event.preventDefault();
    event.stopPropagation();
    // Remember the row element so focus returns here on close.
    lastFocusedRowRef.current = link;
    const next = new URLSearchParams(searchParams);
    next.set(ISSUE_DETAIL_SHEET_PARAM, decodeURIComponent(match[1]));
    setSearchParams(next, { replace: false });
  }, [searchParams, setSearchParams]);

  const handleSheetClose = useCallback(() => {
    // Defer focus restoration to the next frame so Radix completes its own
    // focus-trap teardown first — otherwise it can steal focus right back.
    const target = lastFocusedRowRef.current;
    if (!target || !target.isConnected) return;
    requestAnimationFrame(() => {
      if (target.isConnected) target.focus();
    });
  }, []);

  const initialSearch = searchParams.get("q") ?? "";
  const participantAgentId = searchParams.get("participantAgentId") ?? undefined;
  const handleSearchChange = useCallback((search: string) => {
    const trimmedSearch = search.trim();
    const currentSearch = new URLSearchParams(window.location.search).get("q") ?? "";
    if (currentSearch === trimmedSearch) return;

    const url = new URL(window.location.href);
    if (trimmedSearch) {
      url.searchParams.set("q", trimmedSearch);
    } else {
      url.searchParams.delete("q");
    }

    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, "", nextUrl);
  }, []);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 5000,
  });

  const liveIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of liveRuns ?? []) {
      if (run.issueId) ids.add(run.issueId);
    }
    return ids;
  }, [liveRuns]);

  const issueLinkState = useMemo(
    () =>
      createIssueDetailLocationState(
        "Issues",
        `${location.pathname}${location.search}${location.hash}`,
        "issues",
      ),
    [location.pathname, location.search, location.hash],
  );

  useEffect(() => {
    setBreadcrumbs([{ label: "Issues" }]);
  }, [setBreadcrumbs]);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: [
      ...queryKeys.issues.list(selectedCompanyId!),
      "participant-agent",
      participantAgentId ?? "__all__",
      "with-routine-executions",
    ],
    queryFn: () => issuesApi.list(selectedCompanyId!, { participantAgentId, includeRoutineExecutions: true }),
    enabled: !!selectedCompanyId,
  });

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={CircleDot} message="Select a company to view issues." />;
  }

  return (
    <div onClickCapture={handleRowClickCapture} data-testid="issues-page-root">
      <IssuesList
        issues={issues ?? []}
        isLoading={isLoading}
        error={error as Error | null}
        agents={agents}
        projects={projects}
        liveIssueIds={liveIssueIds}
        viewStateKey="founderos:issues-view"
        issueLinkState={issueLinkState}
        initialAssignees={searchParams.get("assignee") ? [searchParams.get("assignee")!] : undefined}
        initialSearch={initialSearch}
        onSearchChange={handleSearchChange}
        enableRoutineVisibilityFilter
        onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
        searchFilters={participantAgentId ? { participantAgentId } : undefined}
      />
      <IssueDetailSheet onClose={handleSheetClose} />
    </div>
  );
}
