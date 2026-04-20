import { useSearchParams } from "@/lib/router";
import { Tabs } from "@/components/ui/tabs";
import { PageTabBar } from "@/components/PageTabBar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { useToast } from "../../context/ToastContext";
import { cn } from "../../lib/utils";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Linkedin,
  Twitter,
  Mail,
  FileText,
  Youtube,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ArrowUpRight,
} from "lucide-react";
import type { Agent } from "@founderos/shared";

// ─── Types ───────────────────────────────────────────────────────────────────

type ContentType =
  | "LinkedIn post"
  | "X thread"
  | "Newsletter"
  | "Reel"
  | "Blog"
  | "Landing page";

type ContentStatus = "draft" | "scheduled" | "published";

type ContentTab = "calendar" | "drafts" | "distribution" | "attribution";

const VALID_TABS: ContentTab[] = ["calendar", "drafts", "distribution", "attribution"];

function isValidTab(v: string | null): v is ContentTab {
  return VALID_TABS.includes(v as ContentTab);
}

interface ContentPiece {
  id: string;
  type: ContentType;
  title: string;
  owner: string;
  dayOfWeek: number; // 0 = Mon … 6 = Sun
  time: string;
  status: ContentStatus;
}

interface Draft {
  id: string;
  type: ContentType;
  title: string;
  preview: string;
  progressPct: number;
  owner: string;
  updatedAt: Date;
}

interface DistributionChannel {
  id: string;
  name: string;
  icon: React.ElementType;
  postsThisQuarter: number;
  impressions: string;
  deltaPercent: number;
  trend: "up" | "down" | "flat";
  metricLabel: string;
  connected: boolean;
}

interface AttributionRow {
  id: string;
  piece: string;
  channel: string;
  views: number;
  signups: number;
  revenue: number;
}

// ─── Mock data — Wave 5 replaces with real content service ───────────────────

const MOCK_CALENDAR: ContentPiece[] = [
  {
    id: "cp-1",
    type: "LinkedIn post",
    title: "What a 3-person $10M company looks like in 2026",
    owner: "Orbit",
    dayOfWeek: 0,
    time: "9:00 AM",
    status: "draft",
  },
  {
    id: "cp-2",
    type: "X thread",
    title: "5 signals your ops lead is overpaid",
    owner: "Orbit",
    dayOfWeek: 0,
    time: "2:00 PM",
    status: "scheduled",
  },
  {
    id: "cp-3",
    type: "Newsletter",
    title: "This week at FounderOS · INDEX 012",
    owner: "CEO",
    dayOfWeek: 1,
    time: "10:00 AM",
    status: "scheduled",
  },
  {
    id: "cp-4",
    type: "Blog",
    title: "Why we reframed agents as teammates",
    owner: "Orbit",
    dayOfWeek: 2,
    time: "11:00 AM",
    status: "draft",
  },
  {
    id: "cp-5",
    type: "LinkedIn post",
    title: "How I run growth on $200/mo",
    owner: "Orbit",
    dayOfWeek: 3,
    time: "9:00 AM",
    status: "scheduled",
  },
  {
    id: "cp-6",
    type: "Reel",
    title: "Morning Brief walkthrough",
    owner: "CEO",
    dayOfWeek: 3,
    time: "3:00 PM",
    status: "draft",
  },
  {
    id: "cp-7",
    type: "Landing page",
    title: "Solo Founder tier copy refresh",
    owner: "Orbit",
    dayOfWeek: 4,
    time: "10:00 AM",
    status: "draft",
  },
  {
    id: "cp-8",
    type: "X thread",
    title: "Weekend read: the one-person unicorn",
    owner: "Orbit",
    dayOfWeek: 6,
    time: "8:00 PM",
    status: "published",
  },
];

const MOCK_DRAFTS: Draft[] = [
  {
    id: "dr-1",
    type: "LinkedIn post",
    title: "What a 3-person $10M company looks like in 2026",
    preview:
      "Three people. Ten million in ARR. No middle management, no weekly standups, no headcount reviews. Here's exactly how the org chart works...",
    progressPct: 75,
    owner: "Orbit",
    updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
  },
  {
    id: "dr-2",
    type: "Blog",
    title: "Why we reframed agents as teammates",
    preview:
      "When we first built FounderOS, we called them agents. Users kept bouncing at onboarding. Then we tried 'teammates' and something clicked...",
    progressPct: 50,
    owner: "Orbit",
    updatedAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
  },
  {
    id: "dr-3",
    type: "Newsletter",
    title: "This week at FounderOS · INDEX 012",
    preview:
      "This week: we shipped Calendar tab in Content Studio, watched a newsletter drive $3.2k in attributed revenue, and hit a new ARR milestone...",
    progressPct: 90,
    owner: "CEO",
    updatedAt: new Date(Date.now() - 30 * 60 * 1000),
  },
  {
    id: "dr-4",
    type: "Reel",
    title: "Morning Brief walkthrough",
    preview:
      "60-second screen recording of the Morning Brief agent producing a prioritized to-do list, three open issues flagged, and a revenue callout...",
    progressPct: 30,
    owner: "CEO",
    updatedAt: new Date(Date.now() - 18 * 60 * 60 * 1000),
  },
  {
    id: "dr-5",
    type: "Landing page",
    title: "Solo Founder tier copy refresh",
    preview:
      "Current hero: 'AI executive team for solo founders.' New direction: 'Run a $10M company with 3 people.' Revised across hero, pricing, FAQ...",
    progressPct: 20,
    owner: "Orbit",
    updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
  },
];

const MOCK_DISTRIBUTION: DistributionChannel[] = [
  {
    id: "linkedin",
    name: "LinkedIn",
    icon: Linkedin,
    postsThisQuarter: 42,
    impressions: "12.4k impressions",
    deltaPercent: 18,
    trend: "up",
    metricLabel: "posts this quarter",
    connected: true,
  },
  {
    id: "x",
    name: "X",
    icon: Twitter,
    postsThisQuarter: 28,
    impressions: "8.2k impressions",
    deltaPercent: 22,
    trend: "up",
    metricLabel: "threads this quarter",
    connected: true,
  },
  {
    id: "newsletter",
    name: "Newsletter",
    icon: Mail,
    postsThisQuarter: 12,
    impressions: "1.8k opens (61% OR)",
    deltaPercent: 4,
    trend: "up",
    metricLabel: "issues this quarter",
    connected: true,
  },
  {
    id: "blog",
    name: "Blog",
    icon: FileText,
    postsThisQuarter: 6,
    impressions: "3.1k views",
    deltaPercent: 9,
    trend: "up",
    metricLabel: "posts this quarter",
    connected: true,
  },
  {
    id: "youtube",
    name: "YouTube",
    icon: Youtube,
    postsThisQuarter: 0,
    impressions: "0 views",
    deltaPercent: 0,
    trend: "flat",
    metricLabel: "not connected",
    connected: false,
  },
];

const MOCK_ATTRIBUTION: AttributionRow[] = [
  {
    id: "at-1",
    piece: "What a 3-person $10M company looks like in 2026",
    channel: "LinkedIn",
    views: 4200,
    signups: 18,
    revenue: 2100,
  },
  {
    id: "at-2",
    piece: "5 signals your ops lead is overpaid",
    channel: "X",
    views: 1800,
    signups: 7,
    revenue: 540,
  },
  {
    id: "at-3",
    piece: "Why we reframed agents as teammates",
    channel: "Blog",
    views: 3100,
    signups: 9,
    revenue: 1320,
  },
  {
    id: "at-4",
    piece: "This week at FounderOS · INDEX 012",
    channel: "Newsletter",
    views: 1760,
    signups: 14,
    revenue: 3200,
  },
  {
    id: "at-5",
    piece: "Morning Brief walkthrough",
    channel: "Reel",
    views: 820,
    signups: 3,
    revenue: 0,
  },
  {
    id: "at-6",
    piece: "How I run growth on $200/mo",
    channel: "LinkedIn",
    views: 2400,
    signups: 11,
    revenue: 1540,
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function getWeekDates(): Date[] {
  const now = new Date();
  // normalize to Monday of current week
  const day = now.getDay(); // 0=Sun
  const diffToMon = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMon);
  monday.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

function relativeTimeShort(date: Date): string {
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

const TYPE_PILL_CLASSES: Record<ContentType, string> = {
  "LinkedIn post": "bg-blue-500/10 text-blue-700 dark:text-blue-400 border border-blue-500/20",
  "X thread": "bg-slate-500/10 text-slate-700 dark:text-slate-300 border border-slate-500/20",
  Newsletter: "bg-violet-500/10 text-violet-700 dark:text-violet-400 border border-violet-500/20",
  Reel: "bg-rose-500/10 text-rose-700 dark:text-rose-400 border border-rose-500/20",
  Blog: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20",
  "Landing page": "bg-teal-500/10 text-teal-700 dark:text-teal-400 border border-teal-500/20",
};

const STATUS_DOT_CLASSES: Record<ContentStatus, string> = {
  draft: "bg-amber-400",
  scheduled: "bg-emerald-500",
  published: "bg-muted-foreground/40",
};

const STATUS_LABELS: Record<ContentStatus, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  published: "Published",
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function TypePill({ type }: { type: ContentType }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] whitespace-nowrap",
        TYPE_PILL_CLASSES[type],
      )}
    >
      {type}
    </span>
  );
}

function StatusDot({ status }: { status: ContentStatus }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
      <span className={cn("inline-block h-1.5 w-1.5 rounded-full", STATUS_DOT_CLASSES[status])} />
      {STATUS_LABELS[status]}
    </span>
  );
}

function ContentCard({ piece }: { piece: ContentPiece }) {
  return (
    <div className="rounded border border-border bg-card px-2.5 py-2 flex flex-col gap-1.5 hover:border-foreground/20 transition-colors">
      <TypePill type={piece.type} />
      <p className="text-[11px] font-medium text-foreground leading-snug line-clamp-2">
        {piece.title}
      </p>
      <div className="flex items-center justify-between gap-1">
        <span className="text-[10px] text-muted-foreground tabular-nums">{piece.time}</span>
        <span className="text-[10px] text-muted-foreground/70">{piece.owner}</span>
      </div>
      <StatusDot status={piece.status} />
    </div>
  );
}

// ─── Calendar tab ─────────────────────────────────────────────────────────────

function CalendarTab({
  pieces,
  pushToast,
}: {
  pieces: ContentPiece[];
  pushToast: (input: { title: string; body: string }) => void;
}) {
  const weekDates = getWeekDates();
  const byDay = (dayIndex: number) => pieces.filter((p) => p.dayOfWeek === dayIndex);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        {/* Week nav */}
        <div className="flex items-center gap-2">
          <button
            onClick={() =>
              pushToast({ title: "Coming soon", body: "Week navigation ships in Wave 5." })
            }
            className="flex items-center justify-center h-7 w-7 rounded border border-border bg-card hover:border-foreground/30 transition-colors"
            aria-label="Previous week"
          >
            <ChevronLeft className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          <span className="text-[12px] text-foreground font-medium tabular-nums">
            This week ·{" "}
            {weekDates[0].toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            {" – "}
            {weekDates[6].toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </span>
          <button
            onClick={() =>
              pushToast({ title: "Coming soon", body: "Week navigation ships in Wave 5." })
            }
            className="flex items-center justify-center h-7 w-7 rounded border border-border bg-card hover:border-foreground/30 transition-colors"
            aria-label="Next week"
          >
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            pushToast({
              title: "Coming soon",
              body: "Auto-scheduling ships in Wave 5.",
            })
          }
        >
          + Schedule piece
        </Button>
      </div>

      {/* 7-day grid */}
      <div className="grid grid-cols-7 gap-1 overflow-x-auto">
        {/* Header row */}
        {DAY_LABELS.map((label, i) => (
          <div key={label} className="flex flex-col items-center gap-0.5 pb-2">
            <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {label}
            </span>
            <span className="tabular-nums text-[11px] text-foreground/60">
              {weekDates[i].getDate()}
            </span>
          </div>
        ))}

        {/* Day columns */}
        {DAY_LABELS.map((label, i) => {
          const dayPieces = byDay(i);
          return (
            <div key={label} className="flex flex-col gap-1.5 min-h-[160px]">
              {dayPieces.length === 0 ? (
                <div className="rounded border border-dashed border-border/50 flex-1 min-h-[80px]" />
              ) : (
                dayPieces.map((piece) => <ContentCard key={piece.id} piece={piece} />)
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Drafts tab ───────────────────────────────────────────────────────────────

function DraftsTab({
  drafts,
  pushToast,
}: {
  drafts: Draft[];
  pushToast: (input: { title: string; body: string }) => void;
}) {
  return (
    <div className="space-y-3">
      {drafts.map((draft) => (
        <div
          key={draft.id}
          className="rounded-md border border-border bg-card px-4 py-3.5 flex items-start gap-4 hover:border-foreground/20 transition-colors"
        >
          {/* Left: content details */}
          <div className="flex-1 min-w-0 space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <TypePill type={draft.type} />
              <p className="text-sm font-semibold text-foreground leading-snug truncate">
                {draft.title}
              </p>
            </div>
            <p className="text-[11px] text-muted-foreground italic leading-relaxed line-clamp-2">
              {draft.preview.slice(0, 120)}
              {draft.preview.length > 120 ? "…" : ""}
            </p>
            {/* Progress bar */}
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-[var(--brand,theme(colors.teal.500))] transition-all"
                  style={{ width: `${draft.progressPct}%` }}
                />
              </div>
              <span className="tabular-nums text-[10px] text-muted-foreground shrink-0">
                {draft.progressPct}%
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
              <span>{draft.owner}</span>
              <span className="text-muted-foreground/30">·</span>
              <span>Updated {relativeTimeShort(draft.updatedAt)}</span>
            </div>
          </div>

          {/* Right: actions */}
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => pushToast({ title: "Preview", body: "Draft preview coming in Wave 5." })}
            >
              Preview
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() =>
                pushToast({ title: "Review requested", body: "Review request coming in Wave 5." })
              }
            >
              Request review
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Distribution tab ─────────────────────────────────────────────────────────

function DistributionChannelCard({
  channel,
  pushToast,
}: {
  channel: DistributionChannel;
  pushToast: (input: { title: string; body: string }) => void;
}) {
  const Icon = channel.icon;
  const TrendIcon =
    channel.trend === "up" ? TrendingUp : channel.trend === "down" ? TrendingDown : Minus;
  const trendColor =
    channel.trend === "up"
      ? "text-emerald-600 dark:text-emerald-400"
      : channel.trend === "down"
        ? "text-red-500"
        : "text-muted-foreground";

  if (!channel.connected) {
    return (
      <div className="rounded-md border border-dashed border-border bg-card p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground/40" />
          <span className="text-sm font-medium text-muted-foreground">{channel.name}</span>
        </div>
        <p className="text-[11px] text-muted-foreground/60">Not connected</p>
        <Button
          variant="outline"
          size="sm"
          className="self-start text-[11px] h-7"
          onClick={() =>
            pushToast({
              title: "Coming soon",
              body: `${channel.name} integration ships in Wave 5.`,
            })
          }
        >
          Connect
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-card p-4 flex flex-col gap-3 hover:border-foreground/20 transition-colors">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">{channel.name}</span>
        </div>
        <div className={cn("flex items-center gap-1 text-[11px] font-medium", trendColor)}>
          <TrendIcon className="h-3 w-3" />
          {channel.trend !== "flat" ? `${channel.deltaPercent > 0 ? "+" : ""}${channel.deltaPercent}%` : "—"}
        </div>
      </div>

      <div className="flex flex-col gap-0.5">
        <div className="flex items-baseline gap-1">
          <span className="tabular-nums text-[26px] font-bold text-foreground leading-none">
            {channel.postsThisQuarter}
          </span>
          <span className="text-[11px] text-muted-foreground">{channel.metricLabel}</span>
        </div>
        <p className="text-[11px] text-muted-foreground tabular-nums">{channel.impressions}</p>
      </div>

      <p className="text-[10px] text-muted-foreground/60">vs last quarter</p>
    </div>
  );
}

function DistributionTab({
  pushToast,
}: {
  pushToast: (input: { title: string; body: string }) => void;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {MOCK_DISTRIBUTION.map((ch) => (
        <DistributionChannelCard key={ch.id} channel={ch} pushToast={pushToast} />
      ))}
    </div>
  );
}

// ─── Attribution tab ──────────────────────────────────────────────────────────

function AttributionTab({
  pushToast,
}: {
  pushToast: (input: { title: string; body: string }) => void;
}) {
  const totals = MOCK_ATTRIBUTION.reduce(
    (acc, row) => ({
      views: acc.views + row.views,
      signups: acc.signups + row.signups,
      revenue: acc.revenue + row.revenue,
    }),
    { views: 0, signups: 0, revenue: 0 },
  );

  return (
    <div className="space-y-4">
      {/* Insight callout */}
      <div className="rounded-md border border-violet-500/30 bg-violet-500/5 p-4 flex items-center justify-between gap-4">
        <p className="text-sm text-foreground/80 leading-relaxed">
          <span className="font-semibold text-foreground">
            Newsletter drives the highest revenue per signup ($228).
          </span>{" "}
          Double down next week.
        </p>
        <button
          onClick={() =>
            pushToast({ title: "Coming soon", body: "Experiment creation ships in Wave 5." })
          }
          className="shrink-0 flex items-center gap-1 text-[11px] text-[var(--brand,theme(colors.teal.500))] hover:underline font-medium whitespace-nowrap"
        >
          Create experiment
          <ArrowUpRight className="h-3 w-3" />
        </button>
      </div>

      {/* Table */}
      <div className="rounded-md border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  Piece
                </th>
                <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  Channel
                </th>
                <th className="text-right px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground tabular-nums">
                  Views
                </th>
                <th className="text-right px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground tabular-nums">
                  Signups
                </th>
                <th className="text-right px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground tabular-nums">
                  Revenue
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {MOCK_ATTRIBUTION.map((row) => (
                <tr key={row.id} className="hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3 text-[12px] text-foreground max-w-[280px]">
                    <span className="line-clamp-1">{row.piece}</span>
                  </td>
                  <td className="px-4 py-3 text-[12px] text-muted-foreground whitespace-nowrap">
                    {row.channel}
                  </td>
                  <td className="px-4 py-3 text-[12px] text-foreground tabular-nums text-right whitespace-nowrap">
                    {formatNumber(row.views)}
                  </td>
                  <td className="px-4 py-3 text-[12px] text-foreground tabular-nums text-right whitespace-nowrap">
                    {row.signups}
                  </td>
                  <td className="px-4 py-3 text-[12px] text-foreground tabular-nums text-right whitespace-nowrap">
                    {row.revenue === 0 ? "$0" : `$${formatNumber(row.revenue)}`}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border bg-muted/30">
                <td className="px-4 py-3 text-[12px] font-bold text-foreground" colSpan={2}>
                  Total
                </td>
                <td className="px-4 py-3 text-[12px] font-bold text-foreground tabular-nums text-right whitespace-nowrap">
                  {formatNumber(totals.views)}
                </td>
                <td className="px-4 py-3 text-[12px] font-bold text-foreground tabular-nums text-right whitespace-nowrap">
                  {totals.signups}
                </td>
                <td className="px-4 py-3 text-[12px] font-bold text-foreground tabular-nums text-right whitespace-nowrap">
                  ${formatNumber(totals.revenue)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ContentConsole({ companyId: _companyId, agents }: {
  companyId: string | null;
  agents: Agent[];
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { pushToast } = useToast();

  const rawTab = searchParams.get("tab");
  const activeTab: ContentTab = isValidTab(rawTab) ? rawTab : "calendar";

  function setTab(tab: ContentTab) {
    setSearchParams({ tab });
  }

  // MOCK — Wave 5 replaces with real content service.
  // Prefer a CMO or Designer agent as the "content lead" display name.
  const contentLead = agents.find((a) => a.role === "cmo" || a.role === "designer");
  const contentTeammates = agents.filter(
    (a) => a.role === "cmo" || a.role === "designer" || a.role === "researcher",
  );
  const teammateCount = contentTeammates.length || agents.length;

  // Substitute resolved teammate name for "Orbit" where a real agent exists
  const resolvedName = contentLead?.name ?? "Orbit";
  const resolvedCalendar = MOCK_CALENDAR.map((p) =>
    p.owner === "Orbit" ? { ...p, owner: resolvedName } : p,
  );
  const resolvedDrafts = MOCK_DRAFTS.map((d) =>
    d.owner === "Orbit" ? { ...d, owner: resolvedName } : d,
  );

  const inFlight = resolvedCalendar.filter((p) => p.status === "draft" || p.status === "scheduled").length;
  const scheduledCount = resolvedCalendar.filter((p) => p.status === "scheduled").length;
  const publishedThisMonth = resolvedCalendar.filter((p) => p.status === "published").length;

  const displayH1 =
    inFlight === 0 ? "Quiet this week" : `${inFlight} piece${inFlight === 1 ? "" : "s"} in flight`;

  const tabItems = [
    { value: "calendar", label: "Calendar" },
    { value: "drafts", label: `Drafts · ${resolvedDrafts.length}` },
    { value: "distribution", label: "Distribution" },
    { value: "attribution", label: "Attribution" },
  ];

  return (
    <div className="space-y-6">
      {/* Editorial page header */}
      <header className="flex flex-col gap-1.5 pt-1">
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Content Studio
        </div>
        <h1 className="font-display text-[32px] md:text-[40px] leading-[1.05] tracking-tight text-foreground">
          {displayH1}
        </h1>
        <p className="text-[12px] text-muted-foreground tabular-nums">
          <span className="font-medium text-foreground">{teammateCount}</span>{" "}
          {teammateCount === 1 ? "teammate" : "teammates"}
          <span className="mx-2 text-muted-foreground/40">·</span>
          <span className="font-medium text-foreground">{scheduledCount}</span> pieces scheduled
          <span className="mx-2 text-muted-foreground/40">·</span>
          <span className="font-medium text-foreground">{publishedThisMonth}</span> published this month
        </p>
      </header>

      {/* Tab bar */}
      <Tabs value={activeTab} onValueChange={(v) => setTab(v as ContentTab)}>
        <PageTabBar
          items={tabItems}
          value={activeTab}
          onValueChange={(v) => setTab(v as ContentTab)}
          align="start"
        />
      </Tabs>

      {/* Tab content */}
      <div>
        {activeTab === "calendar" && (
          <CalendarTab pieces={resolvedCalendar} pushToast={pushToast} />
        )}
        {activeTab === "drafts" && (
          <DraftsTab drafts={resolvedDrafts} pushToast={pushToast} />
        )}
        {activeTab === "distribution" && <DistributionTab pushToast={pushToast} />}
        {activeTab === "attribution" && <AttributionTab pushToast={pushToast} />}
        {activeTab === "calendar" && resolvedCalendar.length === 0 && (
          <EmptyState icon={CalendarDays} message="No content scheduled this week. Schedule the first piece." />
        )}
      </div>
    </div>
  );
}
