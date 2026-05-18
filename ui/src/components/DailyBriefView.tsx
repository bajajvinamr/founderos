/**
 * DailyBriefView.tsx — render the most-recent daily brief inline on `/today`.
 *
 * L2-C05: PR #203 seeded a `daily_briefs` row for the Mira Labs dogfood
 * persona; this component is the consumer. Without it, the dogfood data sat
 * on disk with no UI surface. With it, the Today page renders Anita's
 * overnight CoS output the moment she signs in — the AHA moment for the
 * dogfood instance.
 *
 * Why this component (not just extend Today.tsx in place):
 *   - The full DailyBriefPayload renderer was previously only on /brief
 *     (DailyBrief.tsx). Today.tsx rendered the headline only.
 *   - Factoring it out lets /today inline a calm rich view AND lets other
 *     surfaces (e.g. embedded in a deep link, a future digest preview)
 *     reuse it.
 *
 * Wire shape: GET /api/companies/:id/daily-briefs/latest → { briefDate, payload }.
 * 404 is the empty state, NOT an error — surface as a quiet "no brief yet"
 * line per the calm-surfaces shell convention.
 *
 * Loading: PageSkeleton variant=list keeps motion budget aligned with the
 * rest of /today's left-rail surfaces.
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import {
  dailyBriefsApi,
  type DailyBriefPayload,
  type LatestDailyBriefResponse,
} from "../api/daily-briefs";
import { ApiError } from "../api/client";

interface DailyBriefViewProps {
  companyId: string;
  /**
   * Heading level for the section title. /today already renders an h1 for
   * the greeting; the brief lives under it as an h2.
   */
  headingLevel?: "h2" | "h3";
}

export function DailyBriefView({
  companyId,
  headingLevel = "h2",
}: DailyBriefViewProps) {
  const { data, isLoading, error } = useQuery<
    LatestDailyBriefResponse,
    ApiError | Error
  >({
    queryKey: ["daily-briefs", "latest", companyId],
    queryFn: () => dailyBriefsApi.latest(companyId),
    // 404 is the "no brief yet" empty state — don't retry it.
    retry: (failureCount, err) => {
      if (err instanceof ApiError && err.status === 404) return false;
      return failureCount < 2;
    },
    enabled: Boolean(companyId),
  });

  const Heading = headingLevel;
  const headingClasses =
    "text-[11px] font-semibold uppercase tracking-wider text-muted-foreground";

  if (isLoading) {
    return (
      <section
        aria-labelledby="daily-brief-view-heading"
        data-testid="daily-brief-view"
        data-state="loading"
      >
        <Heading id="daily-brief-view-heading" className={headingClasses}>
          Today's brief
        </Heading>
        <div className="mt-3 space-y-2" aria-hidden="true">
          <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
          <div className="h-4 w-5/6 animate-pulse rounded bg-muted" />
          <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
        </div>
      </section>
    );
  }

  // 404 → empty state. Any other error → surface inline so the founder can
  // grep server logs by requestId if it's something real.
  if (error) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <section
          aria-labelledby="daily-brief-view-heading"
          data-testid="daily-brief-view"
          data-state="empty"
        >
          <Heading id="daily-brief-view-heading" className={headingClasses}>
            Today's brief
          </Heading>
          <p className="mt-3 text-sm text-muted-foreground">
            No brief today.
          </p>
        </section>
      );
    }
    return (
      <section
        aria-labelledby="daily-brief-view-heading"
        data-testid="daily-brief-view"
        data-state="error"
      >
        <Heading id="daily-brief-view-heading" className={headingClasses}>
          Today's brief
        </Heading>
        <p className="mt-3 text-sm text-destructive">
          {error.message}
          {error instanceof ApiError && error.requestId ? (
            <span className="ml-1 text-xs text-muted-foreground">
              (request {error.requestId})
            </span>
          ) : null}
        </p>
      </section>
    );
  }

  if (!data) {
    return null;
  }

  return (
    <section
      aria-labelledby="daily-brief-view-heading"
      data-testid="daily-brief-view"
      data-state="ready"
    >
      <div className="flex items-baseline justify-between gap-3">
        <Heading id="daily-brief-view-heading" className={headingClasses}>
          Today's brief
        </Heading>
        <p className="text-[11px] text-muted-foreground">{data.briefDate}</p>
      </div>

      <BriefSections payload={data.payload} />
    </section>
  );
}

function BriefSections({ payload }: { payload: DailyBriefPayload }) {
  return (
    <div className="mt-3 space-y-6">
      {/* Headline — always present per the DailyBriefPayload contract. */}
      <p
        className="max-w-prose text-base leading-relaxed text-foreground"
        data-testid="daily-brief-headline"
      >
        {payload.headline}
      </p>

      {payload.kpiMovements.length > 0 && (
        <SubSection title="KPI movements">
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[480px] text-left text-sm">
              <thead className="bg-muted/30 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Metric</th>
                  <th className="px-3 py-2 font-medium">From</th>
                  <th className="px-3 py-2 font-medium">To</th>
                  <th className="px-3 py-2 font-medium">Δ</th>
                </tr>
              </thead>
              <tbody>
                {payload.kpiMovements.map((k, i) => (
                  <tr
                    key={`${k.metric}-${i}`}
                    className="border-t border-border"
                  >
                    <td className="px-3 py-2 font-medium">{k.metric}</td>
                    <td className="px-3 py-2">{k.from}</td>
                    <td className="px-3 py-2">{k.to}</td>
                    <td className="px-3 py-2">{k.delta}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SubSection>
      )}

      {payload.blockers.length > 0 && (
        <SubSection title="Blockers">
          <ul className="space-y-2">
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
        </SubSection>
      )}

      {payload.opportunities.length > 0 && (
        <SubSection title="Opportunities">
          <ul className="space-y-2">
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
        </SubSection>
      )}

      {payload.anomalies.length > 0 && (
        <SubSection title="Anomalies">
          <ul className="space-y-2">
            {payload.anomalies.map((a, i) => (
              <li
                key={`${a.insightId}-${i}`}
                className="flex items-start justify-between gap-3 rounded-md border border-border bg-card p-3 text-sm"
              >
                <span>{a.title}</span>
                <Link
                  to={`/insights?id=${encodeURIComponent(a.insightId)}`}
                  className="shrink-0 text-xs text-primary hover:underline"
                >
                  view insight
                </Link>
              </li>
            ))}
          </ul>
        </SubSection>
      )}

      {payload.topThreeActions.length > 0 && (
        <SubSection title="Top 3 actions">
          <ol className="space-y-2">
            {payload.topThreeActions.map((a, i) => (
              <li
                key={i}
                className="rounded-md border border-border bg-card p-3 text-sm"
              >
                <p className="font-medium">
                  <span className="mr-1.5 text-muted-foreground">{i + 1}.</span>
                  {a.action}
                </p>
                <p className="mt-1 text-muted-foreground">{a.rationale}</p>
                {a.approvalId ? (
                  <Link
                    to={`/approvals/${a.approvalId}`}
                    className="mt-2 inline-block text-xs text-primary hover:underline"
                  >
                    review approval →
                  </Link>
                ) : null}
              </li>
            ))}
          </ol>
        </SubSection>
      )}
    </div>
  );
}

function SubSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div className="mt-2">{children}</div>
    </div>
  );
}
