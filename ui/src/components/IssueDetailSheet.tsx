import { useCallback, useEffect, useMemo } from "react";
import { Link, useSearchParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import type { Issue } from "@founderos/shared";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { useCompany } from "../context/CompanyContext";
import { cn } from "../lib/utils";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";

/**
 * URL search-param key used to reflect the open issue in the address bar.
 *
 * Per `docs/design/founderos-frontend-plan/03-work-surfaces.md` §0.4, every
 * list surface opens detail in a right-side sheet; the URL reflects the open
 * row (e.g. `/work/issues?row=PAP-117`) so it is bookmarkable and refresh-safe.
 */
export const ISSUE_DETAIL_SHEET_PARAM = "row";

interface IssueDetailSheetProps {
  /**
   * Optional override for the issue identifier. If omitted, the component
   * reads `?row=<id>` from the URL. Useful for tests and for callers that
   * want to drive the sheet imperatively.
   */
  issueId?: string;
  /**
   * Optional callback invoked AFTER the sheet closes and the `?row=` param
   * has been dropped from the URL. Used by the parent to restore focus to
   * the row that opened the sheet (RV-007 HIGH #2 — spec §6.2 "Focus
   * returns to the row that was selected").
   */
  onClose?: () => void;
}

/**
 * Right-side detail sheet for an issue. Layered on top of the existing list
 * route — the legacy `/issues/:id` full page survives and is reachable via
 * the "Open full page →" affordance in the sheet header.
 *
 * Spec: `docs/design/founderos-frontend-plan/03-work-surfaces.md` §B.6.
 */
export function IssueDetailSheet({ issueId, onClose }: IssueDetailSheetProps = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();

  const paramRowId = searchParams.get(ISSUE_DETAIL_SHEET_PARAM);
  const activeIssueId = issueId ?? paramRowId ?? null;
  const isOpen = activeIssueId !== null;

  const handleClose = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete(ISSUE_DETAIL_SHEET_PARAM);
    setSearchParams(next, { replace: true });
    // Notify parent after the param is dropped so it can restore focus to the
    // originating row (RV-007 HIGH #2). Callback is additive — the URL is
    // still the source of truth for sheet open/close state.
    onClose?.();
  }, [onClose, searchParams, setSearchParams]);

  const { data: issue, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.detail(activeIssueId ?? "__none__"),
    queryFn: () => issuesApi.get(activeIssueId!),
    enabled: isOpen,
    staleTime: 5_000,
  });

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      if (activeIssueId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.detail(activeIssueId),
        });
      }
      if (selectedCompanyId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.list(selectedCompanyId),
        });
      }
    },
  });

  const handleStatusChange = useCallback(
    (status: string) => {
      if (!issue) return;
      updateIssue.mutate({ id: issue.id, data: { status } });
    },
    [issue, updateIssue],
  );

  const handlePriorityChange = useCallback(
    (priority: string) => {
      if (!issue) return;
      updateIssue.mutate({ id: issue.id, data: { priority } });
    },
    [issue, updateIssue],
  );

  const fullPagePath = useMemo(() => {
    if (!issue) return null;
    return createIssueDetailPath(issue.identifier ?? issue.id);
  }, [issue]);

  // Defensive: if the URL param disappears (e.g. browser back), make sure the
  // sheet's `open` prop reflects the change. Radix handles `onOpenChange`, but
  // we listen for Escape ourselves to be explicit about the spec contract.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Radix Sheet handles this natively; keep this hook for explicitness
        // and so tests can simulate keydown on document.
        handleClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, handleClose]);

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <SheetContent
        side="right"
        showCloseButton
        className={cn(
          // Per spec §B.6 + §0.4: 640px on desktop, full-screen on mobile.
          "w-full p-0 sm:max-w-[640px]",
          // Motion timings per §0.6: open 200ms ease-out, close 150ms ease-in.
          "data-[state=open]:duration-200 data-[state=closed]:duration-150",
          "data-[state=open]:ease-out data-[state=closed]:ease-in",
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby="issue-detail-sheet-title"
        data-testid="issue-detail-sheet"
      >
        {isLoading ? (
          <IssueDetailSheetSkeleton />
        ) : error ? (
          <div className="p-6">
            <SheetHeader className="p-0">
              <SheetTitle id="issue-detail-sheet-title">Couldn't load issue</SheetTitle>
            </SheetHeader>
            <p className="mt-2 text-sm text-muted-foreground">
              The issue couldn't be loaded. Close this panel and try again.
            </p>
          </div>
        ) : issue ? (
          <IssueDetailSheetBody
            issue={issue}
            fullPagePath={fullPagePath}
            onStatusChange={handleStatusChange}
            onPriorityChange={handlePriorityChange}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function IssueDetailSheetSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-6" data-testid="issue-detail-sheet-skeleton">
      <Skeleton className="h-5 w-24" />
      <Skeleton className="h-7 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="mt-4 h-20 w-full" />
    </div>
  );
}

interface IssueDetailSheetBodyProps {
  issue: Issue;
  fullPagePath: string | null;
  onStatusChange: (status: string) => void;
  onPriorityChange: (priority: string) => void;
}

function IssueDetailSheetBody({
  issue,
  fullPagePath,
  onStatusChange,
  onPriorityChange,
}: IssueDetailSheetBodyProps) {
  const identifier = issue.identifier ?? issue.id.slice(0, 8);

  return (
    <div className="flex h-full flex-col">
      <SheetHeader className="gap-1 border-b border-border px-6 py-4 pr-12">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {identifier}
          </span>
          {fullPagePath ? (
            <Link
              to={fullPagePath}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              data-testid="issue-detail-sheet-full-page"
            >
              Open full page
              <ArrowUpRight className="h-3 w-3" />
            </Link>
          ) : null}
        </div>
        <SheetTitle
          id="issue-detail-sheet-title"
          className="text-base font-semibold leading-snug"
        >
          {issue.title}
        </SheetTitle>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <StatusIcon status={issue.status} onChange={onStatusChange} showLabel />
          </span>
          <span className="inline-flex items-center gap-1.5">
            <PriorityIcon
              priority={issue.priority}
              onChange={onPriorityChange}
              showLabel
            />
          </span>
          {issue.assigneeAgentId ? (
            <span data-testid="issue-detail-sheet-assignee">
              Assigned · {issue.assigneeAgentId.slice(0, 8)}
            </span>
          ) : null}
        </div>
      </SheetHeader>
      <ScrollArea className="flex-1">
        <div className="space-y-6 px-6 py-5">
          {issue.description ? (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Description
              </h3>
              <p className="whitespace-pre-wrap text-sm text-foreground">
                {issue.description}
              </p>
            </section>
          ) : null}
          <section aria-labelledby="issue-detail-sheet-comments-heading">
            <h3
              id="issue-detail-sheet-comments-heading"
              className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              Comments
            </h3>
            <p className="text-sm text-muted-foreground">
              Comment thread loads in the full page view.
            </p>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}
