import { useState } from "react";
import { useSearchParams } from "@/lib/router";
import { Tabs } from "@/components/ui/tabs";
import { PageTabBar } from "@/components/PageTabBar";
import { Button } from "@/components/ui/button";
import { useToast } from "../../context/ToastContext";
import { cn } from "../../lib/utils";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import type { Agent } from "@founderos/shared";

// MOCK — Wave 5 replaces with real finance service (Stripe/QuickBooks/etc)

// ─── Types ───────────────────────────────────────────────────────────────────

type FinanceTab = "revenue" | "forecast" | "pricing" | "burn";

const VALID_TABS: FinanceTab[] = ["revenue", "forecast", "pricing", "burn"];

function isValidTab(v: string | null): v is FinanceTab {
  return VALID_TABS.includes(v as FinanceTab);
}

type MrrEventType = "new" | "upgrade" | "downgrade" | "churn" | "expansion";

interface MrrEvent {
  id: string;
  date: string;
  type: MrrEventType;
  customer: string;
  amount: number; // positive = gain, negative = loss
  balance: number;
}

interface BurnCategory {
  id: string;
  label: string;
  description: string;
  amountPerMonth: number;
  delta: number; // MoM change in dollars
  trend: "up" | "down" | "flat";
}

// ─── Mock data ────────────────────────────────────────────────────────────────

const MRR = 18420;
const ARR = MRR * 12;
const PAYING_CUSTOMERS = 43;
const NEW_MRR = 3200;
const CHURNED_MRR = 860;
const NRR = 108; // percent
const GROSS_CHURN_PCT = 4.7;
const MONTHLY_BURN = 8958;
const CASH_ON_HAND = 55500; // 6.2 months runway at $8,958 burn

const MOCK_MRR_EVENTS: MrrEvent[] = [
  { id: "e-1",  date: "Apr 20", type: "new",       customer: "Acme Labs",        amount:  1200, balance: 18420 },
  { id: "e-2",  date: "Apr 19", type: "expansion",  customer: "Everbright",       amount:   400, balance: 17220 },
  { id: "e-3",  date: "Apr 18", type: "churn",      customer: "Pixel Kitchen",    amount:  -240, balance: 16820 },
  { id: "e-4",  date: "Apr 17", type: "new",        customer: "Current Capital",  amount:   800, balance: 17060 },
  { id: "e-5",  date: "Apr 15", type: "upgrade",    customer: "Atlas Health",     amount:   600, balance: 16260 },
  { id: "e-6",  date: "Apr 14", type: "new",        customer: "Maple Data",       amount:   500, balance: 15660 },
  { id: "e-7",  date: "Apr 12", type: "downgrade",  customer: "Glass Co",         amount:  -200, balance: 15160 },
  { id: "e-8",  date: "Apr 11", type: "expansion",  customer: "Nova Studios",     amount:   300, balance: 15360 },
  { id: "e-9",  date: "Apr 10", type: "new",        customer: "Harborside Labs",  amount:   900, balance: 15060 },
  { id: "e-10", date: "Apr 8",  type: "churn",      customer: "Rook Coffee",      amount:  -420, balance: 14160 },
  { id: "e-11", date: "Apr 7",  type: "upgrade",    customer: "Midnight Audio",   amount:   250, balance: 14580 },
  { id: "e-12", date: "Apr 5",  type: "new",        customer: "Wayfarer Press",   amount:  1500, balance: 14330 },
  { id: "e-13", date: "Apr 3",  type: "expansion",  customer: "Rookwood Systems", amount:   180, balance: 12830 },
  { id: "e-14", date: "Apr 1",  type: "new",        customer: "Obsidian Stack",   amount:   650, balance: 12650 },
];

// 12-month MRR projection at ~12% MoM growth starting from $18,420
const FORECAST_MONTHS = ["May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr"];
const FORECAST_MRR: number[] = (() => {
  const values: number[] = [];
  let v = MRR;
  for (let i = 0; i < 12; i++) {
    v = Math.round(v * 1.12);
    values.push(v);
  }
  return values;
})();

const MOCK_BURN_CATEGORIES: BurnCategory[] = [
  {
    id: "b-1",
    label: "Provider spend (AI)",
    description: "Claude, Codex, Gemini",
    amountPerMonth: 342,
    delta: 24,
    trend: "up",
  },
  {
    id: "b-2",
    label: "Infra (Fly.io + DB)",
    description: "Fly.io, Supabase, Redis",
    amountPerMonth: 89,
    delta: 0,
    trend: "flat",
  },
  {
    id: "b-3",
    label: "Tools (Slack, Notion, Linear)",
    description: "SaaS subscriptions",
    amountPerMonth: 187,
    delta: 0,
    trend: "flat",
  },
  {
    id: "b-4",
    label: "Marketing (content, outbound)",
    description: "Content production, outbound tools",
    amountPerMonth: 340,
    delta: 80,
    trend: "up",
  },
  {
    id: "b-5",
    label: "Founder cost",
    description: "Salary / draw",
    amountPerMonth: 8000,
    delta: 0,
    trend: "flat",
  },
];

// 12-month burn history (slightly decreasing as infra optimizations kicked in)
const BURN_HISTORY = [9800, 9600, 9400, 9300, 9200, 9100, 9050, 9000, 8980, 8970, 8960, 8958];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDollars(n: number): string {
  if (Math.abs(n) >= 1000) {
    return `$${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `$${n}`;
}

function formatDollarsFull(n: number): string {
  return `$${n.toLocaleString()}`;
}

// ─── Metric card (Revenue cockpit) ───────────────────────────────────────────

interface MetricCardProps {
  label: string;
  value: string;
  delta: string;
  trend: "up" | "down" | "flat";
  deltaNote?: string;
}

function MetricCard({ label, value, delta, trend, deltaNote }: MetricCardProps) {
  const TrendIcon = trend === "up" ? TrendingUp : trend === "down" ? TrendingDown : Minus;
  const trendColor =
    trend === "up"
      ? "text-emerald-600 dark:text-emerald-400"
      : trend === "down"
        ? "text-red-600 dark:text-red-400"
        : "text-muted-foreground";

  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-2">
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p className="font-display tabular-nums text-[28px] leading-none tracking-tight text-foreground">
        {value}
      </p>
      <div className={cn("flex items-center gap-1 text-[12px] font-medium", trendColor)}>
        <TrendIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="tabular-nums">{delta}</span>
        {deltaNote && (
          <span className="text-muted-foreground font-normal ml-0.5">· {deltaNote}</span>
        )}
      </div>
    </div>
  );
}

// ─── MRR event type pill ──────────────────────────────────────────────────────

const EVENT_PILL_CLASSES: Record<MrrEventType, string> = {
  new:       "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/25",
  expansion: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/25",
  upgrade:   "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/25",
  churn:     "bg-red-500/10 text-red-700 dark:text-red-400 border border-red-500/25",
  downgrade: "bg-red-500/10 text-red-700 dark:text-red-400 border border-red-500/25",
};

const EVENT_LABELS: Record<MrrEventType, string> = {
  new:       "New",
  expansion: "Expansion",
  upgrade:   "Upgrade",
  churn:     "Churn",
  downgrade: "Downgrade",
};

function EventTypePill({ type }: { type: MrrEventType }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.07em] whitespace-nowrap",
        EVENT_PILL_CLASSES[type],
      )}
    >
      {EVENT_LABELS[type]}
    </span>
  );
}

// ─── Revenue tab ──────────────────────────────────────────────────────────────

function RevenueTab() {
  const metrics: MetricCardProps[] = [
    {
      label: "MRR",
      value: formatDollarsFull(MRR),
      delta: "+12% MoM",
      trend: "up",
    },
    {
      label: "ARR",
      value: formatDollarsFull(ARR),
      delta: "+12% MoM",
      trend: "up",
    },
    {
      label: "Paying customers",
      value: String(PAYING_CUSTOMERS),
      delta: "+4 this month",
      trend: "up",
    },
    {
      label: "New MRR",
      value: formatDollarsFull(NEW_MRR),
      delta: "+$3,200 this month",
      trend: "up",
    },
    {
      label: "Churned MRR",
      value: `-${formatDollarsFull(CHURNED_MRR)}`,
      delta: `-${GROSS_CHURN_PCT}% gross churn`,
      trend: "down",
    },
    {
      label: "Net Revenue Retention",
      value: `${NRR}%`,
      delta: "Expansion > churn",
      trend: "up",
    },
  ];

  // Totals for footer
  const totalIn = MOCK_MRR_EVENTS
    .filter((e) => e.amount > 0)
    .reduce((s, e) => s + e.amount, 0);
  const totalOut = MOCK_MRR_EVENTS
    .filter((e) => e.amount < 0)
    .reduce((s, e) => s + e.amount, 0);

  return (
    <div className="space-y-6">
      {/* 6-card cockpit */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {metrics.map((m) => (
          <MetricCard key={m.label} {...m} />
        ))}
      </div>

      {/* MRR movement table */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            MRR movement · last 14 events
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/20">
                <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground whitespace-nowrap">
                  Date
                </th>
                <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  Type
                </th>
                <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  Customer
                </th>
                <th className="text-right px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground tabular-nums">
                  Amount
                </th>
                <th className="text-right px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground tabular-nums">
                  MRR balance
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {MOCK_MRR_EVENTS.map((ev) => {
                const isGain = ev.amount > 0;
                return (
                  <tr key={ev.id} className="hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3 tabular-nums text-[12px] text-muted-foreground whitespace-nowrap font-mono">
                      {ev.date}
                    </td>
                    <td className="px-4 py-3">
                      <EventTypePill type={ev.type} />
                    </td>
                    <td className="px-4 py-3 text-[12px] font-medium text-foreground">
                      {ev.customer}
                    </td>
                    <td
                      className={cn(
                        "px-4 py-3 text-right tabular-nums text-[12px] font-semibold",
                        isGain
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-red-600 dark:text-red-400",
                      )}
                    >
                      {isGain ? "+" : ""}
                      {formatDollarsFull(ev.amount)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-[12px] text-foreground font-mono">
                      {formatDollarsFull(ev.balance)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-border bg-muted/20">
                <td
                  colSpan={3}
                  className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
                >
                  Period totals
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-[12px] font-bold">
                  <span className="text-emerald-600 dark:text-emerald-400">
                    +{formatDollarsFull(totalIn)}
                  </span>
                  <span className="text-muted-foreground/40 mx-1">/</span>
                  <span className="text-red-600 dark:text-red-400">
                    {formatDollarsFull(totalOut)}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-[12px] font-bold text-foreground font-mono">
                  {formatDollarsFull(MRR)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Forecast tab ─────────────────────────────────────────────────────────────

function ForecastTab() {
  const maxMrr = Math.max(...FORECAST_MRR);
  // Label only first, middle (idx 5), last
  const labeledIdx = new Set([0, 5, 11]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Left: Runway scenarios */}
        <div className="rounded-lg border border-border bg-card p-5 flex flex-col gap-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Runway scenarios
          </p>
          <div className="space-y-4">
            {/* Base */}
            <div className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-semibold text-foreground">Base case</span>
                <span className="font-display tabular-nums text-[26px] leading-none text-[var(--brand,theme(colors.teal.500))]">
                  6.2 mo
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Current $18k MRR + $8,958 burn · $55.5k cash
              </p>
            </div>
            <div className="border-t border-border/60" />
            {/* Downside */}
            <div className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-semibold text-foreground">
                  Downside{" "}
                  <span className="text-red-500 text-[11px] font-normal">−20% MRR</span>
                </span>
                <span className="font-display tabular-nums text-[26px] leading-none text-red-600 dark:text-red-400">
                  4.8 mo
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                MRR drops to $14.7k; burn unchanged
              </p>
            </div>
            <div className="border-t border-border/60" />
            {/* Upside */}
            <div className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-semibold text-foreground">
                  Upside{" "}
                  <span className="text-emerald-600 dark:text-emerald-400 text-[11px] font-normal">
                    +30% MRR
                  </span>
                </span>
                <span className="font-display tabular-nums text-[26px] leading-none text-emerald-600 dark:text-emerald-400">
                  9.1 mo
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                MRR grows to $23.9k; burn slightly higher
              </p>
            </div>
          </div>
        </div>

        {/* Right: Revenue trajectory (CSS-only bar chart) */}
        <div className="rounded-lg border border-border bg-card p-5 flex flex-col gap-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            12-month MRR trajectory · 12% MoM
          </p>
          <div className="flex items-end gap-1 h-32 mt-1">
            {FORECAST_MRR.map((mrr, i) => {
              const pct = Math.round((mrr / maxMrr) * 100);
              const showLabel = labeledIdx.has(i);
              return (
                <div key={i} className="flex flex-col items-center gap-1 flex-1">
                  {showLabel && (
                    <span className="tabular-nums text-[9px] text-muted-foreground/70 font-mono leading-none">
                      {formatDollars(mrr)}
                    </span>
                  )}
                  {!showLabel && <span className="h-[13px]" />}
                  <div
                    className="w-full rounded-sm bg-[var(--brand,theme(colors.teal.500))]/40 hover:bg-[var(--brand,theme(colors.teal.500))]/70 transition-colors"
                    style={{ height: `${pct}%` }}
                    title={`${FORECAST_MONTHS[i]}: ${formatDollarsFull(mrr)} MRR`}
                  />
                </div>
              );
            })}
          </div>
          <div className="flex items-center justify-between text-[9px] text-muted-foreground/50 tabular-nums font-mono -mt-1">
            {FORECAST_MONTHS.map((m) => (
              <span key={m}>{m}</span>
            ))}
          </div>
        </div>
      </div>

      {/* Narrative callout */}
      <div className="rounded-lg border border-border bg-muted/20 px-5 py-4">
        <p className="text-[13px] text-foreground/80 leading-relaxed">
          <span className="font-semibold text-foreground">At 12% MoM growth,</span> you cross
          $35k MRR around month 8 — the natural raise window for a seed round. You hit $50k MRR
          by month 11. Staying default-alive through that window means you can raise from
          strength, not necessity. The downside scenario still keeps you alive — no pivot required.
        </p>
      </div>
    </div>
  );
}

// ─── Pricing tab ──────────────────────────────────────────────────────────────

function PricingTab({
  pushToast,
}: {
  pushToast: (input: { title: string; body: string }) => void;
}) {
  const [soloPrice, setSoloPrice] = useState(299);
  const [leanPrice, setLeanPrice] = useState(2000);
  const [churnIncrease, setChurnIncrease] = useState(5);
  const [newCxDecrease, setNewCxDecrease] = useState(15);

  // Static estimated impact (mock calculation from defaults)
  const newMrr = 28400;
  const newChurn = 7.2;
  const paybackDelta = -0.4;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {/* Left: Current tier table */}
      <div className="flex flex-col gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Current pricing tiers
        </p>
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/20">
                <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  Tier
                </th>
                <th className="text-right px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground tabular-nums">
                  Price
                </th>
                <th className="text-right px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground tabular-nums">
                  Cx
                </th>
                <th className="text-right px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground tabular-nums">
                  MRR
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[
                { tier: "Solo Founder",    price: 299,   cx: 12, mrr: 3588 },
                { tier: "Lean Team",       price: 2000,  cx: 6,  mrr: 12000 },
                { tier: "Venture Studio",  price: 10000, cx: 1,  mrr: 10000 },
              ].map((row) => (
                <tr key={row.tier} className="hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3 text-[12px] font-medium text-foreground">
                    {row.tier}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-[12px] text-muted-foreground font-mono">
                    ${row.price.toLocaleString()}/mo
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-[12px] text-foreground">
                    {row.cx}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-[12px] font-semibold text-foreground">
                    {formatDollarsFull(row.mrr)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border bg-muted/20">
                <td className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  Total
                </td>
                <td className="px-4 py-2.5" />
                <td className="px-4 py-2.5 text-right tabular-nums text-[12px] font-bold text-foreground">
                  19
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-[12px] font-bold text-foreground">
                  $25,588
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Right: Scenario inputs + impact */}
      <div className="flex flex-col gap-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Pricing simulator
        </p>

        <div className="rounded-lg border border-border bg-card p-4 space-y-4">
          {/* Inputs */}
          {[
            {
              label: "Solo Founder price",
              value: soloPrice,
              step: 50,
              unit: "$",
              onChange: setSoloPrice,
            },
            {
              label: "Lean Team price",
              value: leanPrice,
              step: 100,
              unit: "$",
              onChange: setLeanPrice,
            },
            {
              label: "Expected churn from price hike",
              value: churnIncrease,
              step: 1,
              unit: "%",
              onChange: setChurnIncrease,
            },
            {
              label: "Expected new-customer decrease",
              value: newCxDecrease,
              step: 5,
              unit: "%",
              onChange: setNewCxDecrease,
            },
          ].map(({ label, value, step, unit, onChange }) => (
            <div key={label} className="flex flex-col gap-1.5">
              <label className="text-[12px] font-medium text-foreground">{label}</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={value}
                  step={step}
                  onChange={(e) => onChange(Number(e.target.value))}
                  className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-[13px] tabular-nums text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--brand,theme(colors.teal.500))]/40"
                />
                <span className="text-[12px] text-muted-foreground w-6">{unit}</span>
              </div>
            </div>
          ))}

          <Button
            className="w-full mt-1"
            onClick={() =>
              pushToast({
                title: "Wave 5",
                body: "Wave 5 wires this to the real pricing engine.",
              })
            }
          >
            Simulate
          </Button>
        </div>

        {/* Estimated impact */}
        <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Estimated impact (defaults)
          </p>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[13px]">
              <span className="text-muted-foreground">New MRR</span>
              <span className="tabular-nums font-semibold text-emerald-600 dark:text-emerald-400">
                {formatDollarsFull(newMrr)}{" "}
                <span className="text-[11px] font-normal">(+11%)</span>
              </span>
            </div>
            <div className="flex items-center justify-between text-[13px]">
              <span className="text-muted-foreground">New churn rate</span>
              <span className="tabular-nums font-semibold text-red-600 dark:text-red-400">
                {newChurn}%
              </span>
            </div>
            <div className="flex items-center justify-between text-[13px]">
              <span className="text-muted-foreground">Payback delta</span>
              <span className="tabular-nums font-semibold text-emerald-600 dark:text-emerald-400">
                {paybackDelta} months
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Burn tab ─────────────────────────────────────────────────────────────────

function BurnTab() {
  const maxBurn = Math.max(...BURN_HISTORY);
  const PLAN_BURN = 10000;
  const saved = PLAN_BURN - MONTHLY_BURN;

  return (
    <div className="space-y-6">
      {/* Burn category list */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Monthly burn breakdown
          </p>
        </div>
        <div className="divide-y divide-border">
          {MOCK_BURN_CATEGORIES.map((cat) => {
            const TrendIcon =
              cat.trend === "up" ? TrendingUp : cat.trend === "down" ? TrendingDown : Minus;
            const trendColor =
              cat.trend === "up"
                ? "text-red-600 dark:text-red-400"   // up spend = bad
                : cat.trend === "down"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground";

            return (
              <div
                key={cat.id}
                className="px-4 py-3.5 flex items-start justify-between gap-3 hover:bg-muted/20 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold text-foreground">{cat.label}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">{cat.description}</p>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span className="tabular-nums text-[15px] font-bold text-foreground font-display">
                    {formatDollarsFull(cat.amountPerMonth)}/mo
                  </span>
                  {cat.delta !== 0 && (
                    <div className={cn("flex items-center gap-1 text-[11px] font-medium", trendColor)}>
                      <TrendIcon className="h-3 w-3 shrink-0" />
                      <span className="tabular-nums">
                        {cat.delta > 0 ? "+" : ""}
                        {formatDollarsFull(cat.delta)} MoM
                      </span>
                    </div>
                  )}
                  {cat.delta === 0 && (
                    <span className="text-[11px] text-muted-foreground">Flat</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {/* Totals footer */}
        <div className="px-4 py-3 border-t border-border bg-muted/20 flex items-center justify-between">
          <span className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            Total monthly burn
          </span>
          <span className="tabular-nums text-[18px] font-bold text-foreground font-display">
            {formatDollarsFull(MONTHLY_BURN)}/mo
          </span>
        </div>
      </div>

      {/* vs plan */}
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="space-y-0.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            vs. Plan
          </p>
          <p className="text-[13px] text-foreground/80">
            Plan: {formatDollarsFull(PLAN_BURN)}/mo · Actual: {formatDollarsFull(MONTHLY_BURN)}/mo
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
          <TrendingDown className="h-4 w-4 shrink-0" />
          <span className="tabular-nums text-[15px] font-bold">
            +{formatDollarsFull(saved)} saved this month
          </span>
        </div>
      </div>

      {/* 12-month burn chart */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Burn trajectory · 12 months
        </p>
        <div className="flex items-end gap-1 h-20">
          {BURN_HISTORY.map((b, i) => {
            const pct = Math.round((b / maxBurn) * 100);
            return (
              <div
                key={i}
                className="flex-1 rounded-sm bg-muted-foreground/20 hover:bg-muted-foreground/40 transition-colors"
                style={{ height: `${pct}%` }}
                title={`Month ${i + 1}: ${formatDollarsFull(b)}/mo`}
              />
            );
          })}
        </div>
        <div className="flex items-center justify-between text-[9px] text-muted-foreground/50 tabular-nums font-mono">
          <span>May '25</span>
          <span>Apr '26</span>
        </div>
      </div>

      {/* Vendor review queue callout */}
      <div className="rounded-lg border border-border bg-muted/20 px-5 py-4">
        <p className="text-[13px] text-foreground/70 leading-relaxed">
          Your Finance teammate runs a vendor review the first of every month.{" "}
          <span className="font-semibold text-foreground">Next review: May 1.</span>
        </p>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function FinanceConsole({ companyId: _companyId, agents }: {
  companyId: string | null;
  agents: Agent[];
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { pushToast } = useToast();

  const rawTab = searchParams.get("tab");
  const activeTab: FinanceTab = isValidTab(rawTab) ? rawTab : "revenue";

  function setTab(tab: FinanceTab) {
    setSearchParams({ tab });
  }

  // MOCK — Wave 5 replaces with real finance service (Stripe/etc).
  // Resolve CFO/finance teammate display name from agents prop.
  const cfoAgent = agents.find((a) => a.role === "cfo");
  const cfoName = cfoAgent?.name ?? "Ledger";
  const teammateCount = agents.length || 1;

  const currentMrr: number = MRR; // Wave 5: replace with live value
  const displayH1 =
    currentMrr === 0
      ? "Finding our pricing"
      : `${formatDollars(currentMrr)} MRR · ${(CASH_ON_HAND / MONTHLY_BURN).toFixed(1)} mo runway`;

  const tabItems: { value: string; label: string }[] = [
    { value: "revenue",  label: "Revenue"  },
    { value: "forecast", label: "Forecast" },
    { value: "pricing",  label: "Pricing"  },
    { value: "burn",     label: "Burn"     },
  ];

  void cfoName; // resolved name available for future Wave 5 wiring

  return (
    <div className="space-y-6">
      {/* Editorial page header */}
      <header className="flex flex-col gap-1.5 pt-1">
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Finance
        </div>
        <h1 className="font-display text-[32px] md:text-[40px] leading-[1.05] tracking-tight text-foreground">
          {displayH1}
        </h1>
        <p className="text-[12px] text-muted-foreground tabular-nums">
          <span className="font-medium text-foreground">
            {teammateCount} {teammateCount === 1 ? "teammate" : "teammates"}
          </span>
          <span className="mx-2 text-muted-foreground/40">·</span>
          monthly burn{" "}
          <span className="font-medium text-foreground">{formatDollarsFull(MONTHLY_BURN)}</span>
          <span className="mx-2 text-muted-foreground/40">·</span>
          cash on hand{" "}
          <span className="font-medium text-foreground">{formatDollarsFull(CASH_ON_HAND)}</span>
        </p>
      </header>

      {/* Tab bar */}
      <Tabs value={activeTab} onValueChange={(v) => setTab(v as FinanceTab)}>
        <PageTabBar
          items={tabItems}
          value={activeTab}
          onValueChange={(v) => setTab(v as FinanceTab)}
          align="start"
        />
      </Tabs>

      {/* Tab content */}
      <div>
        {activeTab === "revenue"  && <RevenueTab />}
        {activeTab === "forecast" && <ForecastTab />}
        {activeTab === "pricing"  && <PricingTab pushToast={pushToast} />}
        {activeTab === "burn"     && <BurnTab />}
      </div>
    </div>
  );
}
