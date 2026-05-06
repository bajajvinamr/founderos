import { sql } from "drizzle-orm";
import type { Db } from "@founderos/db";

/**
 * Churn forecast (S5.3) — fit an exponential-decay retention curve to
 * monthly cohorts and project 90 days out.
 *
 * Math:
 *   1. For each of the last 12 months M:
 *      cohort_M = set of subscription_ids whose `subscription.created`
 *      event landed in month M.
 *   2. For each cohort and each future month t (t = 1..N where N is
 *      months between M and now), count surviving subscriptions:
 *      a sub survives month t iff there is no `subscription.deleted`
 *      event for that subscription_id at or before the end of month
 *      M+t.
 *   3. retention[M][t] = surviving / |cohort_M|
 *   4. global_retention[t] = simple mean across all cohorts that have
 *      observations at month t (older cohorts contribute more points)
 *   5. Fit retention(t) = a × exp(-b × t) by OLS on
 *      log(retention) = log(a) - b × t
 *   6. Project 1, 2, 3 months forward. The "lost MRR" projection
 *      multiplies (1 - retention(t)) by the current active MRR.
 *
 * Confidence:
 *   - 'high' when 8+ cohorts have observations at every t in 0..6
 *   - 'medium' when 4..7 cohorts observed at t=3
 *   - 'low' when 1..3 cohorts observed at t=3
 *   - 'insufficient_data' when 0 or 1 month-cohorts exist (no curve to fit)
 *
 * The model is deliberately simple — exponential decay is a reasonable
 * first-order approximation but real SaaS retention curves have a
 * "month-1 churn cliff" + a flatter long tail. v2 can fit a 2-stage
 * model (Weibull) when we have enough data per cohort to justify it.
 */

export interface ChurnForecast {
  curve: { a: number; b: number; rSquared: number };
  retentionByMonth: Array<{ month: number; observed: number; predicted: number }>;
  projection: Array<{ month: number; projectedRetention: number; projectedLostMrrCents: number }>;
  cohortCount: number;
  totalObservations: number;
  currentActiveMrrCents: number;
  confidence: "high" | "medium" | "low" | "insufficient_data";
  warnings: string[];
}

interface CohortObservation {
  cohortMonth: string; // YYYY-MM
  monthsSinceCohort: number;
  retention: number; // 0..1
  cohortSize: number;
}

/**
 * Compute the churn forecast for a company.
 */
export async function computeChurnForecast(
  db: Db,
  companyId: string,
  now: Date = new Date(),
): Promise<ChurnForecast> {
  const observations = await collectCohortObservations(db, companyId, now);

  // Distinct cohort count
  const cohortMonths = new Set(observations.map((o) => o.cohortMonth));
  const cohortCount = cohortMonths.size;

  if (cohortCount < 2) {
    return {
      curve: { a: 1, b: 0, rSquared: 0 },
      retentionByMonth: [],
      projection: [],
      cohortCount,
      totalObservations: observations.length,
      currentActiveMrrCents: await currentActiveMrr(db, companyId),
      confidence: "insufficient_data",
      warnings: [
        "Need at least 2 monthly cohorts to fit a retention curve. Connect Stripe and let billing accrue 60+ days of subscription history.",
      ],
    };
  }

  // Aggregate to global_retention[t] = simple mean
  const byMonth = new Map<number, number[]>();
  for (const obs of observations) {
    const list = byMonth.get(obs.monthsSinceCohort) ?? [];
    list.push(obs.retention);
    byMonth.set(obs.monthsSinceCohort, list);
  }

  // Build aggregated points (only include t > 0 — t=0 is always 1.0
  // by definition, would skew the OLS fit).
  const points: Array<{ t: number; retention: number; n: number }> = [];
  for (const [t, retentions] of byMonth.entries()) {
    if (t === 0) continue;
    // Drop near-zero retention from the OLS fit (log(0) = -∞). Treat
    // any retention < 0.01 as 0.01 for fit purposes — it would drop out
    // of meaningful prediction anyway.
    const mean =
      retentions.reduce((s, r) => s + Math.max(0.01, r), 0) / retentions.length;
    points.push({ t, retention: mean, n: retentions.length });
  }

  if (points.length < 2) {
    return {
      curve: { a: 1, b: 0, rSquared: 0 },
      retentionByMonth: [],
      projection: [],
      cohortCount,
      totalObservations: observations.length,
      currentActiveMrrCents: await currentActiveMrr(db, companyId),
      confidence: "insufficient_data",
      warnings: [
        "Need at least 2 distinct (cohort, month) observation buckets for a curve fit.",
      ],
    };
  }

  // Fit log(y) = ln(a) - b × t via OLS
  const fit = ordinaryLeastSquaresLog(
    points.map((p) => ({ x: p.t, y: p.retention })),
  );

  // Build retention-by-month for the response: observed vs predicted
  const retentionByMonth = points
    .sort((a, b) => a.t - b.t)
    .map((p) => ({
      month: p.t,
      observed: Number(p.retention.toFixed(4)),
      predicted: Number(predict(fit, p.t).toFixed(4)),
    }));

  // Project 1, 2, 3 months ahead
  const currentActiveMrrCents = await currentActiveMrr(db, companyId);
  const lastObservedMonth = Math.max(...points.map((p) => p.t));
  const projection = [1, 2, 3].map((delta) => {
    const t = lastObservedMonth + delta;
    const projectedRetention = Math.max(0, Math.min(1, predict(fit, t)));
    // Lost MRR for the increment from t-1 to t = (predicted_retention(t-1) - predicted_retention(t)) × currentMRR
    const prev = Math.max(0, Math.min(1, predict(fit, t - 1)));
    const lossPct = Math.max(0, prev - projectedRetention);
    return {
      month: delta, // 1, 2, 3 months ahead from now
      projectedRetention: Number(projectedRetention.toFixed(4)),
      projectedLostMrrCents: Math.round(currentActiveMrrCents * lossPct),
    };
  });

  // Confidence band based on observation density
  const tThree = points.find((p) => p.t === 3);
  const cohortsAtT3 = tThree?.n ?? 0;
  const cohortsAtT6 = points.find((p) => p.t === 6)?.n ?? 0;
  let confidence: ChurnForecast["confidence"] = "insufficient_data";
  if (cohortsAtT6 >= 8) confidence = "high";
  else if (cohortsAtT3 >= 4) confidence = "medium";
  else if (cohortsAtT3 >= 1) confidence = "low";

  const warnings: string[] = [];
  if (fit.rSquared < 0.5) {
    warnings.push(
      `Curve fit is weak (R²=${fit.rSquared.toFixed(2)}); retention may not follow exponential decay. v2 will fit a 2-stage Weibull model when more data lands.`,
    );
  }
  if (cohortCount < 6) {
    warnings.push(
      `Only ${cohortCount} cohorts observed; predictions are directional. Confidence will improve as more billing months accumulate.`,
    );
  }

  return {
    curve: {
      a: Number(fit.a.toFixed(4)),
      b: Number(fit.b.toFixed(4)),
      rSquared: Number(fit.rSquared.toFixed(4)),
    },
    retentionByMonth,
    projection,
    cohortCount,
    totalObservations: observations.length,
    currentActiveMrrCents,
    confidence,
    warnings,
  };
}

/**
 * For each subscription that started in the last 12 months, observe
 * whether it was still alive at each month-anchor between cohort start
 * and now. Returns one row per (cohort_month, months_since_cohort,
 * retention, cohort_size).
 */
async function collectCohortObservations(
  db: Db,
  companyId: string,
  now: Date,
): Promise<CohortObservation[]> {
  const twelveMonthsAgoIso = new Date(
    now.getTime() - 365 * 86_400_000,
  ).toISOString();

  // Step 1: load the (subscription_id, created_at, deleted_at) timeline
  // for every subscription created in the last 12 months.
  const timelineResult = await db.execute(sql`
    WITH timeline AS (
      SELECT
        payload->>'subscription_id' AS subscription_id,
        MIN(occurred_at) FILTER (WHERE event_name = 'subscription.created') AS created_at,
        MIN(occurred_at) FILTER (WHERE event_name = 'subscription.deleted') AS deleted_at
      FROM events
      WHERE company_id = ${companyId}
        AND source = 'stripe'
        AND event_name IN ('subscription.created','subscription.deleted')
        AND payload->>'subscription_id' IS NOT NULL
      GROUP BY payload->>'subscription_id'
    )
    SELECT subscription_id, created_at, deleted_at
    FROM timeline
    WHERE created_at IS NOT NULL
      AND created_at >= ${twelveMonthsAgoIso}
  `);

  const timelineRows = unwrapRows<{
    subscription_id: string;
    created_at: string | Date;
    deleted_at: string | Date | null;
  }>(timelineResult);

  // Group by cohort month
  const cohorts = new Map<
    string,
    Array<{ created: Date; deleted: Date | null }>
  >();
  for (const row of timelineRows) {
    const created = new Date(row.created_at);
    const deleted = row.deleted_at ? new Date(row.deleted_at) : null;
    const cohortKey = `${created.getUTCFullYear()}-${String(
      created.getUTCMonth() + 1,
    ).padStart(2, "0")}`;
    const list = cohorts.get(cohortKey) ?? [];
    list.push({ created, deleted });
    cohorts.set(cohortKey, list);
  }

  const observations: CohortObservation[] = [];
  for (const [cohortMonth, subs] of cohorts.entries()) {
    if (subs.length === 0) continue;
    const cohortSize = subs.length;
    // Anchor cohort start at the 1st of its month
    const cohortStartParts = cohortMonth.split("-").map(Number);
    const cohortStart = new Date(
      Date.UTC(cohortStartParts[0], cohortStartParts[1] - 1, 1),
    );
    // Compute retention at month t for t = 0..(months between cohort and now)
    const monthsSpan = monthsBetween(cohortStart, now);
    for (let t = 0; t <= Math.min(monthsSpan, 12); t++) {
      const anchorDate = new Date(
        Date.UTC(cohortStartParts[0], cohortStartParts[1] - 1 + t + 1, 1),
      );
      // count subs alive at end of (cohortStart + t months) = anchorDate
      const surviving = subs.filter(
        (s) => s.deleted === null || s.deleted >= anchorDate,
      ).length;
      observations.push({
        cohortMonth,
        monthsSinceCohort: t,
        retention: surviving / cohortSize,
        cohortSize,
      });
    }
  }
  return observations;
}

async function currentActiveMrr(db: Db, companyId: string): Promise<number> {
  const result = await db.execute(sql`
    WITH latest_sub_events AS (
      SELECT DISTINCT ON (payload->>'subscription_id')
        event_name,
        COALESCE(CAST(payload->>'amount' AS BIGINT), 0) AS amount_cents
      FROM events
      WHERE company_id = ${companyId}
        AND source = 'stripe'
        AND event_name IN ('subscription.created','subscription.updated','subscription.deleted')
        AND payload->>'subscription_id' IS NOT NULL
      ORDER BY payload->>'subscription_id', occurred_at DESC
    )
    SELECT COALESCE(SUM(amount_cents) FILTER (WHERE event_name <> 'subscription.deleted'), 0) AS mrr
    FROM latest_sub_events
  `);
  const rows = unwrapRows<{ mrr: number | string }>(result);
  return Number(rows[0]?.mrr ?? 0);
}

/**
 * Ordinary least squares fit of y = a × exp(-b × t).
 * Linearize: log(y) = log(a) - b × t.
 */
function ordinaryLeastSquaresLog(
  points: Array<{ x: number; y: number }>,
): { a: number; b: number; rSquared: number } {
  const n = points.length;
  if (n < 2) return { a: 1, b: 0, rSquared: 0 };

  const ys = points.map((p) => Math.log(p.y));
  const xs = points.map((p) => p.x);

  const xMean = xs.reduce((s, v) => s + v, 0) / n;
  const yMean = ys.reduce((s, v) => s + v, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (xs[i] - xMean) * (ys[i] - yMean);
    denominator += (xs[i] - xMean) ** 2;
  }
  if (denominator === 0) return { a: 1, b: 0, rSquared: 0 };

  const slope = numerator / denominator;
  const intercept = yMean - slope * xMean;

  // R² on the log-linear fit
  const ssRes = ys.reduce(
    (s, y, i) => s + (y - (intercept + slope * xs[i])) ** 2,
    0,
  );
  const ssTot = ys.reduce((s, y) => s + (y - yMean) ** 2, 0);
  const rSquared = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);

  return {
    a: Math.exp(intercept),
    b: -slope,
    rSquared,
  };
}

function predict(
  fit: { a: number; b: number },
  t: number,
): number {
  return fit.a * Math.exp(-fit.b * t);
}

function monthsBetween(a: Date, b: Date): number {
  return (
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
    (b.getUTCMonth() - a.getUTCMonth())
  );
}

function unwrapRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
