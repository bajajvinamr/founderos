import { useQuery } from "@tanstack/react-query";
import { TrendingUp, TrendingDown, Minus, AlertTriangle } from "lucide-react";
import { financeApi, type CockpitMetrics, type Confidence } from "@/api/finance";
import { queryKeys } from "../../../lib/queryKeys";
import { cn } from "../../../lib/utils";

/**
 * Revenue cockpit (S5.1) — live MRR/ARR/churn/LTV/CAC/payback view.
 *
 * Reads `GET /api/companies/:id/finance/cockpit` and surfaces every
 * metric with its confidence band. Empty workspaces (no Stripe events
 * yet) render an explicit "Connect Stripe to see revenue" CTA rather
 * than a deceptive set of zeros.
 */
export function RevenueCockpit({ companyId }: { companyId: string }) {
  const cockpitQuery = useQuery({
    queryKey: queryKeys.finance.cockpit(companyId),
    queryFn: () => financeApi.cockpit(companyId),
  });

  if (cockpitQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }
  if (cockpitQuery.error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
        Failed to load cockpit:{" "}
        {cockpitQuery.error instanceof Error
          ? cockpitQuery.error.message
          : "unknown error"}
      </div>
    );
  }
  if (!cockpitQuery.data) return null;

  const m = cockpitQuery.data;
  const isEmpty = m.customerCount.total === 0;

  if (isEmpty) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-muted/20 px-6 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          Connect Stripe to see live revenue, churn, LTV, and CAC.
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          Until then, use Settings → Finance to enter cash + monthly burn.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard
          label="MRR"
          value={formatCents(m.mrr.cents)}
          delta={`${m.mrr.deltaPctMoM >= 0 ? "+" : ""}${m.mrr.deltaPctMoM.toFixed(1)}% MoM`}
          trend={m.mrr.deltaPctMoM > 0 ? "up" : m.mrr.deltaPctMoM < 0 ? "down" : "flat"}
          confidence={m.mrr.confidence}
        />
        <MetricCard
          label="ARR"
          value={formatCents(m.arr.cents)}
          confidence={m.mrr.confidence}
        />
        <MetricCard
          label="Paying customers"
          value={String(m.customerCount.paying)}
          delta={`${m.customerCount.total} total`}
          trend="flat"
          confidence="high"
        />
        <MetricCard
          label="ARPU"
          value={formatCents(m.arpu.cents)}
          confidence="high"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <MetricCard
          label="30-day churn"
          value={`${m.churn.rate30dPct.toFixed(1)}%`}
          delta={`-${formatCents(m.churn.lostMrrCents)} lost MRR`}
          trend="down"
          confidence={m.churn.confidence}
        />
        <MetricCard
          label="LTV"
          value={
            m.ltv.confidence === "insufficient_data"
              ? "—"
              : formatCents(m.ltv.cents)
          }
          delta={`n=${m.ltv.sampleSize}`}
          trend="flat"
          confidence={m.ltv.confidence}
        />
        <MetricCard
          label="Payback"
          value={
            m.paybackMonths.value === null
              ? "—"
              : `${m.paybackMonths.value.toFixed(1)} mo`
          }
          confidence={m.paybackMonths.confidence}
        />
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-sm font-semibold">CAC by channel</h3>
          <span className="text-xs text-muted-foreground">
            {m.cac.confidence === "insufficient_data"
              ? "no signal"
              : `confidence: ${m.cac.confidence}`}
          </span>
        </div>
        {m.cac.cents === null ? (
          <p className="text-sm text-muted-foreground">
            {m.cac.note ?? "Add marketing spend to see CAC."}
          </p>
        ) : (
          <>
            <div className="text-2xl font-semibold tabular-nums mb-2">
              {formatCents(m.cac.cents)}{" "}
              <span className="text-xs font-normal text-muted-foreground">
                blended
              </span>
            </div>
            {m.cac.channelBreakdown.length > 0 && (
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="text-left font-medium pb-1">Channel</th>
                    <th className="text-right font-medium pb-1">Spend</th>
                    <th className="text-right font-medium pb-1">CAC</th>
                  </tr>
                </thead>
                <tbody>
                  {m.cac.channelBreakdown.map((row) => (
                    <tr key={row.channel} className="border-t border-border">
                      <td className="py-1.5 capitalize">
                        {row.channel.replace(/_/g, " ")}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatCents(row.spendCents)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums font-semibold">
                        {formatCents(row.cac)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {m.cac.note && (
              <p className="text-xs text-muted-foreground mt-2 flex items-start gap-1">
                <AlertTriangle className="size-3 mt-0.5 shrink-0" />
                {m.cac.note}
              </p>
            )}
          </>
        )}
      </div>

      {m.cash.cents !== null && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold mb-2">Cash + runway</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-muted-foreground">Cash on hand</p>
              <p className="text-lg font-semibold tabular-nums">
                {formatCents(m.cash.cents)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">
                Runway (revenue-adjusted)
              </p>
              <p className="text-lg font-semibold tabular-nums">
                {m.cash.runwayMonths === null
                  ? "—"
                  : m.cash.runwayMonths === Infinity
                    ? "∞"
                    : `${m.cash.runwayMonths.toFixed(1)} months`}
              </p>
            </div>
          </div>
          {m.grossMarginPct.assumed && (
            <p className="text-xs text-muted-foreground mt-2">
              Assumes {m.grossMarginPct.value}% gross margin (placeholder).
              Configure under Settings when infra cost data lands.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

interface MetricCardProps {
  label: string;
  value: string;
  delta?: string;
  trend?: "up" | "down" | "flat";
  confidence: Confidence;
}

function MetricCard({ label, value, delta, trend = "flat", confidence }: MetricCardProps) {
  const TrendIcon = trend === "up" ? TrendingUp : trend === "down" ? TrendingDown : Minus;
  const trendColor =
    trend === "up"
      ? "text-emerald-600 dark:text-emerald-400"
      : trend === "down"
        ? "text-red-600 dark:text-red-400"
        : "text-muted-foreground";

  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-2">
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground flex items-center justify-between">
        <span>{label}</span>
        <ConfidenceDot confidence={confidence} />
      </p>
      <p className="font-display tabular-nums text-[28px] leading-none tracking-tight">
        {value}
      </p>
      {delta && (
        <div className={cn("flex items-center gap-1 text-[12px] font-medium", trendColor)}>
          <TrendIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="tabular-nums">{delta}</span>
        </div>
      )}
    </div>
  );
}

function ConfidenceDot({ confidence }: { confidence: Confidence }) {
  if (confidence === "insufficient_data") {
    return (
      <span
        title="insufficient data — too few samples to be confident"
        className="size-2 rounded-full bg-muted-foreground/40"
      />
    );
  }
  const color =
    confidence === "high"
      ? "bg-emerald-500"
      : confidence === "medium"
        ? "bg-amber-500"
        : "bg-orange-500";
  return (
    <span
      title={`confidence: ${confidence}`}
      className={cn("size-2 rounded-full", color)}
    />
  );
}

function formatCents(cents: number): string {
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 1_000_000) {
    return `$${(dollars / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(dollars) >= 10_000) {
    return `$${(dollars / 1_000).toFixed(1)}k`;
  }
  return `$${dollars.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// Type-import nudge for unused-import lint suppression.
export type { CockpitMetrics };
