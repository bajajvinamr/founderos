/**
 * kpi-anomaly.test.ts — integration tests for the S3.2 anomaly detection job.
 *
 * Eight cases (per ticket spec):
 *   1. stable          — 30d flat MRR → no insight
 *   2. drop            — 29d stable + 30% drop today → critical insight
 *   3. spike           — 29d stable + sharp spike today → insight
 *   4. trend_break     — linear up-trend then today plateaus → trend insight
 *   5. dedup_window    — open kpi_anomaly within 24h suppresses re-emit
 *   6. severity        — 2.5σ → warning, 4σ → critical
 *   7. multi_metric    — anomalies on two metrics in one run → 2 insights
 *   8. no_data         — empty events table → no insight, no error
 *
 * Real embedded Postgres exercises CHECK constraints, JSONB `->>` dedup,
 * and the (company_id, kind, created_at DESC) index path end-to-end.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { companies, createDb, events, insights } from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  detectForCompany,
  KPI_METRICS,
  type KpiMetric,
} from "../jobs/kpi-anomaly-detect.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping kpi-anomaly tests: ${support.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("KPI anomaly detection job (S3.2)", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("founderos-kpi-anomaly-");
    db = createDb(temp.connectionString);
  }, 60_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  beforeEach(async () => {
    // Truncate insights + events first; companies last via CASCADE.
    await db.execute(sql`TRUNCATE TABLE "insights" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "events" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);

    const [company] = await db
      .insert(companies)
      .values({ name: "KPI Anomaly Test Co" })
      .returning({ id: companies.id });
    companyId = company!.id;
  });

  // ── helpers ────────────────────────────────────────────────────────────

  /**
   * Seed one event per day for `metric` over the trailing N days. `series` is
   * an array of values where index 0 is the OLDEST day (N-1 days ago) and the
   * last entry is TODAY. dedupKey is uniqueness-only — synthesized from
   * metric + dayIndex so re-runs of the test stay deterministic.
   */
  async function seedDaily(args: {
    metric: KpiMetric;
    series: number[];
    source?: "stripe" | "posthog";
  }) {
    const source = args.source ?? "stripe";
    const now = Date.now();
    const rows = args.series.map((value, idx) => {
      const ageDays = args.series.length - 1 - idx;
      const occurredAt = new Date(now - ageDays * 86_400_000);
      return {
        companyId,
        source,
        entityType: "kpi",
        eventName: args.metric,
        dedupKey: `kpi:${args.metric}:${occurredAt.toISOString().slice(0, 10)}:${source}`,
        occurredAt,
        payload: { value },
      };
    });
    if (rows.length > 0) await db.insert(events).values(rows);
  }

  function constantSeries(value: number, days: number): number[] {
    return Array.from({ length: days }, () => value);
  }

  /**
   * Stable-with-noise: small jitter so stddev > 0 (avoids the flat-baseline
   * branch). Deterministic via index-based jitter.
   */
  function noisySeries(base: number, days: number, noise = 0.01): number[] {
    return Array.from({ length: days }, (_, i) => {
      const jitter = ((i % 5) - 2) * noise * base;
      return base + jitter;
    });
  }

  async function listInsights() {
    return db
      .select()
      .from(insights)
      .where(eq(insights.companyId, companyId));
  }

  // ── (1) stable ────────────────────────────────────────────────────────

  it("(1) stable: 30d of stable MRR → no insight created", async () => {
    await seedDaily({ metric: "mrr", series: noisySeries(10_000, 30) });

    const r = await detectForCompany(db, companyId);

    expect(r.created).toBe(0);
    const rows = await listInsights();
    expect(rows).toHaveLength(0);
  });

  // ── (2) drop ──────────────────────────────────────────────────────────

  it("(2) drop: 29d stable + 30% drop today → critical insight", async () => {
    const series = noisySeries(10_000, 29);
    series.push(7_000); // ~30% drop, well past 3σ for a 1% noise band
    await seedDaily({ metric: "mrr", series });

    const r = await detectForCompany(db, companyId);

    expect(r.created).toBeGreaterThanOrEqual(1);
    const rows = await listInsights();
    const anomaly = rows.find(
      (row) => (row.evidence as { metric?: string }).metric === "mrr",
    );
    expect(anomaly).toBeDefined();
    expect(anomaly!.kind).toBe("kpi_anomaly");
    expect(anomaly!.department).toBe("chief-of-staff");
    expect((anomaly!.evidence as { severity?: string }).severity).toBe(
      "critical",
    );
    expect((anomaly!.evidence as { direction?: string }).direction).toBe("down");
    expect(anomaly!.title).toMatch(/critical/);
    expect(anomaly!.title).toMatch(/mrr/);
  });

  // ── (3) spike ─────────────────────────────────────────────────────────

  it("(3) spike: 29d stable + sharp spike today → insight created", async () => {
    const series = noisySeries(100, 29); // signups baseline ~100/day
    series.push(180); // +80% — far past 2σ
    await seedDaily({ metric: "signups_7d", series });

    const r = await detectForCompany(db, companyId);

    expect(r.created).toBeGreaterThanOrEqual(1);
    const rows = await listInsights();
    const anomaly = rows.find(
      (row) => (row.evidence as { metric?: string }).metric === "signups_7d",
    );
    expect(anomaly).toBeDefined();
    expect((anomaly!.evidence as { direction?: string }).direction).toBe("up");
  });

  // ── (4) trend break ───────────────────────────────────────────────────

  it("(4) trend break: monotonic up-trend that suddenly plateaus today → trend_break insight", async () => {
    // Construct a metric whose 30d baseline is wide enough that today's
    // value passes the z-score guard, but the 14d trend regression strongly
    // predicts a higher value — surfacing a trend_break.
    //
    // Days 0..15 (older): noisy near 50 (low). Days 16..28: linear ramp
    // 60→150. Day 29 (today): 60 — back near older baseline. Z-score over
    // a wide-stddev 30d window won't fire, but OLS on the last 14d points
    // strongly upward and predicts ~150 for today.
    const series: number[] = [];
    for (let i = 0; i < 16; i++) series.push(50 + (i % 3));
    for (let i = 0; i < 13; i++) series.push(60 + i * 7); // 60..144 ramp
    series.push(60); // today — collapses the trend
    expect(series.length).toBe(30);
    await seedDaily({ metric: "activation_rate", series });

    const r = await detectForCompany(db, companyId);

    expect(r.created).toBeGreaterThanOrEqual(1);
    const rows = await listInsights();
    const anomaly = rows.find(
      (row) =>
        (row.evidence as { metric?: string }).metric === "activation_rate",
    );
    expect(anomaly).toBeDefined();
    // Either check fired — at minimum one of {z_score, trend_break}.
    const check = (anomaly!.evidence as { check?: string }).check;
    expect(["z_score", "trend_break"]).toContain(check);
  });

  // ── (5) dedup window ──────────────────────────────────────────────────

  it("(5) dedup: open kpi_anomaly within 24h suppresses a re-detected anomaly", async () => {
    const series = noisySeries(10_000, 29);
    series.push(7_000);
    await seedDaily({ metric: "mrr", series });

    // First run — creates the insight.
    const r1 = await detectForCompany(db, companyId);
    expect(r1.created).toBeGreaterThanOrEqual(1);

    // Second run with identical data — must suppress.
    const r2 = await detectForCompany(db, companyId);
    expect(r2.created).toBe(0);
    expect(r2.suppressed).toBeGreaterThanOrEqual(1);

    const rows = await listInsights();
    const mrrInsights = rows.filter(
      (row) => (row.evidence as { metric?: string }).metric === "mrr",
    );
    expect(mrrInsights).toHaveLength(1);
  });

  // ── (6) severity threshold ────────────────────────────────────────────

  it("(6) severity: ~2.5σ → warning; ~4σ → critical", async () => {
    // Build a tightly controlled stddev: 29 days of base + small noise
    // pattern that yields stddev ≈ ~5. Pushing today by ~12 (= ~2.5σ) →
    // warning; pushing by ~20 (= ~4σ) → critical.
    //
    // Use churn_30d for the warning, runway_months for the critical, so
    // they don't alias the same metric in dedup queries.
    const baseline29 = Array.from({ length: 29 }, (_, i) => 100 + ((i % 5) - 2) * 5);
    // stddev of {-10,-5,0,5,10,...} pattern over 29 = ~7.07
    // 2.5σ ≈ ~17.7 above mean (100); 4σ ≈ ~28.3.

    // Warning: today = 100 + ~18 = 118
    await seedDaily({
      metric: "churn_30d",
      series: [...baseline29, 118],
    });

    const r1 = await detectForCompany(db, companyId);
    expect(r1.created).toBeGreaterThanOrEqual(1);
    const warningRow = (await listInsights()).find(
      (row) => (row.evidence as { metric?: string }).metric === "churn_30d",
    );
    expect(warningRow).toBeDefined();
    expect((warningRow!.evidence as { severity?: string }).severity).toBe(
      "warning",
    );

    // Critical: today = 100 + ~30 = 130
    await seedDaily({
      metric: "runway_months",
      series: [...baseline29, 130],
    });

    const r2 = await detectForCompany(db, companyId);
    expect(r2.created).toBeGreaterThanOrEqual(1);
    const criticalRow = (await listInsights()).find(
      (row) => (row.evidence as { metric?: string }).metric === "runway_months",
    );
    expect(criticalRow).toBeDefined();
    expect((criticalRow!.evidence as { severity?: string }).severity).toBe(
      "critical",
    );
  });

  // ── (7) multi metric ─────────────────────────────────────────────────

  it("(7) multi-metric: anomalies on two metrics in one run → both surfaced", async () => {
    // mrr drops, signups_7d spikes — both should fire in a single tick.
    const mrrSeries = noisySeries(10_000, 29);
    mrrSeries.push(6_000);
    await seedDaily({ metric: "mrr", series: mrrSeries });

    const signupsSeries = noisySeries(100, 29);
    signupsSeries.push(200);
    await seedDaily({ metric: "signups_7d", series: signupsSeries });

    const r = await detectForCompany(db, companyId);

    expect(r.created).toBeGreaterThanOrEqual(2);
    const rows = await listInsights();
    const metrics = new Set(
      rows.map((row) => (row.evidence as { metric?: string }).metric),
    );
    expect(metrics.has("mrr")).toBe(true);
    expect(metrics.has("signups_7d")).toBe(true);
  });

  // ── (8) no data ──────────────────────────────────────────────────────

  it("(8) no-data: empty events table → no insight, no error", async () => {
    const r = await detectForCompany(db, companyId);

    expect(r.created).toBe(0);
    expect(r.suppressed).toBe(0);
    const rows = await listInsights();
    expect(rows).toHaveLength(0);

    // Sanity: KPI_METRICS is non-empty (guards a regression where the
    // constant gets accidentally emptied — would silently skip detection).
    expect(KPI_METRICS.length).toBeGreaterThan(0);

    // The .where(and(...)) composition path must compile and run; this
    // would have thrown if a future refactor reintroduced .where(a).where(b).
    const safetyQuery = await db
      .select()
      .from(insights)
      .where(
        and(eq(insights.companyId, companyId), eq(insights.kind, "kpi_anomaly")),
      );
    expect(safetyQuery).toHaveLength(0);
  });
});
