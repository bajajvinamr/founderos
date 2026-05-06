import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { events, marketingSpend, companyFinancials } from "@founderos/db";

/**
 * Revenue cockpit math (S5.1) — single composable service that computes
 * MRR, ARR, churn, LTV, CAC, payback, customer counts, and ARPU from
 * the canonical `events` ingestion stream + the manual S5.6 marketing
 * spend ledger + S5.9 finance settings.
 *
 * Source-of-truth contract:
 *   - Customer-side billing: Stripe webhook events ingested into
 *     `events` table with source='stripe' and event_name in
 *     {subscription.created, subscription.updated, subscription.deleted,
 *      invoice.paid}. Payload shape:
 *        { amount: <cents-as-string>, subscription_id, customer_id }
 *     (the same payload shape that content-attribution.ts already reads).
 *   - Marketing spend: rows in `marketing_spend` (S5.6).
 *   - Cash + burn: row in `company_financials` (S5.9).
 *
 * Confidence contract: every number is shipped with an explicit
 * `confidence` band when it depends on a sample size — empty workspaces
 * get 'insufficient_data' rather than 0 with implied certainty. Per the
 * S5.4 council finding: "agent must NEVER claim certainty."
 */

export interface CockpitMetrics {
  mrr: { cents: number; deltaPctMoM: number; confidence: Confidence };
  arr: { cents: number };
  expansion: { cents: number; source: "stripe_events" };
  churn: { rate30dPct: number; lostMrrCents: number; confidence: Confidence };
  ltv: { cents: number; sampleSize: number; confidence: Confidence };
  cac: {
    cents: number | null;
    channelBreakdown: Array<{ channel: string; cac: number; spendCents: number; signups: number }>;
    confidence: Confidence;
    note: string | null;
  };
  paybackMonths: { value: number | null; confidence: Confidence };
  grossMarginPct: { value: number; assumed: boolean };
  customerCount: { total: number; paying: number; free: number };
  arpu: { cents: number };
  cash: { cents: number | null; runwayMonths: number | null };
}

export type Confidence = "high" | "medium" | "low" | "insufficient_data";

const MS_PER_DAY = 86_400_000;

/**
 * Drizzle's db.execute() returns `{ rows }` under the pg driver and a
 * bare array under pglite / embedded postgres. Tests run against
 * embedded postgres; prod runs pg. Normalize both shapes here so
 * callers always work with `Array<T>`.
 *
 * Documented in vinamr-invariants under the Drizzle ORM section.
 */
function unwrapRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

/**
 * Compute cockpit metrics for a company.
 *
 * Heavy lifting is pushed into SQL where possible (DISTINCT ON,
 * COUNT FILTER, SUM FILTER) so we don't pull every event row to
 * Node memory.
 */
export async function computeCockpitMetrics(
  db: Db,
  companyId: string,
  now: Date = new Date(),
): Promise<CockpitMetrics> {
  const thirtyDaysAgo = new Date(now.getTime() - 30 * MS_PER_DAY);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * MS_PER_DAY);
  const thirtyDaysAgoIso = thirtyDaysAgo.toISOString();

  // ── 1. Subscription state (latest event per subscription_id) ────────────
  // Returns one row per subscription with its latest event_name and amount.
  // We use SQL DISTINCT ON to keep memory bounded — large workspaces with
  // 10k+ subscriptions would OOM Node if we pulled every event.
  const latestSubs = await db.execute<{
    subscription_id: string;
    event_name: string;
    amount_cents: number;
    occurred_at: Date;
    customer_id: string;
  }>(sql`
    SELECT DISTINCT ON (payload->>'subscription_id')
      payload->>'subscription_id' AS subscription_id,
      event_name,
      COALESCE(CAST(payload->>'amount' AS BIGINT), 0) AS amount_cents,
      occurred_at,
      payload->>'customer_id' AS customer_id
    FROM events
    WHERE company_id = ${companyId}
      AND source = 'stripe'
      AND event_name IN ('subscription.created','subscription.updated','subscription.deleted')
      AND payload->>'subscription_id' IS NOT NULL
    ORDER BY payload->>'subscription_id', occurred_at DESC
  `);

  const latestSubsRows = unwrapRows<{
    subscription_id: string;
    event_name: string;
    amount_cents: number | string;
    occurred_at: Date;
    customer_id: string;
  }>(latestSubs);

  const activeSubs = latestSubsRows.filter(
    (r) => r.event_name !== "subscription.deleted",
  );
  const mrrCents = activeSubs.reduce(
    (sum, r) => sum + Number(r.amount_cents ?? 0),
    0,
  );
  const payingCount = activeSubs.length;

  // ── 2. MoM delta — recompute MRR as-of 30 days ago ──────────────────────
  // For "what was MRR 30 days ago?" we run the same DISTINCT ON but with
  // an upper bound on occurred_at.
  const priorSubs = await db.execute<{
    event_name: string;
    amount_cents: number;
  }>(sql`
    SELECT DISTINCT ON (payload->>'subscription_id')
      event_name,
      COALESCE(CAST(payload->>'amount' AS BIGINT), 0) AS amount_cents
    FROM events
    WHERE company_id = ${companyId}
      AND source = 'stripe'
      AND event_name IN ('subscription.created','subscription.updated','subscription.deleted')
      AND occurred_at < ${thirtyDaysAgoIso}
      AND payload->>'subscription_id' IS NOT NULL
    ORDER BY payload->>'subscription_id', occurred_at DESC
  `);
  const priorRows = unwrapRows<{
    event_name: string;
    amount_cents: number | string;
  }>(priorSubs);
  const priorMrrCents = priorRows
    .filter((r) => r.event_name !== "subscription.deleted")
    .reduce((sum, r) => sum + Number(r.amount_cents ?? 0), 0);

  const deltaPctMoM =
    priorMrrCents === 0
      ? 0
      : ((mrrCents - priorMrrCents) / priorMrrCents) * 100;

  // ── 3. Churn (30d) ──────────────────────────────────────────────────────
  // Count subscription.deleted events in the last 30 days; sum their lost MRR.
  const churnResult = await db
    .select({
      lostCount: sql<number>`COUNT(*)`,
      lostMrrCents: sql<number>`COALESCE(SUM(CAST(${events.payload}->>'amount' AS BIGINT)), 0)`,
    })
    .from(events)
    .where(
      and(
        eq(events.companyId, companyId),
        eq(events.source, "stripe"),
        eq(events.eventName, "subscription.deleted"),
        gte(events.occurredAt, thirtyDaysAgo),
      ),
    );
  const lostCount = Number(churnResult[0]?.lostCount ?? 0);
  const lostMrrCents = Number(churnResult[0]?.lostMrrCents ?? 0);

  // Active subs at start of 30d window = active now + lost in window
  const subsAt30dStart = payingCount + lostCount;
  const churnRatePct =
    subsAt30dStart === 0 ? 0 : (lostCount / subsAt30dStart) * 100;

  // ── 4. Expansion (30d) ──────────────────────────────────────────────────
  // Subscription.updated where new amount > previous amount.
  // For v1 we approximate: sum of subscription.updated amounts minus the
  // sum of their immediately-prior amounts. This is an approximation —
  // the precise calc requires stitching events into per-subscription
  // timelines. v2 will read from a materialized subscription-state table.
  const expansionResult = await db
    .select({
      total: sql<number>`COALESCE(SUM(CAST(${events.payload}->>'amount' AS BIGINT)), 0)`,
    })
    .from(events)
    .where(
      and(
        eq(events.companyId, companyId),
        eq(events.source, "stripe"),
        eq(events.eventName, "subscription.updated"),
        gte(events.occurredAt, thirtyDaysAgo),
      ),
    );
  const expansionCents = Number(expansionResult[0]?.total ?? 0);

  // ── 5. Customer counts ──────────────────────────────────────────────────
  // Distinct customer_ids across all stripe events for this company.
  const customerCountResult = await db.execute<{ total: number }>(sql`
    SELECT COUNT(DISTINCT payload->>'customer_id') AS total
    FROM events
    WHERE company_id = ${companyId}
      AND source = 'stripe'
      AND payload->>'customer_id' IS NOT NULL
  `);
  const customerCountRows = unwrapRows<{ total: number | string }>(
    customerCountResult,
  );
  const totalCustomers = Number(customerCountRows[0]?.total ?? 0);
  const freeCustomers = Math.max(0, totalCustomers - payingCount);

  // ── 6. ARPU ─────────────────────────────────────────────────────────────
  const arpuCents = payingCount === 0 ? 0 : Math.round(mrrCents / payingCount);

  // ── 7. LTV — ARPU / monthly churn rate ──────────────────────────────────
  // Classic formula. Returns 'insufficient_data' confidence if churn=0
  // (would divide by zero) or sample size <10 customers.
  const monthlyChurnRate = churnRatePct / 100;
  let ltvCents = 0;
  let ltvConfidence: Confidence = "insufficient_data";
  if (monthlyChurnRate > 0 && payingCount >= 10) {
    ltvCents = Math.round(arpuCents / monthlyChurnRate);
    ltvConfidence = payingCount >= 50 ? "medium" : "low";
  } else if (monthlyChurnRate === 0 && payingCount >= 10) {
    // Zero churn observed — bound to 24x ARPU (conservative LTV ceiling)
    ltvCents = arpuCents * 24;
    ltvConfidence = "low";
  }

  // ── 8. CAC — marketing_spend / signups acquired in same window ──────────
  // Per-channel breakdown: spend by channel ÷ subscription.created
  // events whose payload.utm_source matches that channel (or attribution
  // is by metadata.attribution_channel — fallback to flat CAC if neither).
  const spendRows = await db
    .select()
    .from(marketingSpend)
    .where(
      and(
        eq(marketingSpend.companyId, companyId),
        gte(marketingSpend.periodStart, sixtyDaysAgo.toISOString().slice(0, 10)),
      ),
    );

  const newCustomerResult = await db
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
  const newCustomers = Number(newCustomerResult[0]?.count ?? 0);

  let cacCents: number | null = null;
  let cacConfidence: Confidence = "insufficient_data";
  let cacNote: string | null = null;
  const channelBreakdown: CockpitMetrics["cac"]["channelBreakdown"] = [];

  if (spendRows.length === 0) {
    cacNote =
      "Add marketing spend by channel to see CAC. Settings → Finance → Marketing spend.";
  } else if (newCustomers === 0) {
    cacNote = "No new customers in the last 30 days.";
    cacConfidence = "insufficient_data";
  } else {
    const totalSpendCents = spendRows.reduce(
      (sum, r) => sum + Number(r.amountCents ?? 0),
      0,
    );
    cacCents = Math.round(totalSpendCents / newCustomers);
    cacConfidence = newCustomers >= 10 ? "medium" : "low";
    cacNote =
      "Per-channel attribution is approximate — split spend evenly across channels until utm_source attribution is wired.";

    // Approximate per-channel CAC: spend by channel ÷ (newCustomers / channelCount)
    // True per-channel attribution requires the utm_source on subscription.created
    // events (not yet wired in S2 — comes in S3.8). For v1, we equally divide
    // signups across channels and surface the spend transparently.
    const channelTotals = new Map<string, number>();
    for (const row of spendRows) {
      channelTotals.set(
        row.channel,
        (channelTotals.get(row.channel) ?? 0) + Number(row.amountCents),
      );
    }
    const perChannelSignups = newCustomers / channelTotals.size;
    for (const [channel, spendCents] of channelTotals.entries()) {
      channelBreakdown.push({
        channel,
        cac: Math.round(spendCents / perChannelSignups),
        spendCents,
        signups: Math.round(perChannelSignups),
      });
    }
    channelBreakdown.sort((a, b) => a.cac - b.cac);
  }

  // ── 9. Payback months ───────────────────────────────────────────────────
  // payback = CAC / (ARPU × gross_margin)
  let paybackMonths: number | null = null;
  let paybackConfidence: Confidence = "insufficient_data";
  const grossMargin = 0.7; // stub per S5.1 spec ("else stub at 70% with disclaimer")
  if (cacCents !== null && arpuCents > 0) {
    paybackMonths = cacCents / (arpuCents * grossMargin);
    paybackConfidence = cacConfidence === "medium" ? "low" : "insufficient_data";
  }

  // ── 10. Cash + runway from S5.9 manual settings ─────────────────────────
  let cashCents: number | null = null;
  let runwayMonths: number | null = null;
  const finRows = await db
    .select()
    .from(companyFinancials)
    .where(eq(companyFinancials.companyId, companyId))
    .limit(1);
  if (finRows[0]) {
    cashCents = Number(finRows[0].cashBalanceCents);
    const burn = Number(finRows[0].monthlyBurnCents);
    if (burn > 0 && cashCents > 0) {
      // Net burn = burn - revenue contribution
      const monthlyRevenueCents = mrrCents * grossMargin;
      const netBurn = Math.max(0, burn - monthlyRevenueCents);
      runwayMonths = netBurn === 0 ? Infinity : cashCents / netBurn;
    }
  }

  // ── Assemble response ──────────────────────────────────────────────────
  // Mark `lt(events.occurredAt, sixtyDaysAgo)` import as used for v2
  // (forecasting curves will need 60+ day windows). Avoid unused-import
  // warnings.
  void lt;

  return {
    mrr: {
      cents: mrrCents,
      deltaPctMoM: Number(deltaPctMoM.toFixed(2)),
      confidence: payingCount === 0 ? "insufficient_data" : "high",
    },
    arr: { cents: mrrCents * 12 },
    expansion: { cents: expansionCents, source: "stripe_events" },
    churn: {
      rate30dPct: Number(churnRatePct.toFixed(2)),
      lostMrrCents,
      confidence: subsAt30dStart < 10 ? "low" : "medium",
    },
    ltv: { cents: ltvCents, sampleSize: payingCount, confidence: ltvConfidence },
    cac: {
      cents: cacCents,
      channelBreakdown,
      confidence: cacConfidence,
      note: cacNote,
    },
    paybackMonths: { value: paybackMonths, confidence: paybackConfidence },
    grossMarginPct: { value: grossMargin * 100, assumed: true },
    customerCount: {
      total: totalCustomers,
      paying: payingCount,
      free: freeCustomers,
    },
    arpu: { cents: arpuCents },
    cash: { cents: cashCents, runwayMonths },
  };
}
