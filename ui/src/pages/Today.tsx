import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { authApi } from "../api/auth";
import { approvalsApi } from "../api/approvals";
import { dailyBriefsApi } from "../api/daily-briefs";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { DecisionBrief, type DecisionBriefData } from "../components/DecisionBrief";
import { PageSkeleton } from "../components/PageSkeleton";
import type { Approval } from "@founderos/shared";

/**
 * `/today` — the keystone of the Ask-First shell.
 *
 * Source spec: 02-calm-surfaces.md §A + 01-shell-revised.md §8.
 *
 * Layout (NO TABS — F-03 BLOCK collapse):
 *   1. Greeting line ("Hi, {firstName}.") — same all day, every day (F-15).
 *   2. Subheading with decision count.
 *   3. Decision list (max-w-3xl, full-row clickable, routes to /approvals/:id).
 *   4. Inline daily brief (below the decision list, not tabbed).
 *   5. Friday-only inline weekly link (on non-Fridays the section is unrendered).
 *
 * What's NOT here (intentionally):
 *   - Activity tab (moved to /library/audit in Wave 3, F-13).
 *   - Right-rail "Today's Decision Briefs" (one hero, no rail).
 *   - "What we shipped yesterday" widget (rolls into the brief in Wave 4).
 *
 * Empty states are quiet sentences per §9 (no CTA walls).
 */
export function Today() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Today" }]);
  }, [setBreadcrumbs]);

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  const { data: pendingApprovals = [], isLoading: approvalsLoading } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!, "pending"),
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
  });

  // Today brief — fetch the most recent. We don't trigger generation
  // here; the "Generate one →" affordance handles that.
  // Query key matches existing convention in DailyBrief.tsx (inline array,
  // not from the queryKeys helper).
  const { data: briefsList } = useQuery({
    queryKey: ["daily-briefs", selectedCompanyId ?? "none"],
    queryFn: () => dailyBriefsApi.list(selectedCompanyId!, 1, 0),
    enabled: !!selectedCompanyId,
  });
  const todayBrief = briefsList?.briefs?.[0] ?? null;

  const decisions = useMemo<DecisionBriefData[]>(
    () =>
      pendingApprovals
        .filter((a) => a.status === "pending" || a.status === "revision_requested")
        .map(toDecisionBrief),
    [pendingApprovals],
  );

  const firstName = resolveFirstName(session?.user?.name ?? session?.user?.email ?? null);
  const greeting = `Hi, ${firstName}.`;
  const subheading = buildSubheading(decisions.length);
  const isColdStart = !approvalsLoading && decisions.length === 0 && todayBrief === null;
  const isFriday = new Date().getDay() === 5;

  if (approvalsLoading) {
    return (
      <div className="mx-auto max-w-3xl py-10">
        <PageSkeleton />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-2 py-10 md:px-0">
      <header>
        <h1
          className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl"
          data-testid="today-greeting"
        >
          {greeting}
        </h1>
        <p
          className="mt-1 text-sm text-muted-foreground md:text-base"
          data-testid="today-subheading"
        >
          {subheading}
        </p>
      </header>

      {decisions.length > 0 && (
        <section
          aria-label="Decisions awaiting your call"
          className="mt-6 overflow-hidden rounded-lg border border-border"
        >
          {decisions.map((decision, idx) => (
            <div
              key={decision.id}
              className={idx > 0 ? "border-t border-border" : undefined}
            >
              <DecisionBrief decision={decision} />
            </div>
          ))}
        </section>
      )}

      {isColdStart && (
        <ColdStartHint />
      )}

      <section
        id="brief"
        aria-labelledby="today-brief-heading"
        className="mt-12 border-t border-border pt-6"
      >
        <h2
          id="today-brief-heading"
          className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          Today's brief
        </h2>
        {todayBrief ? (
          <div className="mt-3">
            {todayBrief.payload?.headline && (
              <p className="max-w-prose text-sm leading-relaxed text-foreground">
                {todayBrief.payload.headline}
              </p>
            )}
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            No brief today. <span className="text-foreground underline-offset-2 hover:underline">Generate one →</span>
          </p>
        )}
      </section>

      {isFriday && (
        <section
          id="weekly"
          aria-labelledby="today-weekly-heading"
          className="mt-10 border-t border-border pt-6"
        >
          <h2
            id="today-weekly-heading"
            className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            This week
          </h2>
          <p className="mt-3 text-sm text-muted-foreground">
            <a href="#weekly" className="text-foreground underline-offset-2 hover:underline">
              Read this week's wrap →
            </a>
          </p>
        </section>
      )}
    </div>
  );
}

/**
 * Cold-start hint per 02-calm-surfaces.md §F + 01-shell-revised.md §8.7.
 *
 * F-05 corrected the original spec's example sentence — "Find why signups
 * dropped this week" implied a fresh instance had data already. The Charter
 * example is something the team can actually produce on day 1.
 */
function ColdStartHint() {
  return (
    <div className="mt-6 rounded-lg border border-dashed border-border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
      Nothing's waiting on you. Brief the team or ask a question — try{" "}
      <span className="font-medium text-foreground">"Draft our company charter."</span>
    </div>
  );
}

function resolveFirstName(rawName: string | null): string {
  if (!rawName) return "there";
  // Strip email domain if it's an email.
  const trimmed = rawName.includes("@") ? rawName.split("@")[0]! : rawName;
  const first = trimmed.split(/\s+/)[0]?.trim();
  if (!first) return "there";
  // Title-case the first letter for friendly display.
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function buildSubheading(count: number): string {
  if (count === 0) return "Nothing's waiting on you.";
  if (count === 1) return "1 thing needs your call today.";
  return `${count} things need your call today.`;
}

function toDecisionBrief(approval: Approval): DecisionBriefData {
  // Approval -> DecisionBrief mapping. The Approval payload is a free-form
  // record; we try a few common shapes for the title field, then fall back
  // to a verb-voiced default. Priority defaults to medium until a real
  // risk-level signal exists in the schema (Wave 2-3 will revisit when the
  // server adds explicit risk classification).
  const payload = approval.payload as Record<string, unknown> | null;
  const rawTitle =
    (payload?.title as string | undefined) ||
    (payload?.summary as string | undefined) ||
    (payload?.headline as string | undefined);
  const title = rawTitle?.trim() || "Decision awaiting your call";
  return {
    id: approval.id,
    priority: "medium",
    title,
    href: `/approvals/${approval.id}`,
  };
}
