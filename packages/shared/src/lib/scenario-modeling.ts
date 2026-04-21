// ─── Scenario Modeling Engine ──────────────────────────────────────────────
// Pure calculation engine for pricing scenario simulation.
// All monetary values in cents (integers). Round only on display, never mid-calc.
// Wave 5: wire inputs from real Stripe/billing data instead of mock tiers.

export interface TierCurrent {
  name: string;
  priceCentsPerMonth: number;
  customerCount: number;
}

export interface ScenarioInputs {
  tiers: TierCurrent[];
  /** tier name → new priceCents for changed tiers */
  priceChanges: Partial<Record<string, number>>;
  /** 0-100: % of existing customers who churn due to price hike */
  expectedChurnUpliftPct: number;
  /** 0-100: % reduction in new-customer inflow */
  expectedNewCustomerDecreasePct: number;
  /** baseline monthly new customers across all tiers */
  currentMonthlyNewCustomers: number;
  /** blended customer acquisition cost in cents */
  avgAcquisitionCostCents: number;
  /** default 12 */
  horizonMonths?: number;
}

export interface ScenarioOutputs {
  baselineMrrCents: number;
  projectedMrrCents: number;
  mrrDeltaCents: number;
  mrrDeltaPct: number;
  projectedChurnRatePct: number;
  projectedMonthlyNewCustomers: number;
  /** negative = faster payback */
  paybackDeltaMonths: number;
  /** NRR approximation: (projectedMrr / baselineMrr) * 100
   *  NOTE: v1 simplification — ignores expansion revenue. */
  nrrPct: number;
  twelveMonthMrrProjection: Array<{ month: number; mrrCents: number }>;
  /** net new customers in month 1 (new - churned) */
  customerCountDelta: number;
  warnings: string[];
}

export function runScenario(inputs: ScenarioInputs): ScenarioOutputs {
  const {
    tiers,
    priceChanges,
    expectedChurnUpliftPct,
    expectedNewCustomerDecreasePct,
    currentMonthlyNewCustomers,
    avgAcquisitionCostCents,
    horizonMonths = 12,
  } = inputs;

  const warnings: string[] = [];

  // ── 1. Baseline MRR ────────────────────────────────────────────────────────
  const baselineMrrCents = tiers.reduce(
    (sum, t) => sum + t.priceCentsPerMonth * t.customerCount,
    0,
  );

  if (baselineMrrCents === 0) {
    warnings.push("No paying customers yet — projection is directional only");
  }

  // ── 2. Projected tier prices ───────────────────────────────────────────────
  const projectedPrices: Record<string, number> = {};
  for (const tier of tiers) {
    const override = priceChanges[tier.name];
    projectedPrices[tier.name] = override ?? tier.priceCentsPerMonth;
  }

  // ── 3. Warnings on doubled prices ─────────────────────────────────────────
  for (const tier of tiers) {
    const newPrice = projectedPrices[tier.name];
    if (newPrice >= tier.priceCentsPerMonth * 2) {
      warnings.push(`Price more than doubled for tier ${tier.name} — expect significant churn`);
    }
  }

  // ── 4. Churn from hike (one-time cohort, month-1 only) ────────────────────
  // Only applied to tiers where the price actually changed.
  const changedTiers = tiers.filter(
    (t) => priceChanges[t.name] !== undefined && priceChanges[t.name] !== t.priceCentsPerMonth,
  );
  const churnedCustomers = changedTiers.reduce(
    (sum, t) => sum + (t.customerCount * expectedChurnUpliftPct) / 100,
    0,
  );

  // ── 5. New customers per month ────────────────────────────────────────────
  const projectedMonthlyNewCustomers =
    currentMonthlyNewCustomers * (1 - expectedNewCustomerDecreasePct / 100);

  // ── 6. Average new-customer price (equal-weighted across tiers) ───────────
  const tierCount = tiers.length;
  const avgNewCustomerPriceCents =
    tierCount === 0
      ? 0
      : Object.values(projectedPrices).reduce((sum, p) => sum + p, 0) / tierCount;

  // ── 7. Projected MRR at month 1 ───────────────────────────────────────────
  // baseline + (new customers revenue) - (churned customers revenue at avg price)
  const churnedRevenueCents = churnedCustomers * avgNewCustomerPriceCents;
  const newRevenueCents = projectedMonthlyNewCustomers * avgNewCustomerPriceCents;
  const projectedMrrCents = Math.max(
    0,
    baselineMrrCents + newRevenueCents - churnedRevenueCents,
  );

  const mrrDeltaCents = projectedMrrCents - baselineMrrCents;
  const mrrDeltaPct =
    baselineMrrCents === 0 ? 0 : (mrrDeltaCents / baselineMrrCents) * 100;

  // ── 8. 12-month projection ─────────────────────────────────────────────────
  // Month 0 = baseline. Month 1 = after hike + churn hit.
  // Subsequent months: +newCustomers*avgPrice - 3% baseline churn on current MRR.
  const BASELINE_MONTHLY_CHURN_RATE = 0.03;
  const projection: Array<{ month: number; mrrCents: number }> = [];

  let currentMrr = baselineMrrCents;
  projection.push({ month: 0, mrrCents: currentMrr });

  for (let m = 1; m <= horizonMonths; m++) {
    if (m === 1) {
      // Apply one-time churn hit in month 1
      currentMrr = projectedMrrCents;
    } else {
      const baselineChurnCents = currentMrr * BASELINE_MONTHLY_CHURN_RATE;
      currentMrr = Math.max(
        0,
        currentMrr + projectedMonthlyNewCustomers * avgNewCustomerPriceCents - baselineChurnCents,
      );
    }
    projection.push({ month: m, mrrCents: Math.round(currentMrr) });
  }

  // ── 9. Payback delta ──────────────────────────────────────────────────────
  // paybackDeltaMonths = (newAvgPrice - currentAvgPrice) / avgPrice * -currentPaybackMonths
  // If no CAC provided, payback = 0.
  let paybackDeltaMonths = 0;
  if (avgAcquisitionCostCents > 0 && tierCount > 0) {
    const currentAvgPriceCents =
      tiers.reduce((sum, t) => sum + t.priceCentsPerMonth, 0) / tierCount;
    const currentPaybackMonths =
      currentAvgPriceCents > 0 ? avgAcquisitionCostCents / currentAvgPriceCents : 0;
    paybackDeltaMonths =
      currentAvgPriceCents === 0
        ? 0
        : ((avgNewCustomerPriceCents - currentAvgPriceCents) / currentAvgPriceCents) *
          -currentPaybackMonths;
  }

  // ── 10. NRR approximation ─────────────────────────────────────────────────
  // NOTE: v1 simplification — ignores expansion revenue (treats it as 0).
  const nrrPct = baselineMrrCents === 0 ? 100 : (projectedMrrCents / baselineMrrCents) * 100;

  // ── 11. Customer count delta (month 1) ────────────────────────────────────
  const customerCountDelta = Math.round(projectedMonthlyNewCustomers - churnedCustomers);

  // ── 12. Projected churn rate ──────────────────────────────────────────────
  const totalCustomers = tiers.reduce((sum, t) => sum + t.customerCount, 0);
  const projectedChurnRatePct =
    totalCustomers === 0 ? 0 : (churnedCustomers / totalCustomers) * 100;

  // ── 13. Additional warnings ───────────────────────────────────────────────
  if (expectedChurnUpliftPct > 20) {
    warnings.push("Churn assumption above 20% — verify with historical data");
  }
  if (expectedNewCustomerDecreasePct > 30) {
    warnings.push("New-customer drop above 30% — consider softer hike");
  }

  return {
    baselineMrrCents,
    projectedMrrCents: Math.round(projectedMrrCents),
    mrrDeltaCents: Math.round(mrrDeltaCents),
    mrrDeltaPct,
    projectedChurnRatePct,
    projectedMonthlyNewCustomers,
    paybackDeltaMonths,
    nrrPct,
    twelveMonthMrrProjection: projection,
    customerCountDelta,
    warnings,
  };
}
