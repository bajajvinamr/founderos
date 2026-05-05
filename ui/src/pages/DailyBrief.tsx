/**
 * DailyBrief.tsx — render the most recent daily founder brief (S3.3).
 *
 * Sections per the DailyBriefPayload contract: Headline, KPI Movements
 * (table), Anomalies (linked to insights), Blockers, Opportunities,
 * Top 3 Actions (with Approve buttons via the existing approvals API).
 *
 * Mobile-friendly: single column on narrow viewports, card layout on wide.
 *
 * Approve button:
 *   topThreeActions[].approvalId is optional. When present, the action
 *   row renders an "Approve" button that calls approvalsApi.approve(id).
 *   Failures surface inline with the existing ApiError requestId so the
 *   founder can ask support to grep logs.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  dailyBriefsApi,
  type DailyBrief as DailyBriefType,
  type DailyBriefTopAction,
} from "../api/daily-briefs";
import { approvalsApi } from "../api/approvals";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { ApiError } from "../api/client";

export function DailyBrief() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Daily brief" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["daily-briefs", selectedCompanyId ?? "none"],
    queryFn: () => dailyBriefsApi.list(selectedCompanyId!, 30, 0),
    enabled: !!selectedCompanyId,
  });

  const generateNow = useMutation({
    mutationFn: () => dailyBriefsApi.generateNow(selectedCompanyId!),
    onSuccess: () => {
      if (selectedCompanyId) {
        void queryClient.invalidateQueries({
          queryKey: ["daily-briefs", selectedCompanyId],
        });
      }
    },
  });

  const briefs = data?.briefs ?? [];
  const current = briefs[0] ?? null;

  if (!selectedCompanyId) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 text-sm text-muted-foreground">
        Select a company to view the daily brief.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 text-sm text-destructive">
        {error instanceof Error ? error.message : "Failed to load briefs"}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-10">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Daily brief
          </p>
          {current ? (
            <h1 className="mt-1 text-xl font-semibold sm:text-2xl">
              {current.forDate}
            </h1>
          ) : (
            <h1 className="mt-1 text-xl font-semibold sm:text-2xl">
              No brief yet
            </h1>
          )}
        </div>
        <button
          onClick={() => generateNow.mutate()}
          disabled={generateNow.isPending}
          className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          data-testid="generate-now"
        >
          {generateNow.isPending ? "Generating…" : "Generate now"}
        </button>
      </header>

      {generateNow.error && (
        <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {generateNow.error instanceof Error
            ? generateNow.error.message
            : "Failed to generate brief"}
        </div>
      )}

      {!current ? (
        <div className="mt-6 rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          No daily brief has been generated yet for this workspace. Click
          “Generate now” to create the first one.
        </div>
      ) : (
        <BriefBody brief={current} companyId={selectedCompanyId} />
      )}

      {briefs.length > 1 && (
        <section className="mt-10">
          <h2 className="text-sm font-semibold text-muted-foreground">
            Recent briefs
          </h2>
          <ul className="mt-3 divide-y divide-border rounded-md border border-border bg-card">
            {briefs.slice(1, 10).map((b) => (
              <li key={b.id} className="px-4 py-3 text-sm">
                <p className="font-medium">{b.forDate}</p>
                <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                  {b.payload.headline}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function BriefBody({
  brief,
  companyId,
}: {
  brief: DailyBriefType;
  companyId: string;
}) {
  const { payload } = brief;

  return (
    <div className="mt-6 space-y-8">
      {/* Headline */}
      <section className="rounded-lg border border-border bg-card p-5 sm:p-6">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Headline
        </p>
        <p className="mt-2 text-lg leading-snug sm:text-xl">
          {payload.headline}
        </p>
      </section>

      {/* KPI movements */}
      {payload.kpiMovements.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold">KPI movements</h2>
          <div className="mt-2 overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="bg-muted/30 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Metric</th>
                  <th className="px-3 py-2 font-medium">From</th>
                  <th className="px-3 py-2 font-medium">To</th>
                  <th className="px-3 py-2 font-medium">Δ</th>
                  <th className="px-3 py-2 font-medium">Commentary</th>
                </tr>
              </thead>
              <tbody>
                {payload.kpiMovements.map((k, i) => (
                  <tr key={`${k.metric}-${i}`} className="border-t border-border">
                    <td className="px-3 py-2 font-medium">{k.metric}</td>
                    <td className="px-3 py-2">{k.from}</td>
                    <td className="px-3 py-2">{k.to}</td>
                    <td className="px-3 py-2">{k.delta}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {k.commentary}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Anomalies */}
      {payload.anomalies.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold">Anomalies</h2>
          <ul className="mt-2 space-y-2">
            {payload.anomalies.map((a, i) => (
              <li
                key={`${a.insightId}-${i}`}
                className="flex items-start justify-between gap-3 rounded-md border border-border bg-card p-3 text-sm"
              >
                <span>{a.title}</span>
                {/* Insights detail page lives at /insights/:id once that
                    UI lands; for now link to the insights surface filtered
                    by id so the founder gets to context quickly. */}
                <Link
                  to={`/insights?id=${encodeURIComponent(a.insightId)}`}
                  className="shrink-0 text-xs text-primary hover:underline"
                >
                  view insight
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Blockers */}
      {payload.blockers.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold">Blockers</h2>
          <ul className="mt-2 space-y-2">
            {payload.blockers.map((b, i) => (
              <li
                key={i}
                className="rounded-md border border-border bg-card p-3 text-sm"
              >
                <p className="font-medium">{b.title}</p>
                <p className="mt-1 text-muted-foreground">{b.resolutionAction}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Opportunities */}
      {payload.opportunities.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold">Opportunities</h2>
          <ul className="mt-2 space-y-2">
            {payload.opportunities.map((o, i) => (
              <li
                key={`${o.insightId}-${i}`}
                className="rounded-md border border-border bg-card p-3 text-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="font-medium">{o.title}</p>
                  <Link
                    to={`/insights?id=${encodeURIComponent(o.insightId)}`}
                    className="shrink-0 text-xs text-primary hover:underline"
                  >
                    view insight
                  </Link>
                </div>
                <p className="mt-1 text-muted-foreground">{o.expectedImpact}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Top 3 actions */}
      {payload.topThreeActions.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold">Top 3 actions</h2>
          <ol className="mt-2 space-y-2">
            {payload.topThreeActions.map((a, i) => (
              <li
                key={i}
                className="rounded-md border border-border bg-card p-3 text-sm"
              >
                <ActionRow action={a} index={i + 1} companyId={companyId} />
              </li>
            ))}
          </ol>
        </section>
      )}

      <footer className="text-xs text-muted-foreground">
        Generated {new Date(brief.generatedAt).toLocaleString()}
        {brief.emailSentAt
          ? ` · emailed ${new Date(brief.emailSentAt).toLocaleString()}`
          : ""}
      </footer>
    </div>
  );
}

function ActionRow({
  action,
  index,
  companyId: _companyId,
}: {
  action: DailyBriefTopAction;
  index: number;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const approve = useMutation({
    mutationFn: async () => {
      if (!action.approvalId) throw new Error("No approvalId on this action");
      return approvalsApi.approve(action.approvalId);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        setErrMsg(
          err.requestId
            ? `${err.message} (request ${err.requestId})`
            : err.message,
        );
      } else if (err instanceof Error) {
        setErrMsg(err.message);
      } else {
        setErrMsg("Failed to approve");
      }
    },
  });

  const canApprove = useMemo(
    () => Boolean(action.approvalId),
    [action.approvalId],
  );

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium">
          <span className="mr-1.5 text-muted-foreground">{index}.</span>
          {action.action}
        </p>
        {canApprove && (
          <button
            disabled={approve.isPending || approve.isSuccess}
            onClick={() => approve.mutate()}
            className="inline-flex h-7 shrink-0 items-center justify-center rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
            data-testid={`approve-${index}`}
          >
            {approve.isSuccess
              ? "Approved"
              : approve.isPending
                ? "Approving…"
                : "Approve"}
          </button>
        )}
      </div>
      <p className="mt-1 text-muted-foreground">{action.rationale}</p>
      {errMsg && (
        <p className="mt-1 text-xs text-destructive">{errMsg}</p>
      )}
    </div>
  );
}
