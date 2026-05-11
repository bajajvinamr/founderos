import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { Sparkles } from "lucide-react";
import type { Integration, IntegrationKind } from "@founderos/shared";
import { integrationsApi } from "../../api/integrations";

/**
 * Quick Wins (BL-023 / P8.c) — 3-5 founder-language "things you could ask
 * your team today", tailored to which integrations are wired up.
 *
 * STATIC for this dispatch. The locked product spec calls for a Haiku-tier
 * server-side suggester (BL-022 / P8.b). That requires:
 *   - `server/src/services/quick-wins-suggester.ts` (Tier-2)
 *   - `server/src/routes/dashboard.ts` (Tier-2)
 *   - DB cache table for per-tenant per-day suggestions (Tier-3)
 * The autoloop boundary keeps this Tier-1, so we ship the surface NOW with
 * a curated catalog keyed on connected-integration presence. When P8.b
 * lands, swap the catalog for a `useQuery` against the suggester route.
 *
 * TODO(BL-022 / P8.b): Replace `buildQuickWinSuggestions` with a server-side
 * Haiku-suggester query. Cache key: per-tenant per-day. The UI contract is:
 *   { id: string; title: string; href: string; integration?: IntegrationKind }
 */

export interface QuickWin {
  id: string;
  title: string;
  /** Optional link target. When omitted the card renders non-interactive. */
  href?: string;
  /** Which integration this suggestion leans on, for de-prioritising
   *  suggestions whose integration isn't connected. */
  integration?: IntegrationKind;
}

/**
 * Curated catalog. Ordering matters — first match wins per integration so
 * we don't double-up suggestions referencing the same data source.
 *
 * Keep entries short and founder-voiced. These are framed as "things a
 * founder would actually ask their CoS to do", not as feature ads. Per
 * the locked UX rework: no jargon, no metric IDs, no widget terminology.
 */
const QUICK_WIN_CATALOG: QuickWin[] = [
  {
    id: "posthog-signup-dip",
    title: "Find why signups dropped this week",
    href: "/agents",
    integration: "posthog",
  },
  {
    id: "hubspot-followup",
    title: "Draft follow-ups for last week's leads",
    href: "/agents",
    integration: "hubspot",
  },
  {
    id: "stripe-revenue-pulse",
    title: "Summarise the week's revenue movements",
    href: "/agents",
    integration: "stripe",
  },
  {
    id: "slack-customer-themes",
    title: "Surface this week's customer conversations",
    href: "/agents",
    integration: "slack",
  },
  {
    id: "linkedin-warm-intros",
    title: "Pull 5 warm intros worth reaching out to",
    href: "/agents",
    integration: "linkedin",
  },
  {
    id: "notion-weekly-recap",
    title: "Write the weekly investor update",
    href: "/agents",
    integration: "notion",
  },
];

/**
 * Integration-agnostic fallbacks. Shown when the founder hasn't connected
 * anything yet, or to pad the list out to 3 when only 1-2 integrations
 * are live.
 */
const FALLBACK_SUGGESTIONS: QuickWin[] = [
  {
    id: "fallback-risks",
    title: "List the top 3 risks for the next sprint",
    href: "/agents",
  },
  {
    id: "fallback-priorities",
    title: "Rank this week's open work by impact",
    href: "/agents",
  },
  {
    id: "fallback-handover",
    title: "Brief a new hire on the last 7 days",
    href: "/agents",
  },
];

const MIN_SUGGESTIONS = 3;
const MAX_SUGGESTIONS = 5;

/**
 * Pure suggestion builder — exported so tests don't need the query harness.
 *
 * Strategy:
 *  1. Score each catalog entry by whether its target integration is
 *     `connected` (highest priority) vs present-but-not-connected vs
 *     absent. Connected integrations win.
 *  2. Pad with `FALLBACK_SUGGESTIONS` until we hit `MIN_SUGGESTIONS`.
 *  3. Cap at `MAX_SUGGESTIONS`.
 */
export function buildQuickWinSuggestions(
  integrations: Integration[] | undefined,
): QuickWin[] {
  const connectedKinds = new Set<IntegrationKind>();
  for (const i of integrations ?? []) {
    if (i.status === "connected") connectedKinds.add(i.kind);
  }

  const connectedHits = QUICK_WIN_CATALOG.filter(
    (q) => q.integration && connectedKinds.has(q.integration),
  );

  const rest = QUICK_WIN_CATALOG.filter(
    (q) => !q.integration || !connectedKinds.has(q.integration),
  );

  const ordered = [...connectedHits, ...rest];
  const padded =
    ordered.length >= MIN_SUGGESTIONS
      ? ordered
      : [...ordered, ...FALLBACK_SUGGESTIONS];

  // De-duplicate by id while preserving order.
  const seen = new Set<string>();
  const deduped: QuickWin[] = [];
  for (const q of padded) {
    if (seen.has(q.id)) continue;
    seen.add(q.id);
    deduped.push(q);
    if (deduped.length >= MAX_SUGGESTIONS) break;
  }
  return deduped;
}

interface QuickWinsWidgetProps {
  companyId: string;
}

export function QuickWinsWidget({ companyId }: QuickWinsWidgetProps) {
  const { data: integrations } = useQuery({
    queryKey: ["integrations", companyId],
    queryFn: () => integrationsApi.list(companyId),
    enabled: !!companyId,
  });

  const suggestions = useMemo(
    () => buildQuickWinSuggestions(integrations),
    [integrations],
  );

  return (
    <section
      aria-label="Quick Wins"
      className="rounded-md border border-border bg-card px-5 py-4"
    >
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
            Quick Wins
          </p>
        </div>
        <span className="text-xs text-muted-foreground">
          {suggestions.length} idea{suggestions.length === 1 ? "" : "s"}
        </span>
      </div>

      <ul className="divide-y divide-border">
        {suggestions.map((q) => (
          <li key={q.id}>
            {q.href ? (
              <Link
                to={q.href}
                className="-mx-2 flex items-center gap-3 rounded px-2 py-2.5 text-sm no-underline text-inherit hover:bg-accent/50"
              >
                <span className="flex-1 truncate text-foreground">{q.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  Ask the team
                </span>
              </Link>
            ) : (
              <div className="-mx-2 flex items-center gap-3 rounded px-2 py-2.5 text-sm">
                <span className="flex-1 truncate text-foreground">{q.title}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
