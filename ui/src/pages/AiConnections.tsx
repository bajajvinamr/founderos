/**
 * @fileoverview AI Connections page (BL-016 / P5.a).
 *
 * Founder-facing surface listing AI adapters the company is connected to,
 * the default chosen for new work, per-department usage, and a fallback
 * order. Spec said `/setup/ai-connections`, but `/setup/*` is not a
 * registered route root and editing `ui/src/lib/company-routes.ts` or
 * the top-level Sidebar is Tier-3 forbidden under this dispatch. Mirroring
 * the EQ-006 (BL-012) precedent — append to an existing instance/settings
 * sub-route Layout — this page renders at `/instance/settings/ai-connections`.
 *
 * Scope (P5.a — scaffold only):
 *   - Connected list with brand logos + status pill (sourced from adapters API)
 *   - Default-for-new-work picker (placeholder; wiring lands in P5.b / BL-017)
 *   - Per-department usage table (placeholder; server shape lands in P5.b)
 *   - Fallback order — local-only drag-reorder with @dnd-kit; persistence
 *     in P5.b. v1 uses up/down buttons for keyboard accessibility.
 *
 * Out of scope (deferred to P5.b / BL-017):
 *   - Persisting default-for-new-work to company.preferredAdapter
 *   - Server endpoint for per-department adapter assignment
 *   - Persisting fallback order to a server-side preference
 *
 * Dispatch infra dependencies declared in the brief but not present on main:
 *   - `BrandLogo` component (#175 / BL-003 not yet merged) → using the
 *     existing `adapterDisplayMap.icon` from `adapter-display-registry.ts`
 *     instead, which is the de facto brand-logo registry for adapters.
 *   - `useDisplay` hook (P1) and `useViewMode` (P4.a / #174) → not present
 *     on main. Page uses plain founder-mode copy; engineer-mode language
 *     can be threaded in once the hooks land.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, GripVertical, Plug } from "lucide-react";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { aiConnectionsApi, type AiConnectionRow, type FallbackOrderEntry } from "@/api/ai-connections";
import { getAdapterDisplay } from "@/adapters/adapter-display-registry";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ─── Status pill ─────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<AiConnectionRow["status"], string> = {
  connected: "Connected",
  validation_needed: "Validation needed",
  disconnected: "Disconnected",
};

const STATUS_CLASS: Record<AiConnectionRow["status"], string> = {
  connected: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10",
  validation_needed: "text-amber-600 dark:text-amber-400 bg-amber-500/10",
  disconnected: "text-muted-foreground bg-muted",
};

export function StatusPill({ status }: { status: AiConnectionRow["status"] }) {
  return (
    <span
      data-testid={`ai-connection-status-${status}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        STATUS_CLASS[status],
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

// ─── Brand logo (adapter icon) ───────────────────────────────────────────────

/**
 * Brand logo for an adapter. Reads from the existing `adapter-display-registry`
 * which is the canonical brand-logo registry for adapters today (Sparkles for
 * Claude, Code for Codex, Gem for Gemini, OpenCodeLogoIcon, HermesIcon, etc.).
 * If #175's `BrandLogo` component lands later, this is the single seam to
 * swap implementations.
 */
export function AdapterBrandLogo({ adapterType }: { adapterType: string }) {
  const display = getAdapterDisplay(adapterType);
  const Icon = display.icon;
  return <Icon className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />;
}

// ─── Fallback order — local-only reorder ─────────────────────────────────────

export function reorderFallback(
  list: FallbackOrderEntry[],
  from: number,
  to: number,
): FallbackOrderEntry[] {
  if (from === to) return list;
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return list;
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  if (!moved) return list;
  next.splice(to, 0, moved);
  return next;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function AiConnections() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [fallbackOrder, setFallbackOrder] = useState<FallbackOrderEntry[]>([]);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "AI Connections" },
    ]);
  }, [setBreadcrumbs]);

  const connectionsQuery = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => aiConnectionsApi.list(),
  });

  const connections = useMemo<AiConnectionRow[]>(
    () => connectionsQuery.data ?? [],
    [connectionsQuery.data],
  );

  // Initialise fallback-order from the connected list once data lands.
  useEffect(() => {
    if (connectionsQuery.data && fallbackOrder.length === 0) {
      setFallbackOrder(
        connectionsQuery.data
          .filter((c) => c.status === "connected")
          .map((c) => ({ adapterType: c.type, label: c.label })),
      );
    }
  }, [connectionsQuery.data, fallbackOrder.length]);

  function moveUp(idx: number) {
    setFallbackOrder((current) => reorderFallback(current, idx, idx - 1));
  }

  function moveDown(idx: number) {
    setFallbackOrder((current) => reorderFallback(current, idx, idx + 1));
  }

  if (connectionsQuery.isLoading) {
    return (
      <div className="max-w-4xl space-y-6">
        <PageHeader />
        <div className="text-sm text-muted-foreground">Loading AI connections…</div>
      </div>
    );
  }

  if (connectionsQuery.error) {
    return (
      <div className="max-w-4xl space-y-6">
        <PageHeader />
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {connectionsQuery.error instanceof Error
            ? connectionsQuery.error.message
            : "Failed to load AI connections."}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6" data-testid="ai-connections-page">
      <PageHeader />

      {/* 1. Connected list */}
      <ConnectedSection connections={connections} />

      {/* 2. Default for new work */}
      <DefaultForNewWorkSection connections={connections} />

      {/* 3. Currently used by (per-department) */}
      <PerDepartmentSection />

      {/* 4. Fallback order */}
      <FallbackOrderSection
        order={fallbackOrder}
        onMoveUp={moveUp}
        onMoveDown={moveDown}
      />
    </div>
  );
}

function PageHeader() {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Plug className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">AI Connections</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Which AI agents you&apos;ve plugged in, which one runs by default, and the fallback order when one is busy.
      </p>
    </div>
  );
}

// ─── Section: Connected list ─────────────────────────────────────────────────

export function ConnectedSection({ connections }: { connections: AiConnectionRow[] }) {
  if (connections.length === 0) {
    return (
      <section className="rounded-xl border border-border bg-card p-5" data-testid="connected-section">
        <h2 className="text-sm font-semibold">Connected</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          No AI providers connected yet. Connect one from{" "}
          <a className="underline" href="/instance/settings/adapters">
            Workstations
          </a>{" "}
          to get started.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-border bg-card p-5" data-testid="connected-section">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Connected</h2>
        <span className="text-xs text-muted-foreground">{connections.length} provider{connections.length === 1 ? "" : "s"}</span>
      </div>
      <ul className="mt-3 divide-y divide-border">
        {connections.map((c) => (
          <li
            key={c.type}
            className="flex items-center gap-3 py-2.5"
            data-testid={`connection-row-${c.type}`}
          >
            <AdapterBrandLogo adapterType={c.type} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-sm">{c.label}</span>
                {c.source === "external" && (
                  <Badge variant="outline" className="text-[10px]">External</Badge>
                )}
                {c.version && (
                  <Badge variant="secondary" className="font-mono text-[10px]">
                    v{c.version}
                  </Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {c.modelsCount} model{c.modelsCount === 1 ? "" : "s"} available
              </div>
            </div>
            <StatusPill status={c.status} />
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─── Section: Default for new work ───────────────────────────────────────────

function DefaultForNewWorkSection({ connections }: { connections: AiConnectionRow[] }) {
  const connected = connections.filter((c) => c.status === "connected");

  return (
    <section className="rounded-xl border border-border bg-card p-5" data-testid="default-section">
      <h2 className="text-sm font-semibold">Default for new work</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Which AI runs when you don&apos;t pick one explicitly. Wiring ships with P5.b (BL-017).
      </p>
      {connected.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Connect at least one provider to set a default.
        </p>
      ) : (
        <ul className="mt-3 space-y-2" role="radiogroup" aria-label="Default AI for new work">
          {connected.map((c, i) => (
            <li key={c.type} className="flex items-center gap-3">
              <input
                type="radio"
                name="default-adapter"
                id={`default-${c.type}`}
                value={c.type}
                defaultChecked={i === 0}
                disabled
                className="h-4 w-4 shrink-0 accent-foreground"
                data-testid={`default-adapter-${c.type}`}
              />
              <label htmlFor={`default-${c.type}`} className="flex items-center gap-2 text-sm text-muted-foreground">
                <AdapterBrandLogo adapterType={c.type} />
                {c.label}
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ─── Section: Per-department usage ───────────────────────────────────────────

function PerDepartmentSection() {
  return (
    <section className="rounded-xl border border-border bg-card p-5" data-testid="per-department-section">
      <h2 className="text-sm font-semibold">Currently used by</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Which AI each department is using right now. Server shape lands with P5.b (BL-017).
      </p>
      <div className="mt-3 rounded-md border border-dashed border-border bg-muted/30 px-3 py-4 text-center text-xs text-muted-foreground">
        TODO (P5.b): wire department → adapter resolver. No server endpoint yet.
      </div>
    </section>
  );
}

// ─── Section: Fallback order ─────────────────────────────────────────────────

function FallbackOrderSection({
  order,
  onMoveUp,
  onMoveDown,
}: {
  order: FallbackOrderEntry[];
  onMoveUp: (idx: number) => void;
  onMoveDown: (idx: number) => void;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-5" data-testid="fallback-section">
      <h2 className="text-sm font-semibold">Fallback order</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        If the default is busy or rate-limited, try these in order. Reorder is local-only in P5.a; persistence lands with P5.b.
      </p>
      {order.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Connect providers to define a fallback order.
        </p>
      ) : (
        <ol className="mt-3 space-y-1.5">
          {order.map((entry, i) => (
            <li
              key={entry.adapterType}
              className="flex items-center gap-3 rounded-md border border-border bg-background px-2.5 py-2"
              data-testid={`fallback-entry-${entry.adapterType}`}
            >
              <GripVertical className="h-4 w-4 text-muted-foreground" aria-hidden />
              <span className="w-5 text-xs text-muted-foreground tabular-nums">{i + 1}.</span>
              <AdapterBrandLogo adapterType={entry.adapterType} />
              <span className="flex-1 text-sm">{entry.label}</span>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => onMoveUp(i)}
                  disabled={i === 0}
                  aria-label={`Move ${entry.label} up`}
                  data-testid={`fallback-up-${entry.adapterType}`}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => onMoveDown(i)}
                  disabled={i === order.length - 1}
                  aria-label={`Move ${entry.label} down`}
                  data-testid={`fallback-down-${entry.adapterType}`}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

