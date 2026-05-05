import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  Target,
  Flame,
  Clock,
  Users,
  Zap,
  Landmark,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { queryKeys } from "../lib/queryKeys";
import { integrationHealthApi, type KpiFreshness } from "../api/integration-health";
import { timeAgo } from "../lib/timeAgo";

/** Keep in sync with packages/db/src/schema/companies.ts → CompanyMetrics */
type Delta = { dir: "up" | "down" | "flat"; text: string };
export type CompanyMetrics = {
  stage?: string;
  tagline?: string;
  fundingRaisedCents?: number;
  mrrCents?: number;
  arrCents?: number;
  gmvMonthlyCents?: number;
  pipelineCents?: number;
  pipelineCount?: number;
  customersSigned?: number;
  monthlyBurnCents?: number;
  runwayMonths?: number;
  keyAccounts?: string[];
  nextMilestoneLabel?: string;
  mauCount?: number;
  deltas?: Record<string, Delta>;
  /** Free-form markdown mission statement injected into every agent's standing prompt. */
  charter?: string;
};

type PulseMetric = {
  label: string;
  /** Key into KpiFreshness (for freshness indicator lookup). */
  freshnessKey?: keyof KpiFreshness;
  value: string;
  delta?: Delta;
  sub?: string;
  icon: typeof DollarSign;
};

interface CompanyPulseWidgetProps {
  companyName: string | undefined;
  metrics: CompanyMetrics | undefined | null;
  /** When provided, freshness indicators are shown under each KPI tile. */
  companyId?: string;
}

/**
 * Dashboard widget that surfaces business-level KPIs from the company's
 * stored metrics JSON. Pulls from DB via the company object — no hardcoded
 * per-company data.
 *
 * When `companyId` is supplied, also queries /api/companies/:id/kpi-freshness
 * and renders a "synced Xm ago" badge under each KPI tile.
 */
export function CompanyPulseWidget({ companyName, metrics, companyId }: CompanyPulseWidgetProps) {
  const { data: freshness } = useQuery({
    queryKey: queryKeys.integrationHealth.kpiFreshness(companyId ?? ""),
    queryFn: () => integrationHealthApi.kpiFreshness(companyId!),
    enabled: !!companyId,
    staleTime: 60_000,
  });

  if (!companyName || !metrics || isEmpty(metrics)) return null;

  const pulseMetrics = buildMetrics(metrics);

  return (
    <section
      aria-label="Company pulse"
      className="relative rounded-lg border border-border bg-card"
    >
      <div className="p-6">
        <div className="flex items-start justify-between mb-5 gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground mb-2">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--brand)]" />
              Company pulse
            </div>
            {metrics.tagline && (
              <div className="font-display text-[22px] leading-[1.15] tracking-tight text-foreground max-w-xl">
                {metrics.tagline}
              </div>
            )}
          </div>
          {metrics.stage && (
            <span className="inline-flex items-center rounded-md border border-border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {metrics.stage}
            </span>
          )}
        </div>

        {pulseMetrics.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {pulseMetrics.map((m) => (
              <PulseCell
                key={m.label}
                metric={m}
                freshness={m.freshnessKey && freshness ? freshness[m.freshnessKey] : null}
              />
            ))}
          </div>
        )}

        {metrics.keyAccounts && metrics.keyAccounts.length > 0 && (
          <div className="mt-4 pt-4 border-t border-border flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Key accounts
            </span>
            <div className="flex items-center gap-1.5 flex-wrap">
              {metrics.keyAccounts.map((c) => (
                <span
                  key={c}
                  className="inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium bg-secondary text-secondary-foreground border border-border"
                >
                  {c}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function isEmpty(m: CompanyMetrics): boolean {
  return !m.stage && !m.tagline && !m.fundingRaisedCents && !m.mrrCents && !m.arrCents &&
    !m.gmvMonthlyCents && !m.pipelineCents && !m.pipelineCount && !m.monthlyBurnCents &&
    !m.runwayMonths && !m.mauCount;
}

/**
 * Pick the 4 most important metrics to display based on what's set.
 * Priority buckets:
 *  - Funding/ARR/GMV signal (revenue or traction)
 *  - Pipeline/customers/MAU (growth signal)
 *  - Monthly burn (ops signal)
 *  - Runway or milestone (future signal)
 */
function buildMetrics(m: CompanyMetrics): PulseMetric[] {
  const out: PulseMetric[] = [];
  const deltas = m.deltas ?? {};

  // Revenue/funding signal
  if (m.arrCents && m.arrCents > 0) {
    out.push({ label: "ARR", freshnessKey: "arr", value: formatMoney(m.arrCents), delta: deltas.arr, sub: m.customersSigned ? `${m.customersSigned} paying accounts` : undefined, icon: DollarSign });
  } else if (m.mrrCents && m.mrrCents > 0) {
    out.push({ label: "MRR", freshnessKey: "mrr", value: formatMoney(m.mrrCents), delta: deltas.mrr, icon: DollarSign });
  } else if (m.gmvMonthlyCents && m.gmvMonthlyCents > 0) {
    out.push({ label: "GMV / mo", value: formatMoney(m.gmvMonthlyCents), delta: deltas.gmvMonthly, sub: "marketplace volume", icon: DollarSign });
  } else if (m.fundingRaisedCents && m.fundingRaisedCents > 0) {
    out.push({ label: "Raised", value: formatMoney(m.fundingRaisedCents), delta: deltas.fundingRaised, sub: m.stage?.includes("Pre-seed") ? "pre-seed" : "to date", icon: Landmark });
  } else if (m.fundingRaisedCents === 0) {
    out.push({ label: "Raised", value: "—", delta: { dir: "flat", text: "bootstrapped" }, sub: "raising first round", icon: Landmark });
  }

  // Growth signal
  if (m.mauCount && m.mauCount > 0) {
    out.push({ label: "MAU", value: formatCompact(m.mauCount), delta: deltas.mau, icon: Users });
  } else if (m.pipelineCount !== undefined && m.pipelineCount > 0) {
    out.push({
      label: "Pipeline",
      freshnessKey: "pipeline",
      value: m.pipelineCount.toString(),
      delta: deltas.pipeline,
      sub: m.pipelineCents ? `${formatMoney(m.pipelineCents)} weighted` : (m.customersSigned ? `${m.customersSigned} signed` : undefined),
      icon: Target,
    });
  } else if (m.customersSigned && m.customersSigned > 0) {
    out.push({ label: "Customers", value: m.customersSigned.toString(), delta: deltas.customersSigned, sub: m.stage?.includes("seed") || m.stage?.includes("Pre-seed") ? "design partners" : undefined, icon: Users });
  }

  // Burn
  if (m.monthlyBurnCents !== undefined && m.monthlyBurnCents > 0) {
    out.push({ label: "Monthly burn", freshnessKey: "burn", value: formatMoney(m.monthlyBurnCents), delta: deltas.monthlyBurn, icon: Flame });
  }

  // Runway or milestone
  if (m.runwayMonths !== undefined && m.runwayMonths > 0) {
    out.push({ label: "Runway", freshnessKey: "runway", value: `${m.runwayMonths} mo`, delta: deltas.runway, sub: m.nextMilestoneLabel ? `→ ${m.nextMilestoneLabel}` : undefined, icon: Clock });
  } else if (m.nextMilestoneLabel) {
    out.push({ label: "Next", value: m.nextMilestoneLabel, icon: Zap });
  }

  return out.slice(0, 4);
}

function formatMoney(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(dollars >= 10_000_000 ? 0 : 1)}M`;
  if (dollars >= 1_000) return `$${Math.round(dollars / 1_000)}K`;
  return `$${dollars.toFixed(0)}`;
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return n.toString();
}

// ---------------------------------------------------------------------------
// Freshness badge
// ---------------------------------------------------------------------------

const FRESHNESS_THRESHOLDS = {
  red: 60 * 60 * 1000,    // > 1h old
  yellow: 15 * 60 * 1000, // > 15m old
} as const;

/** Returns the Tailwind colour class for a lastSyncAt timestamp. */
export function freshnessColor(lastSyncAt: string | null): string {
  if (!lastSyncAt) return "text-muted-foreground/60";
  const age = Date.now() - new Date(lastSyncAt).getTime();
  if (age > FRESHNESS_THRESHOLDS.red) return "text-red-500 dark:text-red-400";
  if (age > FRESHNESS_THRESHOLDS.yellow) return "text-amber-500 dark:text-amber-400";
  return "text-emerald-600 dark:text-emerald-400";
}

function FreshnessBadge({ entry }: { entry: { sourceLastSync: string | null } | null }) {
  if (!entry) return null;
  const { sourceLastSync } = entry;
  const color = freshnessColor(sourceLastSync);
  return (
    <p className={cn("mt-1.5 text-[10px] tabular-nums", color)}>
      {sourceLastSync ? `synced ${timeAgo(sourceLastSync)}` : "never synced"}
    </p>
  );
}

// ---------------------------------------------------------------------------
// PulseCell
// ---------------------------------------------------------------------------

function PulseCell({
  metric,
  freshness,
}: {
  metric: PulseMetric;
  freshness: { sourceLastSync: string | null } | null | undefined;
}) {
  const Icon = metric.icon;
  const DeltaIcon =
    metric.delta?.dir === "up"
      ? TrendingUp
      : metric.delta?.dir === "down"
        ? TrendingDown
        : null;
  const deltaColor =
    metric.delta?.dir === "up"
      ? "text-emerald-600 dark:text-emerald-400"
      : metric.delta?.dir === "down"
        ? "text-red-600 dark:text-red-400"
        : "text-muted-foreground";

  return (
    <div className="border-l border-border pl-4 py-1">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground mb-1.5">
        <Icon className="h-3 w-3" />
        {metric.label}
      </div>
      <div className="flex items-baseline gap-2 flex-wrap">
        <div className="text-[28px] font-display leading-none tabular-nums text-foreground">
          {metric.value}
        </div>
        {metric.delta && (
          <div className={cn("flex items-center gap-0.5 text-[11px] font-medium", deltaColor)}>
            {DeltaIcon && <DeltaIcon className="h-3 w-3" />}
            <span>{metric.delta.text}</span>
          </div>
        )}
      </div>
      {metric.sub && (
        <div className="mt-1 text-[11px] text-muted-foreground leading-snug">{metric.sub}</div>
      )}
      {metric.freshnessKey && freshness !== undefined && (
        <FreshnessBadge entry={freshness ?? null} />
      )}
    </div>
  );
}
