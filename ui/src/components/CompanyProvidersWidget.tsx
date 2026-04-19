import { useQuery } from "@tanstack/react-query";
import { templatesApi } from "@/api/templates";
import { Cpu } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Compact dashboard widget: shows which providers this company's agents
 * actually run on and how much they've cost this month. Surfaces the
 * multi-provider architecture as concrete business state for the founder.
 */
export function CompanyProvidersWidget({ companyId }: { companyId: string | undefined }) {
  const query = useQuery({
    queryKey: ["company", companyId, "providers-overview"],
    queryFn: () => templatesApi.companyProvidersOverview(companyId!),
    enabled: !!companyId,
    refetchInterval: 60_000,
  });

  if (!companyId) return null;
  if (query.isLoading) return null;
  if (!query.data || query.data.adapters.length === 0) return null;

  const { adapters, monthSpendByFamily, totalMonthSpendCents } = query.data;

  // Collapse to per-family counts + share-of-spend rows.
  const byFamily = new Map<string, { agentCount: number; spend: number; label: string }>();
  for (const a of adapters) {
    const existing = byFamily.get(a.family) ?? {
      agentCount: 0,
      spend: monthSpendByFamily[a.family] ?? 0,
      label: FAMILY_META[a.family].label,
    };
    existing.agentCount += a.agentCount;
    byFamily.set(a.family, existing);
  }
  const rows = Array.from(byFamily.entries())
    .map(([family, v]) => ({ family: family as keyof typeof FAMILY_META, ...v }))
    .sort((a, b) => b.agentCount - a.agentCount);

  const totalAgents = rows.reduce((acc, r) => acc + r.agentCount, 0);

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center gap-2 mb-4">
        <Cpu className="h-3.5 w-3.5 text-[var(--brand)]" />
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--brand)]">
          Team by provider · this month
        </h2>
      </div>
      <div className="space-y-2.5">
        {rows.map((row) => {
          const meta = FAMILY_META[row.family];
          const pct = totalAgents > 0 ? Math.round((row.agentCount / totalAgents) * 100) : 0;
          const spend = row.spend ?? 0;
          return (
            <div key={row.family} className="flex items-center gap-3">
              <span
                className={cn(
                  "inline-flex h-6 w-6 items-center justify-center rounded-md text-sm",
                  meta.icon,
                )}
                style={{ background: meta.bg }}
                aria-hidden
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium text-foreground truncate">{meta.label}</div>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {row.agentCount} {row.agentCount === 1 ? "teammate" : "teammates"}
                    {spend > 0 && <> · <span className="text-foreground font-medium">${(spend / 100).toFixed(2)}</span></>}
                  </div>
                </div>
                <div className="mt-1 h-1 rounded-full bg-secondary overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${pct}%`, background: meta.barColor }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {totalMonthSpendCents > 0 && (
        <div className="mt-4 pt-3 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
          <span>Total this-month team spend</span>
          <span className="font-mono font-medium text-foreground tabular-nums">
            ${(totalMonthSpendCents / 100).toFixed(2)}
          </span>
        </div>
      )}
    </section>
  );
}

const FAMILY_META: Record<
  "anthropic" | "openai" | "google" | "other",
  { label: string; icon: string; bg: string; barColor: string }
> = {
  anthropic: {
    label: "Claude (Anthropic)",
    icon: "🟠",
    bg: "color-mix(in oklch, #d97757 18%, transparent)",
    barColor: "#d97757",
  },
  openai: {
    label: "OpenAI / Codex",
    icon: "🔵",
    bg: "color-mix(in oklch, #10a37f 18%, transparent)",
    barColor: "#10a37f",
  },
  google: {
    label: "Gemini (Google)",
    icon: "🟢",
    bg: "color-mix(in oklch, #4285f4 18%, transparent)",
    barColor: "#4285f4",
  },
  other: {
    label: "Other",
    icon: "⬜",
    bg: "color-mix(in oklch, var(--muted-foreground) 18%, transparent)",
    barColor: "var(--muted-foreground)",
  },
};
