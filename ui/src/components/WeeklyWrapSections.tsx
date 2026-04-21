import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Link } from "@/lib/router";
import type { Agent, ActivityEvent, Issue } from "@founderos/shared";
import type { Approval } from "@founderos/shared";
import { cn, formatCents } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** Monday 00:00:00.000 of the current week in local time. */
export function startOfWeek(): Date {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon…
  const diff = day === 0 ? -6 : 1 - day; // offset so Monday = 0
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

/** "APR 14–20" style range label. */
export function weekRangeLabel(): string {
  const mon = startOfWeek();
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" }).toUpperCase();
  // Format: "APR 14–20"
  const monStr = fmt(mon);
  const sunDay = sun.getDate();
  return `${monStr}–${sunDay}`;
}

export function pickHeadline(shippedCount: number): string {
  if (shippedCount > 5) return "A strong week.";
  if (shippedCount <= 2) return "Quiet week.";
  return "The week in review.";
}

// ─────────────────────────────────────────────────────────────────────────
// Section 1: Stat cards
// ─────────────────────────────────────────────────────────────────────────

interface WeekStatCardsProps {
  shifts: number;
  shipped: number;
  weekSpendCents: number;
  openHighPriority: number;
}

export function WeekStatCards({ shifts, shipped, weekSpendCents, openHighPriority }: WeekStatCardsProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <StatCard label="Shifts" value={shifts} />
      <StatCard label="Shipped" value={shipped} highlight={shipped > 0} />
      <StatCard label="Spend" value={formatCents(weekSpendCents)} />
      <StatCard label="Open next week" value={openHighPriority} muted={openHighPriority === 0} />
    </div>
  );
}

function StatCard({
  label,
  value,
  highlight,
  muted,
}: {
  label: string;
  value: string | number;
  highlight?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-4">
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground mb-2">
        {label}
      </div>
      <div
        className={cn(
          "font-display text-[28px] leading-none tabular-nums",
          highlight ? "text-emerald-600 dark:text-emerald-400" : "text-foreground",
          muted && "text-muted-foreground",
        )}
      >
        {value}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Section 2: What shipped
// ─────────────────────────────────────────────────────────────────────────

interface ShippedSectionProps {
  issues: Issue[];
  agentMap: Map<string, Agent>;
}

export function ShippedSection({ issues, agentMap }: ShippedSectionProps) {
  if (issues.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-2">
        Nothing closed this week. That&apos;s OK. Next week starts tomorrow.
      </p>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-border border border-border rounded-lg overflow-hidden">
      {issues.map((issue) => {
        const assignee = issue.assigneeAgentId ? agentMap.get(issue.assigneeAgentId) : null;
        return (
          <Link
            key={issue.id}
            to={`/issues/${issue.identifier ?? issue.id}`}
            className="group flex items-center gap-3 px-4 py-3 no-underline text-inherit hover:bg-accent/40 transition-colors"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium text-foreground truncate">{issue.title}</div>
              {assignee && (
                <div className="text-[11px] text-muted-foreground">{assignee.name}</div>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground tabular-nums shrink-0">
              {timeAgo(issue.updatedAt)}
            </div>
          </Link>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Section 3: What's stuck
// ─────────────────────────────────────────────────────────────────────────

interface StuckItem {
  id: string;
  description: string;
  linkLabel: string;
  linkTo: string;
}

export function buildStuckItems(agents: Agent[], issues: Issue[]): StuckItem[] {
  const items: StuckItem[] = [];
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  for (const agent of agents) {
    if (agent.status === "error") {
      items.push({
        id: `agent-${agent.id}`,
        description: `${agent.name} is blocked — status: error`,
        linkLabel: "Unblock →",
        linkTo: `/agents/${agent.urlKey ?? agent.id}`,
      });
    }
  }

  for (const issue of issues) {
    if (issue.status === "in_progress" && issue.startedAt) {
      const age = now - new Date(issue.startedAt).getTime();
      if (age > sevenDaysMs) {
        const ageDays = Math.floor(age / (24 * 60 * 60 * 1000));
        items.push({
          id: `issue-${issue.id}`,
          description: `"${issue.title}" — in progress for ${ageDays} days`,
          linkLabel: "Review →",
          linkTo: `/issues/${issue.identifier ?? issue.id}`,
        });
      }
    }
  }

  return items;
}

export function StuckSection({ items }: { items: StuckItem[] }) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-emerald-600 dark:text-emerald-400 py-2">
        Nothing stuck. Ship it.
      </p>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-border border border-border rounded-lg overflow-hidden">
      {items.map((item) => (
        <div key={item.id} className="flex items-center gap-3 px-4 py-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
          <div className="flex-1 min-w-0 text-[13px] text-foreground truncate">
            {item.description}
          </div>
          <Link
            to={item.linkTo}
            className="text-[12px] font-medium text-foreground/70 hover:text-foreground no-underline shrink-0"
          >
            {item.linkLabel}
          </Link>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Section 4: Team by the numbers
// ─────────────────────────────────────────────────────────────────────────

export interface TeamMemberStats {
  agent: Agent;
  shifts: number;
  closed: number;
  spentCents: number;
}

/** ROI chip: closed issues per dollar spent. */
function roiLabel(closed: number, spentCents: number): { label: string; tone: "emerald" | "muted" | "red" } {
  const dollars = spentCents / 100;
  if (dollars === 0) return { label: "no spend", tone: "muted" };
  const ratio = closed / dollars;
  if (ratio > 0.01) return { label: "pulling weight", tone: "emerald" };
  if (ratio > 0.001) return { label: "break-even", tone: "muted" };
  return { label: "underutilized", tone: "red" };
}

export function TeamSection({ members }: { members: TeamMemberStats[] }) {
  if (members.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-2">No teammate activity this week.</p>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-border border border-border rounded-lg overflow-hidden">
      {members.map(({ agent, shifts, closed, spentCents }) => {
        const roi = roiLabel(closed, spentCents);
        return (
          <div key={agent.id} className="flex items-center gap-4 px-4 py-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-foreground truncate">{agent.name}</span>
                {agent.role && (
                  <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground border border-border rounded px-1.5 py-0.5 shrink-0">
                    {agent.role}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-4 shrink-0 text-[12px] tabular-nums text-muted-foreground">
              <span title="Shifts">{shifts} shifts</span>
              <span title="Closed">{closed} closed</span>
              <span title="Spent">{formatCents(spentCents)}</span>
              <span
                className={cn(
                  "text-[10px] font-medium uppercase tracking-[0.1em] rounded px-1.5 py-0.5",
                  roi.tone === "emerald" && "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400",
                  roi.tone === "muted" && "bg-muted text-muted-foreground",
                  roi.tone === "red" && "bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-400",
                )}
              >
                {roi.label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Section 5: Spend breakdown bar
// ─────────────────────────────────────────────────────────────────────────

const CHART_COLORS = [
  "bg-violet-500",
  "bg-sky-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-rose-500",
  "bg-indigo-400",
  "bg-orange-400",
];

interface SpendSegment {
  label: string;
  cents: number;
  color: string;
}

export function buildSpendSegments(members: TeamMemberStats[]): SpendSegment[] {
  return members
    .filter((m) => m.spentCents > 0)
    .sort((a, b) => b.spentCents - a.spentCents)
    .map((m, i) => ({
      label: m.agent.name,
      cents: m.spentCents,
      color: CHART_COLORS[i % CHART_COLORS.length],
    }));
}

export function SpendBreakdownBar({ segments }: { segments: SpendSegment[] }) {
  const total = segments.reduce((s, seg) => s + seg.cents, 0);
  if (total === 0) return null;

  return (
    <div>
      {/* Stacked bar */}
      <div className="flex h-5 w-full overflow-hidden rounded-full">
        {segments.map((seg) => (
          <div
            key={seg.label}
            className={seg.color}
            style={{ width: `${(seg.cents / total) * 100}%` }}
            title={`${seg.label}: ${formatCents(seg.cents)}`}
          />
        ))}
      </div>
      {/* Legend */}
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
        {segments.map((seg) => (
          <div key={seg.label} className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <span className={cn("inline-block h-2.5 w-2.5 rounded-sm shrink-0", seg.color)} />
            {seg.label} — {formatCents(seg.cents)}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Section 6: Next week decisions
// ─────────────────────────────────────────────────────────────────────────

interface DecisionCardData {
  key: string;
  title: string;
  body: string;
  linkTo?: string;
  linkLabel?: string;
}

export function buildDecisionCards(
  issues: Issue[],
  pendingApprovals: Approval[],
  shippedCount: number,
  charter: string | null | undefined,
): DecisionCardData[] {
  const cards: DecisionCardData[] = [];

  // Card 1: top priority open issue
  const topIssue = issues
    .filter((i) => i.status !== "done" && i.status !== "cancelled")
    .sort((a, b) => {
      const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
      const pa = rank[(a.priority ?? "medium") as keyof typeof rank] ?? 2;
      const pb = rank[(b.priority ?? "medium") as keyof typeof rank] ?? 2;
      return pa - pb;
    })[0];

  if (topIssue) {
    cards.push({
      key: "top-issue",
      title: "Top open issue",
      body: topIssue.title,
      linkTo: `/issues/${topIssue.identifier ?? topIssue.id}`,
      linkLabel: "View issue →",
    });
  }

  // Card 2: pending approvals
  if (pendingApprovals.length > 0) {
    cards.push({
      key: "approvals",
      title: "Pending approvals",
      body: `${pendingApprovals.length} ${pendingApprovals.length === 1 ? "approval needs" : "approvals need"} your sign-off before work can proceed.`,
      linkTo: "/approvals",
      linkLabel: "Review approvals →",
    });
  }

  // Card 3: strategic question from charter
  const strategicBody = charter
    ? `You wrote: "${charter.slice(0, 120)}${charter.length > 120 ? "…" : ""}". This week the team shipped ${shippedCount} issue${shippedCount !== 1 ? "s" : ""}. Should next week shift focus or double down?`
    : `This week the team shipped ${shippedCount} issue${shippedCount !== 1 ? "s" : ""}. Is the current priority mix right for next week?`;

  cards.push({
    key: "strategic",
    title: "Strategic question",
    body: strategicBody,
  });

  return cards.slice(0, 3);
}

export function DecisionCards({ cards }: { cards: DecisionCardData[] }) {
  if (cards.length === 0) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {cards.map((card) => (
        <div key={card.key} className="rounded-lg border border-border bg-card px-4 py-4 flex flex-col gap-2">
          <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            {card.title}
          </div>
          <p className="text-[13px] text-foreground leading-[1.6] flex-1">{card.body}</p>
          {card.linkTo && card.linkLabel && (
            <Link to={card.linkTo} className="text-[12px] font-medium text-foreground/70 hover:text-foreground no-underline">
              {card.linkLabel}
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Derive week spend from activity events
// ─────────────────────────────────────────────────────────────────────────

/**
 * Sum cents from activity events of type "cost.recorded" within the current week.
 * Falls back to 0 if no such events exist.
 */
export function deriveWeekSpendCents(activity: ActivityEvent[], weekStart: Date): number {
  const weekStartMs = weekStart.getTime();
  let total = 0;
  for (const event of activity) {
    if (new Date(event.createdAt).getTime() < weekStartMs) continue;
    if (event.action === "cost.recorded") {
      const cents = event.details?.cents;
      if (typeof cents === "number") total += cents;
      // Also handle costUsd
      const costUsd = event.details?.costUsd;
      if (typeof costUsd === "number") total += Math.round(costUsd * 100);
    }
  }
  return total;
}

/**
 * Count shifts (heartbeat activity) within the current week.
 */
export function deriveWeekShifts(activity: ActivityEvent[], weekStart: Date): number {
  const weekStartMs = weekStart.getTime();
  return activity.filter(
    (a) =>
      new Date(a.createdAt).getTime() >= weekStartMs &&
      a.action.startsWith("heartbeat."),
  ).length;
}
