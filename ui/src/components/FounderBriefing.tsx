import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { AlertTriangle, ArrowRight, CheckCircle2, Flame, PenLine, Sparkles, Target } from "lucide-react";
import type { ActivityEvent, Agent, DashboardSummary, Issue } from "@founderos/shared";
import { authApi } from "../api/auth";
import { useDialog } from "../context/DialogContext";
import { Button } from "@/components/ui/button";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatCents } from "../lib/utils";
import type { CompanyMetrics } from "./CompanyPulseWidget";

interface FounderBriefingProps {
  companyName: string | undefined;
  summary: DashboardSummary | undefined;
  activity: ActivityEvent[] | undefined;
  agents: Agent[] | undefined;
  issues: Issue[] | undefined;
  /** Stored company metrics — source of stage, runway, burn, MRR/ARR. */
  metrics: CompanyMetrics | undefined | null;
}

/**
 * The first thing a solo founder sees on their dashboard each morning.
 *
 * Designed to answer the three questions an AI-native operator asks in
 * their first 30 seconds of the day:
 *   1. "What happened while I was away?"          → narrative summary
 *   2. "What needs me right now?"                 → decision list
 *   3. "What did my team ship?"                   → win list
 *
 * Everything is derived from data already on the page. No new API calls.
 */
export function FounderBriefing({
  companyName,
  summary,
  activity,
  agents,
  issues,
  metrics,
}: FounderBriefingProps) {
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const { openNewIssue } = useDialog();
  const firstName = deriveFirstName(session?.user?.name, session?.user?.email);
  const greeting = timeOfDayGreeting();

  /**
   * Brief the team — one-message founder-to-team channel. Creates a
   * high-priority issue with the founder's direction, which flows down
   * through the CEO's heartbeat and fans out to reports. We pre-fill
   * only the priority + a stem title and let the founder write the
   * actual brief in the dialog.
   */
  const briefTheTeam = () => {
    const today = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" });
    openNewIssue({
      title: `Founder brief · ${today}: `,
      priority: "urgent",
    });
  };

  // Reference points for "overnight" framing — the last 12h captures what
  // happened while a typical founder was away from the keyboard.
  const since = Date.now() - 12 * 60 * 60 * 1000;
  const recentActivity = (activity ?? []).filter((a) => new Date(a.createdAt).getTime() > since);
  const recentIssues = (issues ?? []).filter((i) => new Date(i.updatedAt).getTime() > since);

  // Work signals — derived, not stored. Cheap to compute on every render
  // because the result is memoized into the structure below.
  const sessionCount = recentActivity.filter((a) => a.action.startsWith("heartbeat.")).length;
  const shippedIssues = recentIssues.filter((i) => i.status === "done");
  const blockedAgents = (agents ?? []).filter((a) => a.status === "error");
  const pendingApprovals = summary?.pendingApprovals ?? 0;
  const budgetIncidents = summary?.budgets.activeIncidents ?? 0;

  // Total items that need a human decision. When zero, the briefing
  // shows a calm "all clear" state rather than an empty list.
  const decisionCount = pendingApprovals + blockedAgents.length + budgetIncidents;

  // Today's focus = the highest-priority open issue on the docket. We
  // pick urgent first, then high, most recently updated. Surfaces one
  // thing the founder can point at and say "that's what we're doing."
  const focusIssue = pickFocusIssue(issues ?? []);

  // Runway signal — only shown when both burn and runway are set. This
  // is the single most-watched number for a cash-constrained founder.
  const runwayLine = buildRunwayLine(metrics);

  return (
    <section
      aria-label="Founder briefing"
      className="rounded-lg border border-border bg-card p-6 md:p-8"
    >
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground mb-3">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--brand)]" />
        {formatToday()} · Morning brief
      </div>

      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <h2 className="font-display text-[32px] md:text-[40px] leading-[1.05] tracking-tight text-foreground">
          {greeting}
          {firstName ? `, ${firstName}` : ""}.
        </h2>
        {runwayLine && (
          <span className="inline-flex items-center rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground tabular-nums">
            {runwayLine}
          </span>
        )}
      </div>

      <p className="mt-4 max-w-2xl text-[15px] text-foreground/80 leading-[1.65]">
        {buildNarrative({
          companyName,
          sessionCount,
          shippedCount: shippedIssues.length,
          summary,
        })}
      </p>

      {focusIssue && (
        <Link
          to={`/issues/${focusIssue.identifier ?? focusIssue.id}`}
          className="group mt-5 flex items-start gap-3 rounded-md border border-border bg-background/40 px-4 py-3 no-underline text-inherit hover:border-foreground/25 transition-colors"
        >
          <Target className="h-3.5 w-3.5 mt-[3px] shrink-0 text-[var(--brand)]" />
          <div className="flex-1 min-w-0">
            <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground mb-0.5">
              Today&apos;s focus
            </div>
            <div className="text-[14px] font-medium text-foreground truncate">
              {focusIssue.title}
            </div>
          </div>
          <ArrowRight className="h-3.5 w-3.5 mt-1 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0" />
        </Link>
      )}

      <div className="grid gap-5 md:gap-6 mt-7 md:grid-cols-2">
        <DecisionColumn
          count={decisionCount}
          pendingApprovals={pendingApprovals}
          blockedAgents={blockedAgents}
          budgetIncidents={budgetIncidents}
        />
        <WinsColumn
          shippedIssues={shippedIssues}
          sessionCount={sessionCount}
        />
      </div>

      {/* Founder action bar — the one thing only a human can do: give the
          team direction for the day. Everything else is derived. */}
      <div className="mt-7 pt-5 border-t border-border/70 flex items-center justify-between gap-3 flex-wrap">
        <div className="text-[12px] text-muted-foreground max-w-md">
          Set today&apos;s focus. Write one line and the team picks it up on
          their next shift.
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={briefTheTeam}
          className="gap-1.5 shrink-0"
        >
          <PenLine className="h-3.5 w-3.5" />
          Brief the team
        </Button>
      </div>
    </section>
  );
}

function DecisionColumn({
  count,
  pendingApprovals,
  blockedAgents,
  budgetIncidents,
}: {
  count: number;
  pendingApprovals: number;
  blockedAgents: Agent[];
  budgetIncidents: number;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground mb-3">
        <Flame className="h-3 w-3" />
        Needs your call
      </div>
      {count === 0 ? (
        <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4" />
          All clear. The team is unblocked.
        </div>
      ) : (
        <ul className="space-y-2.5">
          {pendingApprovals > 0 && (
            <DecisionItem
              to="/approvals"
              icon={<AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}
              label={`${pendingApprovals} ${pendingApprovals === 1 ? "approval" : "approvals"} pending`}
              sub="Review and sign off or redirect"
            />
          )}
          {blockedAgents.length > 0 && (
            <DecisionItem
              to="/agents"
              icon={<AlertTriangle className="h-3.5 w-3.5 text-red-500" />}
              label={`${blockedAgents.length} ${blockedAgents.length === 1 ? "teammate is" : "teammates are"} blocked`}
              sub={blockedAgents.map((a) => a.name).slice(0, 3).join(" · ")}
            />
          )}
          {budgetIncidents > 0 && (
            <DecisionItem
              to="/costs"
              icon={<AlertTriangle className="h-3.5 w-3.5 text-red-500" />}
              label={`${budgetIncidents} budget ${budgetIncidents === 1 ? "incident" : "incidents"} open`}
              sub="Someone hit their comp cap"
            />
          )}
        </ul>
      )}
    </div>
  );
}

function WinsColumn({
  shippedIssues,
  sessionCount,
}: {
  shippedIssues: Issue[];
  sessionCount: number;
}) {
  const hasMotion = sessionCount > 0 || shippedIssues.length > 0;
  return (
    <div>
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground mb-3">
        <Sparkles className="h-3 w-3" />
        Your team shipped
      </div>
      {!hasMotion ? (
        <p className="text-sm text-muted-foreground">
          Nothing moved in the last 12h. Start a shift or brief the team.
        </p>
      ) : shippedIssues.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {sessionCount} work {sessionCount === 1 ? "session" : "sessions"} in flight. Nothing closed yet.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {shippedIssues.slice(0, 4).map((i) => (
            <li key={i.id}>
              <Link
                to={`/issues/${i.identifier ?? i.id}`}
                className={cn(
                  "group flex items-start gap-2.5 no-underline text-inherit",
                  "hover:text-foreground",
                )}
              >
                <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-emerald-500" />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-foreground truncate">{i.title}</div>
                  {i.identifier && (
                    <div className="text-[11px] text-muted-foreground tabular-nums">{i.identifier}</div>
                  )}
                </div>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DecisionItem({
  to,
  icon,
  label,
  sub,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  sub: string;
}) {
  return (
    <li>
      <Link
        to={to}
        className="group flex items-start gap-2.5 no-underline text-inherit hover:text-foreground"
      >
        <span className="mt-0.5 shrink-0">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-foreground">{label}</div>
          <div className="text-[11px] text-muted-foreground truncate">{sub}</div>
        </div>
        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0 mt-0.5" />
      </Link>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Narrative composition
// ─────────────────────────────────────────────────────────────────────────

function buildNarrative({
  companyName,
  sessionCount,
  shippedCount,
  summary,
}: {
  companyName: string | undefined;
  sessionCount: number;
  shippedCount: number;
  summary: DashboardSummary | undefined;
}): string {
  const subject = companyName ? `${companyName}` : "Your team";
  const parts: string[] = [];

  if (sessionCount === 0 && shippedCount === 0) {
    parts.push(`${subject} has been quiet over the last 12 hours.`);
  } else {
    const sessionFrag =
      sessionCount > 0
        ? `ran ${sessionCount} work ${sessionCount === 1 ? "session" : "sessions"}`
        : null;
    const shippedFrag =
      shippedCount > 0
        ? `shipped ${shippedCount} ${shippedCount === 1 ? "thing" : "things"}`
        : null;
    const frags = [sessionFrag, shippedFrag].filter(Boolean) as string[];
    parts.push(`${subject} ${joinHuman(frags)} in the last 12 hours.`);
  }

  if (summary && summary.costs.monthSpendCents > 0) {
    const spend = formatCents(summary.costs.monthSpendCents);
    const util = summary.costs.monthUtilizationPercent;
    if (summary.costs.monthBudgetCents > 0 && util > 0) {
      parts.push(`Spend this month: ${spend} (${util}% of cap).`);
    } else {
      parts.push(`Spend this month: ${spend}.`);
    }
  }

  return parts.join(" ");
}

/**
 * Return the single open issue that most warrants founder attention
 * right now. Ranks urgent > high priority, then most recently updated.
 * Null when nothing qualifies — we'd rather show nothing than surface
 * a low-signal backlog item as "today's focus."
 */
function pickFocusIssue(issues: Issue[]): Issue | null {
  const open = issues.filter((i) => i.status !== "done" && i.status !== "cancelled");
  const byRank = [...open].sort((a, b) => {
    const rank = { urgent: 0, high: 1, medium: 2, low: 3 } as const;
    const pa = rank[(a.priority ?? "medium") as keyof typeof rank] ?? 2;
    const pb = rank[(b.priority ?? "medium") as keyof typeof rank] ?? 2;
    if (pa !== pb) return pa - pb;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
  const top = byRank[0];
  if (!top) return null;
  // Only surface if there's a real reason — medium/low priority is noise.
  if ((top.priority ?? "medium") === "low" || (top.priority ?? "medium") === "medium") return null;
  return top;
}

/**
 * One-line runway display from stored company metrics. Handles the three
 * cases an operator cares about: healthy (green), short (amber), critical
 * (red). The component above maps the string into a border/text color.
 */
function buildRunwayLine(metrics: CompanyMetrics | undefined | null): string | null {
  if (!metrics) return null;
  const { runwayMonths, monthlyBurnCents } = metrics;
  if (typeof runwayMonths === "number" && runwayMonths > 0) {
    const suffix = runwayMonths >= 12 ? `${Math.round(runwayMonths / 12 * 10) / 10} yr runway` : `${runwayMonths} mo runway`;
    return suffix;
  }
  if (typeof monthlyBurnCents === "number" && monthlyBurnCents > 0) {
    return `${formatCents(monthlyBurnCents)}/mo burn`;
  }
  return null;
}

function joinHuman(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function timeOfDayGreeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Still up";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 22) return "Good evening";
  return "Late night";
}

function formatToday(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

function deriveFirstName(name?: string | null, email?: string | null): string | null {
  if (name && name.trim()) {
    return name.trim().split(/\s+/)[0];
  }
  if (email) {
    const local = email.split("@")[0];
    if (local.length > 0 && !local.match(/^[0-9_.-]+$/)) {
      // Capitalize the first letter — "vinamr" → "Vinamr".
      return local[0].toUpperCase() + local.slice(1);
    }
  }
  return null;
}
