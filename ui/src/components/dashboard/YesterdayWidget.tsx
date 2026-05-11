import { useQuery } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { dashboardApi, type YesterdayOutcome } from "../../api/dashboard";

/**
 * Yesterday Widget (BL-022 / P8.b) — "What we shipped yesterday".
 *
 * Third P8 dashboard widget after TopBlockers (#173) and QuickWins (#173).
 * Surfaces 3-5 task completions from the last 24h, summarized into
 * founder-language one-liners by Claude Haiku via the server-side
 * `yesterday-summary` service.
 *
 * Render contract:
 *   - happy path → 3-5 outcomes with title + optional description
 *   - empty source (no completions in window) → reassuring empty state
 *   - loading → skeleton rows
 *   - error → silent graceful degradation (the widget is supportive, not
 *     load-bearing — a failed fetch shouldn't dominate the dashboard)
 */

interface YesterdayWidgetProps {
  companyId: string;
}

function yesterdayQueryKey(companyId: string) {
  return ["dashboard", "yesterday", companyId] as const;
}

/**
 * Pure renderer for the outcomes list — exported so tests can exercise the
 * projection without a QueryClient harness.
 */
export function renderOutcome(outcome: YesterdayOutcome): {
  id: string;
  title: string;
  description: string;
} {
  return {
    id: outcome.id,
    title: outcome.title.trim() || "Untitled completion",
    description: outcome.description.trim(),
  };
}

export function YesterdayWidget({ companyId }: YesterdayWidgetProps) {
  const { data, isLoading } = useQuery({
    queryKey: yesterdayQueryKey(companyId),
    queryFn: () => dashboardApi.yesterdaySummary(companyId),
    enabled: !!companyId,
    // Per-day cache key on the server matches the founder's mental model
    // ("today's wins"). On the client we keep this fresh for an hour —
    // enough to avoid hammering the endpoint on dashboard re-renders but
    // short enough that a manual page reload after a completion ships
    // an updated list within a few minutes once the server cache rolls.
    staleTime: 60 * 60 * 1000,
  });

  return (
    <section
      aria-label="What we shipped yesterday"
      className="rounded-md border border-border bg-card px-5 py-4"
    >
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
            What we shipped yesterday
          </p>
        </div>
        {data && data.outcomes.length > 0 ? (
          <span className="text-xs text-muted-foreground">
            {data.outcomes.length} win{data.outcomes.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <ul className="divide-y divide-border" data-testid="yesterday-loading">
          {[0, 1, 2].map((i) => (
            <li key={i} className="py-2.5">
              <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
              <div className="mt-1.5 h-2.5 w-1/2 animate-pulse rounded bg-muted/60" />
            </li>
          ))}
        </ul>
      ) : !data || data.outcomes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No completions yet — once your agents ship work, it&apos;ll show here.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {data.outcomes.map((outcome) => {
            const view = renderOutcome(outcome);
            return (
              <li key={view.id} className="py-2.5">
                <p className="text-sm font-medium text-foreground">
                  {view.title}
                </p>
                {view.description ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {view.description}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
