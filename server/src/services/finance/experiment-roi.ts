import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { experiments } from "@founderos/db";

/**
 * Experiment ROI rollup (S5.7) — translate completed Growth experiments
 * with measured lift into attributable MRR contribution.
 *
 * Model (v1):
 *   contribution_cents = current_mrr × (actualLiftPct / 100)
 *
 * Caveats baked into the response:
 *   - Lift is interpreted as cumulative-over-window, not per-month
 *   - Negative-lift experiments are surfaced separately (learning value)
 *   - Stacked-experiment double-counting is real: if 5 experiments each
 *     claim +5% lift, summing them naively suggests +25% — likely an
 *     overcount because lift compounds non-linearly. We sum + flag.
 *
 * The summary explicitly bands cumulative contribution as 'directional'
 * not 'precise.'
 */

const ATTRIBUTION_WINDOW_DAYS = 90;

export interface ExperimentRoiEntry {
  experimentId: string;
  hypothesis: string;
  channel: string | null;
  department: string;
  actualLiftPct: number;
  attributableMrrCents: number;
  completedAt: string;
}

export interface ExperimentRoiRollup {
  windowDays: number;
  currentMrrCents: number;
  positiveLiftExperiments: ExperimentRoiEntry[];
  negativeLiftExperiments: ExperimentRoiEntry[];
  totals: {
    positiveCount: number;
    negativeCount: number;
    cumulativeAttributableMrrCents: number; // positive minus negative
    grossPositiveMrrCents: number;
  };
  byChannel: Array<{
    channel: string;
    experimentCount: number;
    cumulativeMrrCents: number;
  }>;
  warnings: string[];
}

/**
 * Compute the experiment ROI rollup for a company.
 */
export async function computeExperimentRoi(
  db: Db,
  companyId: string,
  now: Date = new Date(),
): Promise<ExperimentRoiRollup> {
  const windowStart = new Date(
    now.getTime() - ATTRIBUTION_WINDOW_DAYS * 86_400_000,
  );

  const currentMrrCents = await currentActiveMrr(db, companyId);

  const rows = await db
    .select()
    .from(experiments)
    .where(
      and(
        eq(experiments.companyId, companyId),
        eq(experiments.status, "completed"),
        isNotNull(experiments.actualLiftPct),
        gte(experiments.completedAt, windowStart),
      ),
    );

  const positiveLift: ExperimentRoiEntry[] = [];
  const negativeLift: ExperimentRoiEntry[] = [];

  for (const row of rows) {
    const lift = row.actualLiftPct ?? 0;
    const attributableMrrCents = Math.round(currentMrrCents * (lift / 100));

    const entry: ExperimentRoiEntry = {
      experimentId: row.id,
      hypothesis: row.hypothesis,
      channel: row.channel ?? null,
      department: row.department,
      actualLiftPct: lift,
      attributableMrrCents,
      completedAt: row.completedAt
        ? row.completedAt.toISOString()
        : new Date(0).toISOString(),
    };

    if (lift > 0) positiveLift.push(entry);
    else if (lift < 0) negativeLift.push(entry);
  }

  // Sort positive descending by contribution, negative ascending by lift
  positiveLift.sort(
    (a, b) => b.attributableMrrCents - a.attributableMrrCents,
  );
  negativeLift.sort((a, b) => a.actualLiftPct - b.actualLiftPct);

  const grossPositive = positiveLift.reduce(
    (sum, e) => sum + e.attributableMrrCents,
    0,
  );
  const grossNegative = negativeLift.reduce(
    (sum, e) => sum + Math.abs(e.attributableMrrCents),
    0,
  );

  // By-channel rollup (only positive-lift channels, since channel kill
  // decisions usually consider gross contribution)
  const byChannelMap = new Map<
    string,
    { count: number; cents: number }
  >();
  for (const e of [...positiveLift, ...negativeLift]) {
    const key = e.channel ?? "(unattributed)";
    const existing = byChannelMap.get(key) ?? { count: 0, cents: 0 };
    existing.count += 1;
    existing.cents += e.attributableMrrCents; // signed
    byChannelMap.set(key, existing);
  }

  const byChannel = [...byChannelMap.entries()]
    .map(([channel, v]) => ({
      channel,
      experimentCount: v.count,
      cumulativeMrrCents: v.cents,
    }))
    .sort((a, b) => b.cumulativeMrrCents - a.cumulativeMrrCents);

  const warnings: string[] = [];
  if (positiveLift.length > 3) {
    warnings.push(
      `Cumulative attributable MRR ($${(grossPositive / 100).toFixed(0)}) sums per-experiment lifts naively. Real-world lift compounds non-linearly; treat the total as directional, not precise.`,
    );
  }
  if (currentMrrCents === 0) {
    warnings.push(
      "Current MRR is zero — attributable contribution can't be computed. Surface lift % only until billing accrues.",
    );
  }

  return {
    windowDays: ATTRIBUTION_WINDOW_DAYS,
    currentMrrCents,
    positiveLiftExperiments: positiveLift,
    negativeLiftExperiments: negativeLift,
    totals: {
      positiveCount: positiveLift.length,
      negativeCount: negativeLift.length,
      cumulativeAttributableMrrCents: grossPositive - grossNegative,
      grossPositiveMrrCents: grossPositive,
    },
    byChannel,
    warnings,
  };
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

function unwrapRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
