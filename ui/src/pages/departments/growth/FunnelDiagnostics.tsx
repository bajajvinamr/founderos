/**
 * FunnelDiagnostics — Sprint 3 S3.7.
 *
 * Renders the 5-step pirate funnel from the events table, computed by the
 * server on every request. Highlights the worst-step transition visually so
 * a founder can see where to focus an experiment.
 *
 * Empty state: when no events exist for any step, prompt to connect PostHog.
 *
 * Recharts FunnelChart caveat: Recharts FunnelChart renders the funnel as
 * trapezoids sized by `value`. We feed it the raw counts and rely on the
 * library's auto-sizing. A custom Cell with a darker fill highlights the
 * worst step; the legend below names the transition explicitly so the
 * founder can act.
 */

import { useQuery } from "@tanstack/react-query";
import { Cell, Funnel, FunnelChart, LabelList, ResponsiveContainer, Tooltip } from "recharts";
import { TrendingDown } from "lucide-react";
import { funnelApi, type FunnelDiagnostics as FunnelDiagnosticsData } from "../../../api/funnel";
import { cn } from "../../../lib/utils";

interface FunnelDiagnosticsProps {
  companyId: string;
}

// Color palette — neutral steps + a warm warning for the worst step.
const STEP_COLOR = "var(--brand, #14b8a6)"; // teal default
const WORST_COLOR = "#ef4444"; // red-500

export function FunnelDiagnostics({ companyId }: FunnelDiagnosticsProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["funnel", companyId],
    queryFn: () => funnelApi.get(companyId),
    enabled: !!companyId,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="rounded-md border border-border bg-card p-8 text-center text-sm text-muted-foreground">
        Loading funnel…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-md border border-dashed border-border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground mb-3">
          Couldn’t load funnel data. The server may be unreachable, or your
          workspace may not have events ingested yet.
        </p>
        <a
          href="/integrations"
          className="text-[12px] font-medium text-[var(--brand,theme(colors.teal.500))] hover:underline"
        >
          Connect PostHog →
        </a>
      </div>
    );
  }

  // True-empty workspace: no events of any kind. Show the connect-PostHog
  // CTA rather than a chart of zeros (which would still render but lie
  // visually about "having data").
  const allZero = data.steps.every((s) => s.count === 0);
  if (allZero) {
    return (
      <div className="rounded-md border border-dashed border-border bg-card p-10 flex flex-col items-center gap-3 text-center">
        <p className="text-sm text-muted-foreground max-w-sm">
          No funnel data — connect PostHog to start measuring the path from
          first visit to paid customer.
        </p>
        <a
          href="/integrations"
          className="text-[12px] font-medium text-[var(--brand,theme(colors.teal.500))] hover:underline"
        >
          Connect PostHog →
        </a>
      </div>
    );
  }

  return <FunnelView data={data} />;
}

function FunnelView({ data }: { data: FunnelDiagnosticsData }) {
  const { steps, worstStep } = data;

  // Find the worst-step transition label for the callout. The worst step is
  // the destination of the worst transition: e.g. worstStep="Paid" means
  // the "Retention → Paid" transition is the bleeder.
  const worstIdx = worstStep ? steps.findIndex((s) => s.name === worstStep) : -1;
  const worstFromName = worstIdx > 0 ? steps[worstIdx - 1].name : null;
  const worstDropPct =
    worstIdx > 0 && steps[worstIdx].dropFromPrev !== null
      ? Math.round((steps[worstIdx].dropFromPrev as number) * 100)
      : null;

  // Recharts Funnel data shape: [{ value, name, fill }]. We map raw counts
  // and stamp a fill on the worst step so the Cell stays consistent.
  const chartData = steps.map((s) => ({
    name: s.name,
    value: s.count,
    fill: s.name === worstStep ? WORST_COLOR : STEP_COLOR,
  }));

  return (
    <div className="space-y-5">
      {/* Headline — only when we have a real worst step */}
      {worstStep && worstFromName && worstDropPct !== null && (
        <div
          className={cn(
            "rounded-md border p-4 flex items-start gap-3",
            worstDropPct > 50
              ? "border-red-500/30 bg-red-500/5"
              : "border-amber-500/30 bg-amber-500/5",
          )}
        >
          <TrendingDown
            className={cn(
              "h-4 w-4 mt-0.5 shrink-0",
              worstDropPct > 50 ? "text-red-500" : "text-amber-500",
            )}
          />
          <p className="text-sm text-foreground/80 leading-relaxed">
            <span className="font-semibold text-foreground">
              Worst drop: {worstFromName} → {worstStep} ({worstDropPct}% loss).
            </span>{" "}
            This is the largest single-step loss in your funnel over the last
            30 days.
          </p>
        </div>
      )}

      {/* Recharts FunnelChart — fixed 360px height; ResponsiveContainer
          handles width. Recharts ≥3.x requires children-as-elements API. */}
      <div className="rounded-md border border-border bg-card p-4">
        <div className="w-full" style={{ height: 360 }}>
          <ResponsiveContainer width="100%" height="100%">
            <FunnelChart>
              <Tooltip
                cursor={false}
                contentStyle={{
                  background: "var(--card, #fff)",
                  border: "1px solid var(--border, #e5e7eb)",
                  borderRadius: 6,
                  fontSize: 12,
                }}
                formatter={(value, _name, ctx) => {
                  const num = typeof value === "number" ? value : Number(value ?? 0);
                  const label =
                    ctx && typeof ctx === "object" && "payload" in ctx
                      ? ((ctx as { payload?: { name?: string } }).payload?.name ?? "")
                      : "";
                  return [num.toLocaleString(), label];
                }}
              />
              <Funnel dataKey="value" data={chartData} isAnimationActive={false}>
                <LabelList
                  position="right"
                  fill="var(--foreground, #111)"
                  stroke="none"
                  dataKey="name"
                  style={{ fontSize: 12, fontWeight: 500 }}
                />
                <LabelList
                  position="inside"
                  fill="#fff"
                  stroke="none"
                  dataKey="value"
                  formatter={(v) => {
                    const num = typeof v === "number" ? v : Number(v ?? 0);
                    return num.toLocaleString();
                  }}
                  style={{ fontSize: 12, fontWeight: 600 }}
                />
                {chartData.map((entry, idx) => (
                  <Cell key={`cell-${idx}`} fill={entry.fill} />
                ))}
              </Funnel>
            </FunnelChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Tabular drop-off list — keeps the precise numbers a chart can't
          carry without crowding. */}
      <div className="rounded-md border border-border bg-card divide-y divide-border overflow-hidden">
        {steps.map((step, idx) => {
          const dropPct =
            step.dropFromPrev === null ? null : Math.round(step.dropFromPrev * 100);
          const isWorst = step.name === worstStep;
          return (
            <div key={step.name} className="px-4 py-3 flex items-center gap-3">
              <div className="w-24 shrink-0">
                <p
                  className={cn(
                    "text-[10px] uppercase tracking-[0.12em] font-medium",
                    isWorst ? "text-red-500" : "text-muted-foreground",
                  )}
                >
                  {step.name}
                </p>
              </div>
              <div className="flex-1 tabular-nums text-xs font-semibold text-foreground">
                {step.count.toLocaleString()}
                <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                  {idx === 0 ? "users" : ""}
                </span>
              </div>
              <div
                className={cn(
                  "w-16 text-right tabular-nums text-[11px] font-medium shrink-0",
                  dropPct === null
                    ? "text-muted-foreground/60"
                    : dropPct > 50
                      ? "text-red-500"
                      : dropPct > 25
                        ? "text-amber-500"
                        : "text-emerald-600 dark:text-emerald-400",
                )}
              >
                {dropPct === null ? "—" : `−${dropPct}%`}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-[10px] text-muted-foreground/60 tabular-nums">
        Funnel definition: pageview → identify → activated → retained_7d →
        subscribed · Window: last 30 days · Source: events table
      </p>
    </div>
  );
}
