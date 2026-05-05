import { useQuery } from "@tanstack/react-query";
import { useSearchParams, useNavigate } from "@/lib/router";
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
  FlaskConical,
} from "lucide-react";
import type { Agent } from "@founderos/shared";
import { integrationDataApi } from "../../api/integration-data";
import { agentsInDepartment } from "../../lib/departments";
import { experimentsApi, type Experiment as ApiExperiment } from "../../api/experiments";
import { ExperimentCard as ApiExperimentCard } from "../../components/ExperimentCard";
import { FunnelDiagnostics } from "./growth/FunnelDiagnostics";
import { useIsPaidPlan } from "../../api/billing";
import { AnalyticsConnectPrompt } from "./AnalyticsConnectPrompt";
import {
  DEMO_CHANNELS,
  DEMO_EXPERIMENTS,
  DEMO_FUNNEL,
} from "./growth-demo-data";
import type {
  Channel,
  Experiment,
  ExperimentStatus,
} from "./growth-types";

// ─── Types (re-exported for backward compatibility within this module) ──────

type GrowthTab = "experiments" | "channels" | "funnel" | "paid";

const VALID_TABS: GrowthTab[] = ["experiments", "channels", "funnel", "paid"];

function isValidTab(v: string | null): v is GrowthTab {
  return VALID_TABS.includes(v as GrowthTab);
}

// Demo data lives in `./growth-demo-data` and is rendered ONLY for free /
// trial users. Council 2026-05-05 P2: paid users must never see fabricated
// numbers — they get an explicit "connect analytics" CTA instead.
//
// The constants below keep aliases (`MOCK_*` → `DEMO_*`) only inside this
// file's render closures; the demo source of truth is a separate module.

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

// Note (2026-05-05 / TC-2): The earlier inline `FunnelView` + `FunnelBars`
// pair was rendered directly from this file before S3.7. Sprint 3 swapped
// in the recharts-backed `<FunnelDiagnostics>` (server-computed pirate
// funnel from the events table) which now owns the funnel tab. The legacy
// helpers were removed in this commit because they were both unused and
// pulled `DEMO_FUNNEL` into the paid-user render closure (the trust-gate
// concern that drove the council finding).

function PaidTab({
  pushToast,
  isPaid,
}: {
  pushToast: (input: { title: string; body: string }) => void;
  isPaid: boolean;
}) {
  // Paid users — render the connect-CTA, no fabricated spend numbers (council
  // 2026-05-05 P2). Free / trial keeps the demo strip.
  if (isPaid) {
    return <AnalyticsConnectPrompt surface="paid" />;
  }

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
  apiExperiments,
  ownerName,
  pushToast,
}: {
  experiments: Experiment[];
  apiExperiments: ApiExperiment[] | null | undefined;
  ownerName: string;
  pushToast: (input: { title: string; body: string }) => void;
}) {
  // Prefer real API rows when present; fall back to mocks for the empty
  // workspace so the tab is never blank pre-Wave-5 LLM flow.
  const useApi = !!(apiExperiments && apiExperiments.length > 0);

  const sortedMock = [...experiments].sort((a, b) => iceTotal(b) - iceTotal(a));
  const running = useApi
    ? apiExperiments!.filter((e) => e.status === "running").length
    : sortedMock.filter((e) => e.status === "running").length;
  const highIce = useApi
    ? apiExperiments!.filter((e) => (e.iceScore ?? 0) >= 50).length
    : sortedMock.filter((e) => iceTotal(e) >= 20).length;
  const total = useApi ? apiExperiments!.length : sortedMock.length;

  return (
    <div className="space-y-5">
      {/* Summary strip + CTA */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-md border border-border bg-card px-4 py-3">
        <p className="text-[12px] text-muted-foreground tabular-nums">
          Total experiments:{" "}
          <span className="text-foreground font-medium">{total}</span>
          <span className="mx-2 text-muted-foreground/40">·</span>
          Running: <span className="text-foreground font-medium">{running}</span>
          <span className="mx-2 text-muted-foreground/40">·</span>
          {useApi ? "ICE ≥ 50" : "ICE ≥ 20"}:{" "}
          <span className="text-foreground font-medium">{highIce}</span>
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
      {total === 0 ? (
        <EmptyState icon={FlaskConical} message="No experiments yet. Propose the first one." />
      ) : useApi ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {apiExperiments!.map((exp) => (
            <ApiExperimentCard key={exp.id} experiment={exp} ownerName={ownerName} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {sortedMock.map((exp) => (
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
  const navigate = useNavigate();
  const { pushToast } = useToast();

  const rawTab = searchParams.get("tab");
  const activeTab: GrowthTab = isValidTab(rawTab) ? rawTab : "experiments";

  function setTab(tab: GrowthTab) {
    setSearchParams({ tab });
  }

  // ── Plan tier — council 2026-05-05 P2 trust gate ──────────────────────────
  // Paid (active OR trialing on Stripe) plans get the integration-CTA empty
  // state instead of demo data. Free / trial-not-yet-billed plans keep the
  // mock preview as an acceptable demo of the surface.
  const { isPaid } = useIsPaidPlan();

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

  // Experiments — Sprint 3 S3.5 wiring. Returns the full list sorted by ICE
  // server-side; UI just renders. Empty result falls back to demo cards on
  // free / trial; paid users see the AnalyticsConnectPrompt instead.
  const { data: apiExperiments } = useQuery({
    queryKey: ["experiments", companyId],
    queryFn: () => experimentsApi.list(companyId!),
    enabled: !!companyId,
    retry: false,
  });

  // ── Empty-state gate ──────────────────────────────────────────────────────
  const deptAgents = agentsInDepartment("growth", agents);
  const hasTeammates = deptAgents.length > 0;
  const hasPostHogData =
    !!(posthogFunnelData?.payload) || !!(posthogChannelsData?.payload);

  // ── Derive display values ─────────────────────────────────────────────────
  const growthTeammates = agents.filter((a) => a.role === "cmo" || a.role === "pm");
  const ownerName =
    growthTeammates.length > 0
      ? (growthTeammates[0].name ?? "Growth teammate")
      : "Growth teammate";

  const hasRealChannels =
    !!posthogChannelsData?.payload?.channels &&
    posthogChannelsData.payload.channels.length > 0;
  const hasRealApiExperiments = !!(apiExperiments && apiExperiments.length > 0);

  // Header summary numbers — show real data when present, demo numbers ONLY
  // for free / trial. Paid users with no live data get neutral zeros (no
  // fabricated counts).
  const channelsLive = hasRealChannels
    ? posthogChannelsData!.payload.channels.length
    : isPaid
      ? 0
      : DEMO_CHANNELS.filter((c) => c.signupsThisMonth > 0).length;
  const totalSpend = isPaid
    ? 0
    : DEMO_CHANNELS.reduce((sum, c) => sum + c.spendDollars, 0);

  // Experiment list rendered in the experiments tab. Source preference:
  //   1. Real API rows (always preferred when present, on any plan).
  //   2. Demo cards (free / trial only — paid sees the connect-CTA).
  const demoExperiments: Experiment[] = DEMO_EXPERIMENTS.map((exp) => ({
    ...exp,
    ownerName,
  }));
  const fallbackExperiments: Experiment[] = isPaid ? [] : demoExperiments;

  const runningCount = hasRealApiExperiments
    ? apiExperiments!.filter((e) => e.status === "running").length
    : fallbackExperiments.filter((e) => e.status === "running").length;

  const experimentsTabCount = hasRealApiExperiments
    ? apiExperiments!.length
    : fallbackExperiments.length;
  const channelsTabCount = hasRealChannels
    ? posthogChannelsData!.payload.channels.length
    : isPaid
      ? 0
      : DEMO_CHANNELS.length;
  const tabItems = [
    { value: "experiments", label: `Experiments · ${experimentsTabCount}` },
    { value: "channels", label: `Channels · ${channelsTabCount}` },
    { value: "funnel", label: "Funnel" },
    { value: "paid", label: "Paid" },
  ];

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
        {!hasTeammates && !hasPostHogData ? (
          <EmptyState
            icon={TrendingUp}
            message="No one's running growth yet. Hire a Head of Growth and the experiments, channels, and funnel will fill in on their first shift."
            action="Hire a Head of Growth"
            onAction={() => navigate("/agents/new")}
          />
        ) : (
          <>
            {activeTab === "experiments" &&
              (isPaid && !hasRealApiExperiments ? (
                <AnalyticsConnectPrompt surface="experiments" />
              ) : (
                <ExperimentsTab
                  experiments={fallbackExperiments}
                  apiExperiments={apiExperiments}
                  ownerName={ownerName}
                  pushToast={pushToast}
                />
              ))}
            {activeTab === "channels" &&
              (isPaid && !hasRealChannels ? (
                <AnalyticsConnectPrompt surface="channels" />
              ) : (
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
                      : DEMO_CHANNELS.map((ch) => (
                          <ChannelCard key={ch.id} channel={ch} />
                        ))}
                  </div>
                  {hasRealChannels && (
                    <DataSourceCaption fetchedAt={posthogChannelsData!.fetchedAt} />
                  )}
                </div>
              ))}
            {activeTab === "funnel" && companyId && (
              <FunnelDiagnostics companyId={companyId} />
            )}
            {activeTab === "funnel" && !companyId && (
              <EmptyState
                icon={TrendingUp}
                message="Funnel diagnostics need a company context. Pick a workspace from the sidebar."
              />
            )}
            {activeTab === "paid" && <PaidTab pushToast={pushToast} isPaid={isPaid} />}
          </>
        )}
      </div>
    </div>
  );
}
