import { eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { companyFinancials } from "@founderos/db";
import type { CashPlanInput } from "@founderos/shared";
import { computeChurnForecast } from "./churn-forecast.js";

/**
 * Cash planning (S5.8) — 6-month (configurable horizon) cash flow
 * projection with stackable scenario adjustments.
 *
 * Composes:
 *   - S5.9 company_financials → cash + monthly_burn baseline
 *   - S5.3 churn-forecast curve → MRR decay
 *   - Inputs: hires, priceChangePct, churnDeltaPct, marketing spend
 *
 * The math walks month-by-month, applying every adjustment to that
 * month's flow, then accumulating cash balance. Output is an array of
 * monthly snapshots that the UI renders as a stacked area chart
 * (cash balance line + per-source inflow bars + outflow bars below
 * the axis).
 */

const GROSS_MARGIN = 0.7;

export interface CashPlanMonth {
  month: number; // 1-indexed
  cashCents: number;
  inflows: { revenueGrossCents: number };
  outflows: {
    operatingBurnCents: number;
    hireSalariesCents: number;
    marketingSpendCents: number;
  };
  netCashFlowCents: number;
}

export interface CashPlanResult {
  baselineCashCents: number;
  baselineMonthlyBurnCents: number;
  baselineMrrCents: number;
  scenario: {
    hireCount: number;
    totalHireSalaryAddedCents: number;
    priceChangePct: number;
    churnDeltaPct: number;
    monthlyMarketingSpendCents: number;
  };
  months: CashPlanMonth[];
  endingCashCents: number;
  cashOutMonth: number | null;
  warnings: string[];
}

export async function computeCashPlan(
  db: Db,
  companyId: string,
  input: CashPlanInput,
  now: Date = new Date(),
): Promise<CashPlanResult> {
  const finRows = await db
    .select()
    .from(companyFinancials)
    .where(eq(companyFinancials.companyId, companyId))
    .limit(1);

  const warnings: string[] = [];

  if (!finRows[0]) {
    warnings.push(
      "No finance settings yet. Enter cash + monthly burn under Settings → Finance to compute cash planning.",
    );
    return {
      baselineCashCents: 0,
      baselineMonthlyBurnCents: 0,
      baselineMrrCents: 0,
      scenario: {
        hireCount: input.hires.length,
        totalHireSalaryAddedCents: 0,
        priceChangePct: input.priceChangePct,
        churnDeltaPct: input.churnDeltaPct,
        monthlyMarketingSpendCents: input.monthlyMarketingSpendCents,
      },
      months: [],
      endingCashCents: 0,
      cashOutMonth: null,
      warnings,
    };
  }

  const baselineCashCents = Number(finRows[0].cashBalanceCents);
  const baselineBurnCents = Number(finRows[0].monthlyBurnCents);

  const churnForecast = await computeChurnForecast(db, companyId, now);
  const baselineMrrCents = churnForecast.currentActiveMrrCents;

  if (churnForecast.confidence === "insufficient_data") {
    warnings.push(
      "Churn curve has insufficient data — projection assumes flat MRR with churn delta applied as a fixed monthly rate.",
    );
  }

  const totalHireSalaryPerMonth = (m: number) =>
    input.hires
      .filter((h) => m >= h.startMonthOffset)
      .reduce((sum, h) => sum + h.salaryCents, 0);

  const totalHireSalaryAddedCents = input.hires.reduce(
    (sum, h) => sum + h.salaryCents,
    0,
  );

  // Price change scales current MRR proportionally on month 1, then
  // retention curve takes over (with churn delta added).
  const priceMultiplier = 1 + input.priceChangePct / 100;
  const adjustedMrrAtT0 = baselineMrrCents * priceMultiplier;
  const churnDelta = input.churnDeltaPct / 100;

  const months: CashPlanMonth[] = [];
  let cash = baselineCashCents;
  let cashOutMonth: number | null = null;

  for (let m = 1; m <= input.horizonMonths; m++) {
    // MRR at month m: adjusted baseline × (curve retention(m) + churnDelta clamp)
    const baseRetention = retentionFromCurve(churnForecast.curve, m);
    const adjustedRetention = Math.max(0, Math.min(1, baseRetention - churnDelta));
    const mrrAtMonth = Math.round(adjustedMrrAtT0 * adjustedRetention);

    const revenueGrossCents = Math.round(mrrAtMonth * GROSS_MARGIN);
    const hireSalariesCents = totalHireSalaryPerMonth(m);
    const marketingSpendCents = input.monthlyMarketingSpendCents;

    const totalOutflows =
      baselineBurnCents + hireSalariesCents + marketingSpendCents;
    const netCashFlow = revenueGrossCents - totalOutflows;

    cash = cash + netCashFlow;

    months.push({
      month: m,
      cashCents: cash,
      inflows: { revenueGrossCents },
      outflows: {
        operatingBurnCents: baselineBurnCents,
        hireSalariesCents,
        marketingSpendCents,
      },
      netCashFlowCents: netCashFlow,
    });

    if (cash <= 0 && cashOutMonth === null) {
      cashOutMonth = m;
    }
  }

  if (input.priceChangePct > 30) {
    warnings.push(
      `Price change of +${input.priceChangePct}% is aggressive. The pricing simulator (S5.2) accounts for elasticity-driven churn; this cash plan does not. Cross-check by running the pricing simulator separately.`,
    );
  }
  if (input.hires.length >= 3) {
    warnings.push(
      `${input.hires.length} hires modeled. Each hire compounds with the next; verify total runway impact in the chart.`,
    );
  }

  return {
    baselineCashCents,
    baselineMonthlyBurnCents: baselineBurnCents,
    baselineMrrCents,
    scenario: {
      hireCount: input.hires.length,
      totalHireSalaryAddedCents,
      priceChangePct: input.priceChangePct,
      churnDeltaPct: input.churnDeltaPct,
      monthlyMarketingSpendCents: input.monthlyMarketingSpendCents,
    },
    months,
    endingCashCents: cash,
    cashOutMonth,
    warnings,
  };
}

function retentionFromCurve(
  curve: { a: number; b: number },
  month: number,
): number {
  if (curve.b === 0) return 1;
  return Math.max(0, Math.min(1, curve.a * Math.exp(-curve.b * month)));
}
