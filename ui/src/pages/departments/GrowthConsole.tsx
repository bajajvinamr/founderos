import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "@/lib/router";
import { Tabs } from "@/components/ui/tabs";
import { PageTabBar } from "@/components/PageTabBar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { useToast } from "../../context/ToastContext";
import { cn } from "../../lib/utils";
import {
  Plus,
  TrendingUp,
  TrendingDown,
  Minus,
  Linkedin,
  BookOpen,
  Users,
  Mail,
  Search,
  FlaskConical,
} from "lucide-react";
import type { Agent } from "@founderos/shared";
import { integrationDataApi } from "../../api/integration-data";
import type {
  PostHogFunnelPayload,
  PostHogChannelsPayload,
} from "../../api/integration-data";

// ─── Types ───────────────────────────────────────────────────────────────────

type ExperimentStatus = "idea" | "running" | "analyzing" | "shipped" | "killed";

interface Experiment {
  id: string;
  hypothesis: string;
  channel: string;
  ownerName: string;
  impact: number;
  confidence: number;
  ease: number;
  status: ExperimentStatus;
  expectedLift: string;
  expectedCacDelta: string;
  updatedAt: Date;
  note?: string;
}

interface Channel {
  id: string;
  name: string;
  icon: React.ElementType;
  signupsThisMonth: number;
  spendDollars: number;
  cac: number | null;
  deltaPercent: number;
  trend: "up" | "down" | "flat";
  sparkline: number[]; // 7 values 0-100 relative heights
}

interface FunnelStage {
  label: string;
  count: number;
}

type GrowthTab = "experiments" | "channels" | "funnel" | "paid";

const VALID_TABS: GrowthTab[] = ["experiments", "channels", "funnel", "paid"];

function isValidTab(v: string | null): v is GrowthTab {
  return VALID_TABS.includes(v as GrowthTab);
}

// ─── Mock data — Wave 5 replaces with real experiment service ─────────────────

const MOCK_EXPERIMENTS: Experiment[] = [
  {
    id: "exp-1",
    hypothesis: "Tighten hero to '$10M company with 3 people'",
    channel: "Landing",
    ownerName: "Growth teammate",
    impact: 9,
    confidence: 8,
    ease: 9,
    status: "running",
    expectedLift: "+8% signup rate",
    expectedCacDelta: "-$18 CAC",
    updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2h ago
  },
  {
    id: "exp-2",
    hypothesis: "Add pricing anchor — highlight $799 solo tier",
    channel: "Landing",
    ownerName: "Growth teammate",
    impact: 8,
    confidence: 6,
    ease: 9,
    status: "analyzing",
    expectedLift: "+5% trial starts",
    expectedCacDelta: "-$9 CAC",
    updatedAt: new Date(Date.now() - 18 * 60 * 60 * 1000), // 18h ago
  },
  {
    id: "exp-3",
    hypothesis: "LinkedIn outbound to YC founders",
    channel: "LinkedIn",
    ownerName: "Growth teammate",
    impact: 8,
    confidence: 7,
    ease: 6,
    status: "running",
    expectedLift: "+12 demos/mo",
    expectedCacDelta: "-$40 CAC",
    updatedAt: new Date(Date.now() - 4 * 60 * 60 * 1000), // 4h ago
  },
  {
    id: "exp-4",
    hypothesis: "Founder-led weekly newsletter",
    channel: "Email",
    ownerName: "Growth teammate",
    impact: 9,
    confidence: 6,
    ease: 5,
    status: "idea",
    expectedLift: "+3% signup rate",
    expectedCacDelta: "$0 CAC",
    updatedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3d ago
  },
  {
    id: "exp-5",
    hypothesis: "Refer-a-founder program (+3 mo scale tier)",
    channel: "Referral",
    ownerName: "Growth teammate",
    impact: 7,
    confidence: 8,
    ease: 4,
    status: "idea",
    expectedLift: "+15% new signups",
    expectedCacDelta: "-$60 CAC",
    updatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5d ago
  },
  {
    id: "exp-6",
    hypothesis: "Google Ads on 'AI executive team'",
    channel: "Paid search",
    ownerName: "Growth teammate",
    impact: 6,
    confidence: 5,
    ease: 8,
    status: "killed",
    expectedLift: "+8 signups/mo",
    expectedCacDelta: "+$42 CAC",
    updatedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7d ago
    note: "CAC too high",
  },
];

const MOCK_CHANNELS: Channel[] = [
  {
    id: "linkedin",
    name: "LinkedIn",
    icon: Linkedin,
    signupsThisMonth: 42,
    spendDollars: 0,
    cac: 0,
    deltaPercent: 18,
    trend: "up",
    sparkline: [30, 40, 35, 55, 60, 70, 85],
  },
  {
    id: "content",
    name: "Content / SEO",
    icon: BookOpen,
    signupsThisMonth: 28,
    spendDollars: 0,
    cac: 0,
    deltaPercent: 4,
    trend: "up",
    sparkline: [50, 48, 55, 52, 57, 60, 62],
  },
  {
    id: "referral",
    name: "Referral",
    icon: Users,
    signupsThisMonth: 12,
    spendDollars: 0,
    cac: null,
    deltaPercent: 0,
    trend: "flat",
    sparkline: [20, 15, 18, 22, 16, 19, 20],
  },
  {
    id: "outbound",
    name: "Outbound email",
    icon: Mail,
    signupsThisMonth: 6,
    spendDollars: 8,
    cac: 1.33,
    deltaPercent: -22,
    trend: "down",
    sparkline: [40, 35, 30, 28, 25, 20, 18],
  },
  {
    id: "paid",
    name: "Paid search",
    icon: Search,
    signupsThisMonth: 3,
    spendDollars: 180,
    cac: 60,
    deltaPercent: -70,
    trend: "down",
    sparkline: [80, 60, 45, 30, 20, 10, 5],
  },
];

const MOCK_FUNNEL: FunnelStage[] = [
  { label: "Traffic", count: 12400 },
  { label: "Signup", count: 348 },
  { label: "Activation", count: 92 },
  { label: "Trial", count: 41 },
  { label: "Paid", count: 7 },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function iceTotal(exp: Experiment): number {
  return exp.impact + exp.confidence + exp.ease;
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

const STATUS_PILL_CLASSES: Record<ExperimentStatus, string> = {
  idea: "bg-muted text-muted-foreground border border-border",
  running: "bg-teal-500/10 text-teal-700 dark:text-teal-400 border border-teal-500/30",
  analyzing: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/30",
  shipped: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30",
  killed: "bg-red-500/10 text-red-700 dark:text-red-400 border border-red-500/30",
};

const STATUS_LABELS: Record<ExperimentStatus, string> = {
  idea: "Idea",
  running: "Running",
  analyzing: "Analyzing",
  shipped: "Shipped",
  killed: "Killed",
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusPill({ status }: { status: ExperimentStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em]",
        STATUS_PILL_CLASSES[status],
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function IceScore({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="text-[10px] text-muted-foreground uppercase tracking-[0.1em]">{label}</span>
      <span className="tabular-nums text-[13px] font-semibold text-foreground">{value}</span>
    </div>
  );
}

function ExperimentCard({ exp }: { exp: Experiment }) {
  const total = iceTotal(exp);
  return (
    <div className="rounded-md border border-border bg-card p-4 flex flex-col gap-3 hover:border-foreground/20 transition-colors">
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-foreground leading-snug flex-1">
          {exp.hypothesis}
        </p>
        <StatusPill status={exp.status} />
      </div>

      {/* Channel + owner */}
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground/70">{exp.channel}</span>
        <span className="text-muted-foreground/40">·</span>
        <span>{exp.ownerName}</span>
      </div>

      {/* ICE scores */}
      <div className="flex items-center gap-3">
        <IceScore label="I" value={exp.impact} />
        <IceScore label="C" value={exp.confidence} />
        <IceScore label="E" value={exp.ease} />
        <div className="ml-auto flex flex-col items-center gap-0.5">
          <span className="text-[10px] text-muted-foreground uppercase tracking-[0.1em]">ICE</span>
          <span
            className={cn(
              "tabular-nums text-[15px] font-bold",
              total >= 24 ? "text-[var(--brand,theme(colors.teal.500))]" : "text-foreground",
            )}
          >
            {total}
          </span>
        </div>
      </div>

      {/* Expected lift + CAC */}
      <div className="flex items-center gap-3 text-[11px]">
        <span className="text-emerald-600 dark:text-emerald-400 font-medium">{exp.expectedLift}</span>
        <span className="text-muted-foreground/40">·</span>
        <span className="text-muted-foreground">{exp.expectedCacDelta}</span>
      </div>

      {/* Note (killed) */}
      {exp.note && (
        <p className="text-[11px] text-red-500/80 italic">"{exp.note}"</p>
      )}

      {/* Timestamp */}
      <div className="text-[10px] text-muted-foreground/60 tabular-nums">
        Updated {relativeTimeShort(exp.updatedAt)}
      </div>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  return (
    <div className="flex items-end gap-0.5 h-6">
      {values.map((v, i) => (
        <div
          key={i}
          className="flex-1 rounded-sm bg-foreground/15"
          style={{ height: `${Math.round((v / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

function ChannelCard({ channel }: { channel: Channel }) {
  const Icon = channel.icon;
  const TrendIcon =
    channel.trend === "up" ? TrendingUp : channel.trend === "down" ? TrendingDown : Minus;
  const trendColor =
    channel.trend === "up"
      ? "text-emerald-600 dark:text-emerald-400"
      : channel.trend === "down"
        ? "text-red-500"
        : "text-muted-foreground";

  return (
    <div className="rounded-md border border-border bg-card p-4 flex flex-col gap-3 hover:border-foreground/20 transition-colors">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">{channel.name}</span>
      </div>

      <div className="flex items-baseline gap-1.5">
        <span className="tabular-nums text-[28px] font-bold text-foreground leading-none">
          {channel.signupsThisMonth}
        </span>
        <span className="text-xs text-muted-foreground">signups</span>
        <div className={cn("ml-auto flex items-center gap-1 text-xs font-medium", trendColor)}>
          <TrendIcon className="h-3.5 w-3.5" />
          {channel.trend !== "flat"
            ? `${channel.deltaPercent > 0 ? "+" : ""}${channel.deltaPercent}%`
            : "—"}
        </div>
      </div>

      <Sparkline values={channel.sparkline} />

      <div className="text-[11px] text-muted-foreground tabular-nums">
        {channel.cac === null
          ? "CAC: —"
          : channel.cac === 0
            ? "$0 CAC · organic"
            : `$${channel.cac.toFixed(2)} CAC · $${channel.spendDollars} spend`}
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTimeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function DataSourceCaption({ fetchedAt }: { fetchedAt: string }) {
  return (
    <p className="text-[10px] text-muted-foreground/60 tabular-nums mt-2">
      data source: PostHog · synced {relativeTimeAgo(fetchedAt)}
    </p>
  );
}

function FunnelView({
  pushToast,
  posthogFunnel,
}: {
  pushToast: (input: { title: string; body: string }) => void;
  posthogFunnel: { payload: PostHogFunnelPayload; fetchedAt: string } | null | undefined;
}) {
  // Build stages from real data or fall back to mock
  const stages: FunnelStage[] = posthogFunnel
    ? [
        { label: "Traffic", count: posthogFunnel.payload.pageviews },
        { label: "Signup", count: posthogFunnel.payload.signups },
        { label: "Activation", count: posthogFunnel.payload.activations },
        { label: "Trial", count: posthogFunnel.payload.trials },
        { label: "Paid", count: posthogFunnel.payload.paid },
      ]
    : MOCK_FUNNEL;

  const maxCount = Math.max(stages[0].count, 1);

  // Find biggest drop-off for insight callout
  let biggestDropIdx = 1;
  let biggestDrop = 0;
  for (let i = 1; i < stages.length; i++) {
    const prev = stages[i - 1].count;
    const cur = stages[i].count;
    const drop = prev > 0 ? (prev - cur) / prev : 0;
    if (drop > biggestDrop) {
      biggestDrop = drop;
      biggestDropIdx = i;
    }
  }
  const dropLabel = `${stages[biggestDropIdx - 1].label} → ${stages[biggestDropIdx].label}`;
  const dropPct = Math.round(biggestDrop * 100);

  if (!posthogFunnel) {
    return (
      <div className="space-y-6">
        {/* Empty state */}
        <div className="rounded-md border border-dashed border-border bg-card p-8 flex flex-col items-center gap-3 text-center">
          <p className="text-sm text-muted-foreground">
            No funnel data yet. Connect PostHog to see real conversion numbers.
          </p>
          <a
            href="/integrations"
            className="text-[12px] font-medium text-[var(--brand,theme(colors.teal.500))] hover:underline"
          >
            Connect PostHog →
          </a>
        </div>

        {/* Fallback mock funnel */}
        <div className="opacity-40 pointer-events-none">
          <FunnelBars stages={MOCK_FUNNEL} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FunnelBars stages={stages} />

      {/* Insight callout */}
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-4 flex items-start justify-between gap-4">
        <p className="text-sm text-foreground/80 leading-relaxed">
          <span className="font-semibold text-foreground">
            Biggest drop-off: {dropLabel} ({dropPct}% loss).
          </span>{" "}
          Suggested experiment: rework this stage of the funnel.
        </p>
        <button
          onClick={() =>
            pushToast({ title: "Added to backlog", body: "Funnel experiment added to idea queue." })
          }
          className="shrink-0 text-[11px] text-[var(--brand,theme(colors.teal.500))] hover:underline font-medium whitespace-nowrap"
        >
          + Add to experiment backlog
        </button>
      </div>

      <DataSourceCaption fetchedAt={posthogFunnel.fetchedAt} />
    </div>
  );
}

function FunnelBars({ stages }: { stages: FunnelStage[] }) {
  const maxCount = Math.max(stages[0].count, 1);
  return (
    <div className="rounded-md border border-border bg-card divide-y divide-border overflow-hidden">
      {stages.map((stage, idx) => {
        const prevCount = idx > 0 ? stages[idx - 1].count : stage.count;
        const convPct = idx === 0 ? 100 : Math.round((stage.count / Math.max(prevCount, 1)) * 100);
        const barWidth = Math.round((stage.count / maxCount) * 100);
        return (
          <div key={stage.label} className="px-4 py-3 flex items-center gap-3">
            <div className="w-16 shrink-0">
              <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground font-medium">
                {stage.label}
              </p>
            </div>
            <div className="flex-1">
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-[var(--brand,theme(colors.teal.500))] transition-all"
                  style={{ width: `${barWidth}%` }}
                />
              </div>
            </div>
            <div className="w-12 text-right tabular-nums text-xs font-semibold text-foreground shrink-0">
              {stage.count.toLocaleString()}
            </div>
            {idx > 0 && (
              <div
                className={cn(
                  "w-10 text-right tabular-nums text-[11px] font-medium shrink-0",
                  convPct < 20
                    ? "text-red-500"
                    : convPct < 50
                      ? "text-amber-500"
                      : "text-emerald-600 dark:text-emerald-400",
                )}
              >
                {convPct}%
              </div>
            )}
            {idx === 0 && <div className="w-10 shrink-0" />}
          </div>
        );
      })}
    </div>
  );
}

function PaidTab({ pushToast }: { pushToast: (input: { title: string; body: string }) => void }) {
  return (
    <div className="max-w-lg">
      <div className="rounded-md border border-border bg-card p-6 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { label: "Spend this month", value: "$180" },
            { label: "Active campaigns", value: "1" },
            { label: "Paused", value: "3" },
          ].map(({ label, value }) => (
            <div key={label} className="flex flex-col gap-1">
              <p className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-medium">{label}</p>
              <p className="tabular-nums text-[22px] font-bold text-foreground leading-none">{value}</p>
            </div>
          ))}
        </div>

        <div className="border-t border-border pt-4">
          <p className="text-sm text-muted-foreground mb-4">
            Connect Meta Ads, Google Ads, or LinkedIn Ads to unlock paid ops.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              pushToast({ title: "Coming soon", body: "Ad network integrations ship in Wave 6." })
            }
          >
            <Plus className="h-4 w-4 mr-1.5" />
            Connect ad network
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Experiments tab ──────────────────────────────────────────────────────────

function ExperimentsTab({
  experiments,
  pushToast,
}: {
  experiments: Experiment[];
  pushToast: (input: { title: string; body: string }) => void;
}) {
  const sorted = [...experiments].sort((a, b) => iceTotal(b) - iceTotal(a));
  const running = sorted.filter((e) => e.status === "running").length;
  const highIce = sorted.filter((e) => iceTotal(e) >= 20).length;

  return (
    <div className="space-y-5">
      {/* Summary strip + CTA */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-md border border-border bg-card px-4 py-3">
        <p className="text-[12px] text-muted-foreground tabular-nums">
          Total experiments:{" "}
          <span className="text-foreground font-medium">{sorted.length}</span>
          <span className="mx-2 text-muted-foreground/40">·</span>
          Running: <span className="text-foreground font-medium">{running}</span>
          <span className="mx-2 text-muted-foreground/40">·</span>
          ICE ≥ 20: <span className="text-foreground font-medium">{highIce}</span>
        </p>
        <Button
          size="sm"
          onClick={() =>
            pushToast({
              title: "Coming soon",
              body: "LLM-proposed experiment flow ships in Wave 5.",
            })
          }
          className="gap-1.5 shrink-0"
        >
          <Plus className="h-4 w-4" />
          Propose experiment
        </Button>
      </div>

      {/* Grid */}
      {sorted.length === 0 ? (
        <EmptyState icon={FlaskConical} message="No experiments yet. Propose the first one." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {sorted.map((exp) => (
            <ExperimentCard key={exp.id} exp={exp} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── UTM source label mapping ─────────────────────────────────────────────────

const UTM_SOURCE_LABELS: Record<string, string> = {
  google: "Google",
  "google.com": "Google",
  bing: "Bing",
  "bing.com": "Bing",
  "linkedin.com": "LinkedIn",
  linkedin: "LinkedIn",
  twitter: "Twitter / X",
  "twitter.com": "Twitter / X",
  "t.co": "Twitter / X",
  facebook: "Facebook",
  "facebook.com": "Facebook",
  reddit: "Reddit",
  "reddit.com": "Reddit",
  github: "GitHub",
  "github.com": "GitHub",
  newsletter: "Newsletter",
  email: "Email",
  referral: "Referral",
  "(direct)": "Direct",
  direct: "Direct",
  "(none)": "Direct",
};

function friendlyUtmLabel(source: string): string {
  const lower = source.toLowerCase();
  return UTM_SOURCE_LABELS[lower] ?? source;
}

// ─── Real channels tab ────────────────────────────────────────────────────────

function RealChannelCard({
  source,
  count,
}: {
  source: string;
  count: number;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-4 flex flex-col gap-2 hover:border-foreground/20 transition-colors">
      <p className="text-sm font-medium text-foreground">{friendlyUtmLabel(source)}</p>
      <div className="flex items-baseline gap-1">
        <span className="tabular-nums text-[28px] font-bold text-foreground leading-none">
          {count.toLocaleString()}
        </span>
        <span className="text-xs text-muted-foreground">visitors</span>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface GrowthConsoleProps {
  companyId: string | null;
  agents: Agent[];
}

export function GrowthConsole({ companyId, agents }: GrowthConsoleProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { pushToast } = useToast();

  const rawTab = searchParams.get("tab");
  const activeTab: GrowthTab = isValidTab(rawTab) ? rawTab : "experiments";

  function setTab(tab: GrowthTab) {
    setSearchParams({ tab });
  }

  // ── PostHog data queries ──────────────────────────────────────────────────
  const { data: posthogFunnelData } = useQuery({
    queryKey: ["integration-data", companyId, "posthog.funnel"],
    queryFn: () => integrationDataApi.getFunnel(companyId!),
    enabled: !!companyId,
    retry: false,
  });

  const { data: posthogChannelsData } = useQuery({
    queryKey: ["integration-data", companyId, "posthog.channels.utm_source"],
    queryFn: () => integrationDataApi.getChannels(companyId!),
    enabled: !!companyId,
    retry: false,
  });

  // ── Derive display values ─────────────────────────────────────────────────
  const growthTeammates = agents.filter((a) => a.role === "cmo" || a.role === "pm");
  const channelsLive = MOCK_CHANNELS.filter((c) => c.signupsThisMonth > 0).length;
  const totalSpend = MOCK_CHANNELS.reduce((sum, c) => sum + c.spendDollars, 0);

  const experiments: Experiment[] = MOCK_EXPERIMENTS.map((exp) => ({
    ...exp,
    ownerName:
      growthTeammates.length > 0
        ? (growthTeammates[0].name ?? "Growth teammate")
        : "Growth teammate",
  }));

  const runningCount = experiments.filter((e) => e.status === "running").length;

  const tabItems = [
    { value: "experiments", label: `Experiments · ${experiments.length}` },
    { value: "channels", label: `Channels · ${MOCK_CHANNELS.length}` },
    { value: "funnel", label: "Funnel" },
    { value: "paid", label: "Paid" },
  ];

  const hasRealChannels =
    posthogChannelsData?.payload?.channels &&
    posthogChannelsData.payload.channels.length > 0;

  return (
    <div className="space-y-6">
      {/* Editorial page header */}
      <header className="flex flex-col gap-1.5 pt-1">
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Growth Department
        </div>
        <h1 className="font-display text-[32px] md:text-[40px] leading-[1.05] tracking-tight text-foreground">
          {runningCount === 0
            ? "No experiments running"
            : `${runningCount} experiment${runningCount === 1 ? "" : "s"} running`}
        </h1>
        <p className="text-[12px] text-muted-foreground tabular-nums">
          <span className="font-medium text-foreground">{growthTeammates.length || agents.length}</span> teammates
          <span className="mx-2 text-muted-foreground/40">·</span>
          <span className="font-medium text-foreground">{channelsLive}</span> channels live
          <span className="mx-2 text-muted-foreground/40">·</span>
          <span className="font-medium text-foreground">${totalSpend}</span> spent this month
        </p>
      </header>

      {/* Tab bar */}
      <Tabs value={activeTab} onValueChange={(v) => setTab(v as GrowthTab)}>
        <PageTabBar
          items={tabItems}
          value={activeTab}
          onValueChange={(v) => setTab(v as GrowthTab)}
          align="start"
        />
      </Tabs>

      {/* Tab content */}
      <div>
        {activeTab === "experiments" && (
          <ExperimentsTab experiments={experiments} pushToast={pushToast} />
        )}
        {activeTab === "channels" && (
          <div className="space-y-3">
            {!hasRealChannels && (
              <p className="text-[11px] text-muted-foreground">
                Showing sample data.{" "}
                <a
                  href="/integrations"
                  className="text-[var(--brand,theme(colors.teal.500))] hover:underline font-medium"
                >
                  Connect PostHog for real data →
                </a>
              </p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {hasRealChannels
                ? posthogChannelsData!.payload.channels.map((ch) => (
                    <RealChannelCard
                      key={ch.source}
                      source={ch.source}
                      count={ch.count}
                    />
                  ))
                : MOCK_CHANNELS.map((ch) => (
                    <ChannelCard key={ch.id} channel={ch} />
                  ))}
            </div>
            {hasRealChannels && (
              <DataSourceCaption fetchedAt={posthogChannelsData!.fetchedAt} />
            )}
          </div>
        )}
        {activeTab === "funnel" && (
          <FunnelView
            pushToast={pushToast}
            posthogFunnel={posthogFunnelData ?? null}
          />
        )}
        {activeTab === "paid" && <PaidTab pushToast={pushToast} />}
      </div>
    </div>
  );
}
