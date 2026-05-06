import { eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { companyFinancials } from "@founderos/db";
import { computeChurnForecast } from "./churn-forecast.js";

/**
 * Runway forecast (S5.5) — months until cash-out under three scenarios.
 *
 * Composes:
 *   - S5.9 company_financials → cash on hand + monthly burn
 *   - S5.3 churn-forecast → projected MRR decay curve
 *
 * Scenario bands:
 *   - Conservative: revenue retention is 70% of the projected rate
 *     (churn happens faster than the curve suggests)
 *   - Base: matches the projected curve exactly
 *   - Optimistic: retention is 130% of projected (clamped at 1.0;
 *     "less churn than projected")
 *
 * The band spread widens when the curve fit's R² is low — high
 * uncertainty translates to wider bands. Spec says "Conservative =
 * 25th-percentile forecast revenue, Base = median, Optimistic = 75th"
 * but our point-estimate fit doesn't have percentile data; the band
 * multipliers are the v1 honest approximation.
 *
 * Time horizon: walks forward month-by-month up to 60 months. Beyond
 * that founders should be running a different conversation than
 * "runway."
 */

export interface RunwayBand {
  band: "conservative" | "base" | "optimistic";
  monthsRemaining: number; // can be Infinity (cash-flow-positive)
  projectedCashOutDate: string | null; // ISO YYYY-MM-DD; null if Infinity
  monthlyBalances: Array<{ month: number; cashCents: number; mrrCents: number; netBurnCents: number }>;
}

export interface RunwayForecast {
  cashCents: number;
  monthlyBurnCents: number;
  currentMrrCents: number;
  grossMarginPct: number;
  bands: {
    conservative: RunwayBand;
    base: RunwayBand;
    optimistic: RunwayBand;
  };
  curveQuality: { aboveHalf: boolean; rSquared: number };
  warnings: string[];
}

const HORIZON_MONTHS = 60;
const GROSS_MARGIN = 0.7;

export async function computeRunwayForecast(
  db: Db,
  companyId: string,
  now: Date = new Date(),
): Promise<RunwayForecast> {
  const finRows = await db
    .select()
    .from(companyFinancials)
    .where(eq(companyFinancials.companyId, companyId))
    .limit(1);

  if (!finRows[0]) {
    return emptyForecast({
      message:
        "No finance settings yet. Enter cash on hand + monthly burn under Settings → Finance to compute runway.",
    });
  }

  const cashCents = Number(finRows[0].cashBalanceCents);
  const burnCents = Number(finRows[0].monthlyBurnCents);

  if (cashCents <= 0) {
    return emptyForecast({
      cashCents,
      burnCents,
      message: "Cash balance is zero or negative. Update Settings → Finance.",
    });
  }

  const churnForecast = await computeChurnForecast(db, companyId, now);
  const currentMrrCents = churnForecast.currentActiveMrrCents;
  const warnings: string[] = [];
  if (churnForecast.confidence === "insufficient_data") {
    warnings.push(
      "Churn curve has insufficient data — runway uses a flat-MRR assumption. Connect Stripe and accrue 60+ days of subscription history for a real curve fit.",
    );
  }

  // Build retention multipliers by scenario.
  // When R² is low, widen the band; when R² is high, tighten it.
  const r2 = churnForecast.curve.rSquared;
  const spread = r2 >= 0.5 ? 0.3 : 0.5; // base ± 30% if good fit, ± 50% if weak
  const conservativeMultiplier = 1 - spread;
  const optimisticMultiplier = 1 + spread;

  // Build the per-month MRR projection for each band
  const conservative = projectRunway({
    cashCents,
    burnCents,
    currentMrrCents,
    horizon: HORIZON_MONTHS,
    retentionAtMonth: (m) =>
      retentionFromCurve(churnForecast.curve, m) * conservativeMultiplier,
    now,
    band: "conservative",
  });

  const base = projectRunway({
    cashCents,
    burnCents,
    currentMrrCents,
    horizon: HORIZON_MONTHS,
    retentionAtMonth: (m) => retentionFromCurve(churnForecast.curve, m),
    now,
    band: "base",
  });

  const optimistic = projectRunway({
    cashCents,
    burnCents,
    currentMrrCents,
    horizon: HORIZON_MONTHS,
    retentionAtMonth: (m) =>
      Math.min(
        1,
        retentionFromCurve(churnForecast.curve, m) * optimisticMultiplier,
      ),
    now,
    band: "optimistic",
  });

  return {
    cashCents,
    monthlyBurnCents: burnCents,
    currentMrrCents,
    grossMarginPct: GROSS_MARGIN * 100,
    bands: { conservative, base, optimistic },
    curveQuality: { aboveHalf: r2 >= 0.5, rSquared: r2 },
    warnings,
  };
}

function retentionFromCurve(
  curve: { a: number; b: number },
  month: number,
): number {
  if (curve.b === 0) return 1; // flat-MRR fallback when curve is degenerate
  return Math.max(0, Math.min(1, curve.a * Math.exp(-curve.b * month)));
}

function projectRunway(opts: {
  cashCents: number;
  burnCents: number;
  currentMrrCents: number;
  horizon: number;
  retentionAtMonth: (m: number) => number;
  now: Date;
  band: RunwayBand["band"];
}): RunwayBand {
  let cash = opts.cashCents;
  const monthlyBalances: RunwayBand["monthlyBalances"] = [];
  let cashOutMonth: number | null = null;
  let partialMonthFraction = 0;

  for (let m = 1; m <= opts.horizon; m++) {
    const retention = opts.retentionAtMonth(m);
    const mrrAtMonth = Math.round(opts.currentMrrCents * retention);
    const revenueContrib = Math.round(mrrAtMonth * GROSS_MARGIN);
    const netBurn = opts.burnCents - revenueContrib; // can be negative (profitable)

    monthlyBalances.push({
      month: m,
      cashCents: cash - netBurn,
      mrrCents: mrrAtMonth,
      netBurnCents: netBurn,
    });

    if (netBurn <= 0) {
      // Cash-flow-positive — runway is effectively infinite from here.
      // We still walk the rest of the horizon for the chart but mark Infinity.
      cash = cash - netBurn; // adds revenue to cash
      continue;
    }

    cash = cash - netBurn;
    if (cash <= 0 && cashOutMonth === null) {
      const prevCash = monthlyBalances[m - 2]?.cashCents ?? opts.cashCents;
      partialMonthFraction = prevCash > 0 ? prevCash / netBurn : 0;
      cashOutMonth = m - 1 + partialMonthFraction;
    }
  }

  const allCashFlowPositive = monthlyBalances.every(
    (b) => b.netBurnCents <= 0,
  );

  const monthsRemaining =
    allCashFlowPositive && cashOutMonth === null
      ? Infinity
      : (cashOutMonth ?? opts.horizon);

  let projectedCashOutDate: string | null = null;
  if (cashOutMonth !== null) {
    const date = new Date(opts.now);
    date.setMonth(date.getMonth() + Math.ceil(cashOutMonth));
    projectedCashOutDate = date.toISOString().slice(0, 10);
  }

  return {
    band: opts.band,
    monthsRemaining,
    projectedCashOutDate,
    monthlyBalances,
  };
}

function emptyForecast(opts: {
  cashCents?: number;
  burnCents?: number;
  message: string;
}): RunwayForecast {
  return {
    cashCents: opts.cashCents ?? 0,
    monthlyBurnCents: opts.burnCents ?? 0,
    currentMrrCents: 0,
    grossMarginPct: GROSS_MARGIN * 100,
    bands: {
      conservative: emptyBand("conservative"),
      base: emptyBand("base"),
      optimistic: emptyBand("optimistic"),
    },
    curveQuality: { aboveHalf: false, rSquared: 0 },
    warnings: [opts.message],
  };
}

function emptyBand(band: RunwayBand["band"]): RunwayBand {
  return {
    band,
    monthsRemaining: 0,
    projectedCashOutDate: null,
    monthlyBalances: [],
  };
}
