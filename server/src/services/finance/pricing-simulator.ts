import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { events } from "@founderos/db";
import { runScenario, type TierCurrent } from "@founderos/shared";

/**
 * Pricing simulator (S5.2) — composes the existing pure `runScenario`
 * engine in @founderos/shared with tiers derived from active Stripe
 * subscriptions and CAC pulled from the cockpit math.
 *
 * Elasticity model (v1):
 *   - SaaS price elasticity assumption ε = -1.2 (industry default)
 *   - Δprice% × |ε| → expected churn uplift (e.g. +20% price → 24% churn)
 *   - Δprice% × |ε| × 0.5 → new-customer drop (subscriber acquisition is
 *     less elastic than churn; halving the multiplier is the spec default)
 *
 * Confidence is ALWAYS marked 'low' until the founder has 50+ observed
 * price changes — per the S5.4 council pre-read: "agent must NEVER
 * claim certainty." The elasticity is a stated assumption, not data.
 */

const PRICE_ELASTICITY = 1.2;

export interface TierChange {
  tierId: string;
  currentPriceCents: number;
  newPriceCents: number;
}

export interface PricingSimulationResult {
  mrrDeltaCents: number;
  mrrDeltaPct: number;
  projectedMrrCents: number;
  baselineMrrCents: number;
  churnRateDeltaPct: number;
  projectedChurnRatePct: number;
  customerCountDelta: number;
  paybackDeltaMonths: number;
  twelveMonthProjection: Array<{ month: number; mrrCents: number }>;
  warnings: string[];
  confidence: "low";
  elasticityAssumption: number;
  tiersUsed: TierCurrent[];
}

/**
 * Derive subscription tiers from active Stripe subscriptions.
 *
 * v1: each distinct amount_cents becomes a "tier" with auto-generated
 * name "Tier_$<dollars>". The DISTINCT ON (subscription_id) latest-event
 * filter is the same as cockpit.ts — keeps the math consistent across
 * services.
 *
 * v2 will read from Stripe's `price` API and use the price's nickname
 * or product name; this requires the Stripe client + a periodic sync,
 * which is out of scope for v1.
 */
export async function deriveTiersFromEvents(
  db: Db,
  companyId: string,
): Promise<TierCurrent[]> {
  const result = await db.execute(sql`
    WITH latest_sub_events AS (
      SELECT DISTINCT ON (payload->>'subscription_id')
        payload->>'subscription_id' AS subscription_id,
        event_name,
        COALESCE(CAST(payload->>'amount' AS BIGINT), 0) AS amount_cents
      FROM events
      WHERE company_id = ${companyId}
        AND source = 'stripe'
        AND event_name IN ('subscription.created','subscription.updated','subscription.deleted')
        AND payload->>'subscription_id' IS NOT NULL
      ORDER BY payload->>'subscription_id', occurred_at DESC
    )
    SELECT
      amount_cents,
      COUNT(*) AS customer_count
    FROM latest_sub_events
    WHERE event_name <> 'subscription.deleted'
    GROUP BY amount_cents
    ORDER BY amount_cents ASC
  `);

  const rows = unwrapRows<{
    amount_cents: number | string;
    customer_count: number | string;
  }>(result);

  return rows.map((r) => ({
    name: `Tier_${Number(r.amount_cents) / 100}`,
    priceCentsPerMonth: Number(r.amount_cents),
    customerCount: Number(r.customer_count),
  }));
}

/**
 * Compute current monthly new-customer rate (last 30 days).
 */
export async function getMonthlyNewCustomers(
  db: Db,
  companyId: string,
  now: Date = new Date(),
): Promise<number> {
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);
  const result = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(events)
    .where(
      and(
        eq(events.companyId, companyId),
        eq(events.source, "stripe"),
        eq(events.eventName, "subscription.created"),
        gte(events.occurredAt, thirtyDaysAgo),
      ),
    );
  return Number(result[0]?.count ?? 0);
}

/**
 * Run a pricing simulation for a company.
 *
 * Throws when no tiers exist yet (empty workspace) — caller (route
 * layer) should 422 in that case rather than returning misleading
 * zero-deltas.
 */
export async function runPricingSimulation(
  db: Db,
  companyId: string,
  tierChanges: TierChange[],
  avgAcquisitionCostCents: number = 0,
): Promise<PricingSimulationResult> {
  const tiers = await deriveTiersFromEvents(db, companyId);

  if (tiers.length === 0) {
    throw new Error(
      "no_tiers_derived: workspace has no active subscriptions yet",
    );
  }

  // Build the priceChanges map from tierId (which is the derived tier
  // name like "Tier_50") → new price.
  const priceChanges: Partial<Record<string, number>> = {};
  let weightedDeltaPct = 0;
  let totalChangedCustomers = 0;

  for (const change of tierChanges) {
    // Match incoming tierId to derived tier by either name or by current
    // price (founders may be modifying client-side state with stale tier
    // names; matching by current price is the more forgiving fallback).
    const matched =
      tiers.find((t) => t.name === change.tierId) ??
      tiers.find(
        (t) => t.priceCentsPerMonth === change.currentPriceCents,
      );
    if (!matched) continue;

    priceChanges[matched.name] = change.newPriceCents;

    if (matched.priceCentsPerMonth > 0) {
      const deltaPct =
        ((change.newPriceCents - matched.priceCentsPerMonth) /
          matched.priceCentsPerMonth) *
        100;
      weightedDeltaPct += deltaPct * matched.customerCount;
      totalChangedCustomers += matched.customerCount;
    }
  }

  const avgDeltaPct =
    totalChangedCustomers === 0 ? 0 : weightedDeltaPct / totalChangedCustomers;

  // Apply elasticity to derive the runScenario inputs.
  // For a price RAISE (avgDeltaPct > 0): churn UPLIFT scales with delta;
  // new-customer DECREASE scales with half of delta.
  // For a price CUT (avgDeltaPct < 0): no churn uplift, but new-customer
  // INFLOW grows. Encoded by passing 0 for churn uplift and negative
  // expected decrease (the engine clamps at 0 below).
  const expectedChurnUpliftPct = Math.max(
    0,
    avgDeltaPct * PRICE_ELASTICITY,
  );
  const expectedNewCustomerDecreasePct = avgDeltaPct * PRICE_ELASTICITY * 0.5;

  const currentMonthlyNewCustomers = await getMonthlyNewCustomers(
    db,
    companyId,
  );

  const scenario = runScenario({
    tiers,
    priceChanges,
    expectedChurnUpliftPct,
    expectedNewCustomerDecreasePct,
    currentMonthlyNewCustomers,
    avgAcquisitionCostCents,
  });

  // Compute current churn rate (medium-light copy of cockpit.ts churn calc)
  const currentChurnRate = await getCurrent30dChurnRate(db, companyId);
  const churnRateDeltaPct = scenario.projectedChurnRatePct - currentChurnRate;

  return {
    mrrDeltaCents: scenario.mrrDeltaCents,
    mrrDeltaPct: scenario.mrrDeltaPct,
    projectedMrrCents: scenario.projectedMrrCents,
    baselineMrrCents: scenario.baselineMrrCents,
    churnRateDeltaPct: Number(churnRateDeltaPct.toFixed(2)),
    projectedChurnRatePct: scenario.projectedChurnRatePct,
    customerCountDelta: scenario.customerCountDelta,
    paybackDeltaMonths: scenario.paybackDeltaMonths,
    twelveMonthProjection: scenario.twelveMonthMrrProjection,
    warnings: [
      ...scenario.warnings,
      "Elasticity assumption ε=-1.2 (SaaS industry default). Replace with workspace-observed elasticity after 50+ price changes.",
    ],
    confidence: "low",
    elasticityAssumption: PRICE_ELASTICITY,
    tiersUsed: tiers,
  };
}

async function getCurrent30dChurnRate(
  db: Db,
  companyId: string,
  now: Date = new Date(),
): Promise<number> {
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);
  const tiers = await deriveTiersFromEvents(db, companyId);
  const activeNow = tiers.reduce((sum, t) => sum + t.customerCount, 0);

  const result = await db
    .select({ lostCount: sql<number>`COUNT(*)` })
    .from(events)
    .where(
      and(
        eq(events.companyId, companyId),
        eq(events.source, "stripe"),
        eq(events.eventName, "subscription.deleted"),
        gte(events.occurredAt, thirtyDaysAgo),
      ),
    );
  const lost = Number(result[0]?.lostCount ?? 0);
  const total = activeNow + lost;
  return total === 0 ? 0 : (lost / total) * 100;
}

function unwrapRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
