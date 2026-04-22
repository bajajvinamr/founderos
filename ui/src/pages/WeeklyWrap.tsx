import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { weeklyWrapsApi, type WeeklyWrap as StoredWeeklyWrap } from "../api/weekly-wraps";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialog } from "../context/DialogContext";
import { queryKeys } from "../lib/queryKeys";
import { formatCents } from "../lib/utils";
import {
  startOfWeek,
  weekRangeLabel,
  pickHeadline,
  WeekStatCards,
  ShippedSection,
  buildStuckItems,
  StuckSection,
  TeamSection,
  buildSpendSegments,
  SpendBreakdownBar,
  buildDecisionCards,
  DecisionCards,
  deriveWeekSpendCents,
  deriveWeekShifts,
  type TeamMemberStats,
} from "../components/WeeklyWrapSections";
import type { Agent } from "@founderos/shared";
import type { CompanyMetrics } from "../components/CompanyPulseWidget";

export function WeeklyWrap() {
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewIssue } = useDialog();
  const queryClient = useQueryClient();
  const [nextWeekBrief, setNextWeekBrief] = useState("Next week, let's focus on…");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Stored wraps (Wave 18B) — the auto-delivery cron writes here every Friday 5pm.
  const { data: storedWraps } = useQuery({
    queryKey: ["weekly-wraps", selectedCompanyId ?? "none"],
    queryFn: () => weeklyWrapsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const generateNow = useMutation({
    mutationFn: () => weeklyWrapsApi.generateNow(selectedCompanyId!),
    onSuccess: () => {
      if (selectedCompanyId) {
        void queryClient.invalidateQueries({
          queryKey: ["weekly-wraps", selectedCompanyId],
        });
      }
    },
  });

  const currentStoredWrap: StoredWeeklyWrap | null = useMemo(() => {
    if (!storedWraps || storedWraps.length === 0) return null;
    // API returns newest first.
    return storedWraps[0];
  }, [storedWraps]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Weekly wrap" }]);
  }, [setBreadcrumbs]);

  const { data: summary } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

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

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: pendingApprovals = [] } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!, "pending"),
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
  });

  // ── Derived data ────────────────────────────────────────────────────────

  const weekStart = useMemo(() => startOfWeek(), []);
  const weekStartMs = weekStart.getTime();

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const weekShifts = useMemo(
    () => deriveWeekShifts(activity ?? [], weekStart),
    [activity, weekStart],
  );

  const weekSpendCents = useMemo(
    () => deriveWeekSpendCents(activity ?? [], weekStart),
    [activity, weekStart],
  );

  // Issues shipped this week (status=done, updatedAt within week)
  const shippedIssues = useMemo(
    () =>
      (issues ?? [])
        .filter(
          (i) =>
            i.status === "done" &&
            new Date(i.updatedAt).getTime() >= weekStartMs,
        )
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        ),
    [issues, weekStartMs],
  );

  // Open high/critical issues for next week
  const openHighPriority = useMemo(
    () =>
      (issues ?? []).filter(
        (i) =>
          i.status !== "done" &&
          i.status !== "cancelled" &&
          (i.priority === "critical" || i.priority === "high"),
      ).length,
    [issues],
  );

  // Stuck: error agents + stale in-progress issues
  const stuckItems = useMemo(
    () => buildStuckItems(agents ?? [], issues ?? []),
    [agents, issues],
  );

  // Per-teammate stats for agents active this week
  const teamStats = useMemo((): TeamMemberStats[] => {
    if (!agents || !activity) return [];

    // Shifts per agent this week
    const shiftsByAgent = new Map<string, number>();
    for (const event of activity) {
      if (
        new Date(event.createdAt).getTime() < weekStartMs ||
        !event.action.startsWith("heartbeat.")
      ) {
        continue;
      }
      const agentId = event.agentId;
      if (!agentId) continue;
      shiftsByAgent.set(agentId, (shiftsByAgent.get(agentId) ?? 0) + 1);
    }

    // Closed issues per agent this week
    const closedByAgent = new Map<string, number>();
    for (const issue of shippedIssues) {
      if (!issue.assigneeAgentId) continue;
      closedByAgent.set(
        issue.assigneeAgentId,
        (closedByAgent.get(issue.assigneeAgentId) ?? 0) + 1,
      );
    }

    // Spend per agent this week from cost.recorded events
    const spentByAgent = new Map<string, number>();
    for (const event of activity) {
      if (new Date(event.createdAt).getTime() < weekStartMs) continue;
      if (event.action !== "cost.recorded") continue;
      const agentId = event.agentId;
      if (!agentId) continue;
      const cents =
        typeof event.details?.cents === "number" ? event.details.cents : 0;
      const fromUsd =
        typeof event.details?.costUsd === "number"
          ? Math.round(event.details.costUsd * 100)
          : 0;
      spentByAgent.set(agentId, (spentByAgent.get(agentId) ?? 0) + cents + fromUsd);
    }

    return agents
      .filter((a) => (shiftsByAgent.get(a.id) ?? 0) > 0)
      .map((a) => ({
        agent: a,
        shifts: shiftsByAgent.get(a.id) ?? 0,
        closed: closedByAgent.get(a.id) ?? 0,
        spentCents: spentByAgent.get(a.id) ?? 0,
      }))
      .sort((a, b) => b.shifts - a.shifts);
  }, [agents, activity, shippedIssues, weekStartMs]);

  const spendSegments = useMemo(
    () => buildSpendSegments(teamStats),
    [teamStats],
  );

  // Charter from company metrics (same as Dashboard pattern)
  const selectedCompany = companies?.find((c) => c.id === selectedCompanyId);
  const companyMetrics = (selectedCompany as { metrics?: unknown } | undefined)
    ?.metrics as CompanyMetrics | undefined;
  const charter = companyMetrics?.charter ?? null;

  const decisionCards = useMemo(
    () =>
      buildDecisionCards(
        issues ?? [],
        pendingApprovals,
        shippedIssues.length,
        charter,
      ),
    [issues, pendingApprovals, shippedIssues.length, charter],
  );

  // ── Sub-line narrative ──────────────────────────────────────────────────
  const subLine = buildSubLine(weekShifts, shippedIssues.length, weekSpendCents);

  // ── Submit brief ────────────────────────────────────────────────────────
  function submitBrief() {
    const title = nextWeekBrief.trim();
    if (!title || title === "Next week, let's focus on…") return;
    openNewIssue({ title, priority: "critical" });
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-[800px] space-y-10 px-4 py-8">
      {/* ── Editorial header ── */}
      <div>
        <div className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground mb-3">
          WEEK OF {weekRangeLabel()}
        </div>
        <h1 className="font-display text-[40px] md:text-[52px] leading-[1.05] tracking-tight text-foreground">
          {pickHeadline(shippedIssues.length)}
        </h1>
        <p className="mt-3 text-[15px] text-foreground/75 leading-[1.65] max-w-prose">
          {subLine}
        </p>
      </div>

      <Divider />

      {/* ── Section 0: CoS narrative (Wave 18B) ── */}
      <Section title="Chief of Staff narrative">
        {currentStoredWrap ? (
          <StoredWrapView wrap={currentStoredWrap} />
        ) : (
          <div className="rounded-lg border border-dashed border-border bg-card p-5">
            <p className="text-[14px] text-foreground/70 leading-[1.6]">
              No wrap written yet for this week. The Chief of Staff auto-writes
              one every Friday at 5pm and posts it to Slack + email. Want it
              now?
            </p>
            <div className="mt-3 flex justify-end">
              <button
                disabled={!selectedCompanyId || generateNow.isPending}
                onClick={() => generateNow.mutate()}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-[13px] font-medium text-foreground hover:border-foreground/30 hover:bg-accent/40 transition-colors disabled:opacity-50"
              >
                {generateNow.isPending ? "Writing…" : "Generate now"}
              </button>
            </div>
            {generateNow.isError ? (
              <p className="mt-2 text-[12px] text-destructive">
                Couldn't generate the wrap. Check your Anthropic API key in
                Instance → Providers.
              </p>
            ) : null}
          </div>
        )}
      </Section>

      <Divider />

      {/* ── Section 1: The numbers ── */}
      <Section title="The numbers">
        <WeekStatCards
          shifts={weekShifts}
          shipped={shippedIssues.length}
          weekSpendCents={weekSpendCents}
          openHighPriority={openHighPriority}
        />
      </Section>

      <Divider />

      {/* ── Section 2: What shipped ── */}
      <Section title="What shipped">
        <ShippedSection issues={shippedIssues} agentMap={agentMap} />
      </Section>

      <Divider />

      {/* ── Section 3: What's stuck ── */}
      <Section title="What's stuck">
        <StuckSection items={stuckItems} />
      </Section>

      <Divider />

      {/* ── Section 4: Team by the numbers ── */}
      <Section title="Team by the numbers">
        <TeamSection members={teamStats} />
      </Section>

      {/* ── Section 5: Company spend breakdown ── */}
      {spendSegments.length > 0 && (
        <>
          <Divider />
          <Section title="Spend breakdown">
            <SpendBreakdownBar segments={spendSegments} />
          </Section>
        </>
      )}

      <Divider />

      {/* ── Section 6: Next week — 3 decisions ── */}
      <Section title="Next week — 3 things to decide">
        <DecisionCards cards={decisionCards} />
      </Section>

      <Divider />

      {/* ── Section 7: Brief for next week ── */}
      <Section title="One-line brief for next week">
        <div className="rounded-lg border border-border bg-card p-5">
          <textarea
            ref={textareaRef}
            value={nextWeekBrief}
            onChange={(e) => setNextWeekBrief(e.target.value)}
            onFocus={() => {
              if (nextWeekBrief === "Next week, let's focus on…") {
                setNextWeekBrief("");
              }
            }}
            onBlur={() => {
              if (!nextWeekBrief.trim()) {
                setNextWeekBrief("Next week, let's focus on…");
              }
            }}
            rows={2}
            className="w-full resize-none bg-transparent text-[14px] text-foreground placeholder:text-muted-foreground outline-none leading-[1.6]"
            placeholder="Next week, let's focus on…"
          />
          <div className="mt-3 flex justify-end">
            <button
              onClick={submitBrief}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-[13px] font-medium text-foreground hover:border-foreground/30 hover:bg-accent/40 transition-colors"
            >
              Brief the team
            </button>
          </div>
        </div>
      </Section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Local helpers
// ─────────────────────────────────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="font-display text-[22px] md:text-[26px] leading-snug text-foreground mb-4">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Divider() {
  return <hr className="border-t border-border/60" />;
}

function StoredWrapView({ wrap }: { wrap: StoredWeeklyWrap }) {
  const paragraphs = wrap.narrative
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const weekEnding = new Date(wrap.weekEndingAt);
  const dateLabel = weekEnding.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const deliveryBits: string[] = [];
  if (wrap.deliveredToSlackAt) deliveryBits.push("Posted to Slack");
  if (wrap.deliveredToEmailAt) deliveryBits.push("Emailed to the team");
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground mb-2">
        Week ending {dateLabel}
      </div>
      <div className="space-y-3 text-[14px] text-foreground/90 leading-[1.7]">
        {paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
      {wrap.highlights.length > 0 ? (
        <div className="mt-4 border-t border-border pt-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.15em] text-muted-foreground mb-2">
            Highlights
          </div>
          <ul className="space-y-1 text-[13px] text-foreground/80">
            {wrap.highlights.map((h, i) => (
              <li key={i} className="leading-[1.5]">
                · {h.title}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {deliveryBits.length > 0 ? (
        <div className="mt-3 text-[11px] text-muted-foreground">
          {deliveryBits.join(" · ")}
        </div>
      ) : null}
    </div>
  );
}

function buildSubLine(
  shifts: number,
  shipped: number,
  spendCents: number,
): string {
  const parts: string[] = [`Your team ran ${shifts} shift${shifts !== 1 ? "s" : ""}`];
  if (shipped > 0) {
    parts.push(`shipped ${shipped} thing${shipped !== 1 ? "s" : ""}`);
  }
  if (spendCents > 0) {
    parts.push(`spent ${formatCents(spendCents)}`);
  }
  const joined =
    parts.length === 1
      ? parts[0]
      : parts.length === 2
        ? `${parts[0]}, ${parts[1]}`
        : `${parts[0]}, ${parts[1]}, and ${parts[2]}`;
  return `${joined}. Here's what actually moved.`;
}
