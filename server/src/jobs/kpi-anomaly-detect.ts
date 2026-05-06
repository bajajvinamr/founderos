/**
 * kpi-anomaly-detect.ts — KPI anomaly detection job (S3.2).
 *
 * Recurring BullMQ job, every 15 min per active workspace. For each metric in
 * the well-known set (mrr, signups_7d, activation_rate, churn_30d,
 * runway_months) it pulls the last 30d of `events` rows tagged
 * (entity_type='kpi', event_name=<metric>), aggregates them per UTC day, then:
 *
 *   1. Z-score check: if |current - mean(baseline)| > 2σ → flag.
 *      Severity = 'critical' if |current - mean| > 3σ else 'warning'.
 *   2. Trend-break check: ordinary least squares regression on the most recent
 *      14d of daily values. If today's actual deviates from the regression
 *      prediction by more than 2 * residual stddev → flag as trend break
 *      (severity tag included in evidence).
 *
 * Both checks write `insights` rows with kind='kpi_anomaly',
 * department='chief-of-staff', confidence=0.85.
 *
 * Dedup contract (alert fatigue mitigation): an insight is suppressed when an
 * `open` insight with the same kind AND evidence.metric exists for this
 * company in the last 24h. Uses the JSONB `evidence->>'metric'` accessor —
 * the JSON path is inside the WHERE clause via raw `sql\`\``, NOT in a
 * `.where()` chain (Drizzle's `.where(a).where(b)` REPLACES, not ANDs).
 *
 * Event convention: callers (the agents emitting KPI snapshots) write rows
 *   { entity_type: 'kpi', event_name: '<metric>', payload: { value: number },
 *     occurred_at: <day>, source: 'stripe' | 'posthog' | ... }
 * The job is source-agnostic — it filters only on entity_type + event_name.
 *
 * Why aggregate to daily means rather than using raw event values: multiple
 * sources may emit the same metric within a single day (Stripe webhook +
 * PostHog batch + manual override). Daily aggregation collapses these to a
 * single observation per metric per day, preventing source-volume noise from
 * dominating the rolling stddev.
 */

import type { Worker } from "bullmq";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { companies, events, insights } from "@founderos/db";
import { getQueue, QUEUE_NAMES, setupDlqListener } from "../lib/queues.js";
import { logger } from "../middleware/logger.js";

// ── Constants ────────────────────────────────────────────────────────────

/** Metrics the job watches. Add to this list as new KPIs are emitted. */
export const KPI_METRICS = [
  "mrr",
  "signups_7d",
  "activation_rate",
  "churn_30d",
  "runway_months",
] as const;

export type KpiMetric = (typeof KPI_METRICS)[number];

/** Fixed confidence assigned to anomaly insights — 2σ is the gate. */
const ANOMALY_CONFIDENCE = 0.85;

/** σ multiplier for warning-level z-score anomalies. */
const Z_WARNING = 2;

/** σ multiplier above which severity escalates to critical. */
const Z_CRITICAL = 3;

/** Window for the rolling baseline mean/stddev. */
const BASELINE_DAYS = 30;

/** Window for trend-break linear regression. */
const TREND_DAYS = 14;

/** Minimum baseline samples required before z-score is meaningful. */
const MIN_BASELINE_SAMPLES = 7;

/** Minimum trend samples for OLS to be meaningful. */
const MIN_TREND_SAMPLES = 7;

/** Recurring schedule — every 15 minutes (matches S3 spec). */
const KPI_ANOMALY_CRON = "*/15 * * * *";

/** Queue name for the anomaly detection job. */
export const KPI_ANOMALY_QUEUE = "kpi.anomaly";

// ── Public job init / worker ─────────────────────────────────────────────

export interface KpiAnomalyJobOptions {
  db: Db;
}

/**
 * Initialize the recurring KPI anomaly detection job. Call once at server
 * startup. Idempotent via `jobId` — re-registering the same recurring job
 * does NOT create duplicates.
 */
export async function initKpiAnomalyJob(
  opts: KpiAnomalyJobOptions,
): Promise<void> {
  const queue = getQueue(KPI_ANOMALY_QUEUE);
  setupDlqListener(KPI_ANOMALY_QUEUE);

  await queue.add(
    "detect-all-workspaces",
    { trigger: "cron" },
    {
      repeat: { pattern: KPI_ANOMALY_CRON },
      jobId: "kpi-anomaly-detect-all-workspaces-recurring",
    },
  );

  logger.info({ pattern: KPI_ANOMALY_CRON }, "KPI anomaly job initialized");
}

/** Attach the worker that processes anomaly detection ticks. */
export async function attachKpiAnomalyWorker(db: Db): Promise<Worker> {
  const { Worker: BullWorker } = await import("bullmq");
  const queue = getQueue(KPI_ANOMALY_QUEUE);

  const worker = new BullWorker(
    KPI_ANOMALY_QUEUE,
    async (job) => {
      if (job.name === "detect-all-workspaces") {
        return runForAllWorkspaces(db);
      }
      throw new Error(`Unknown KPI anomaly job: ${job.name}`);
    },
    {
      connection: (queue.client as unknown as { options: unknown }).options as never,
      concurrency: 1,
    },
  );

  worker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, jobName: job?.name, err },
      "KPI anomaly job failed",
    );
  });

  return worker;
}

// ── Pure-ish detection logic (testable without BullMQ) ───────────────────

export interface RunResult {
  workspacesProcessed: number;
  insightsCreated: number;
  insightsSuppressed: number;
  errors: Array<{ companyId: string; error: string }>;
}

/**
 * Iterate over every active workspace and run anomaly detection. Errors per
 * workspace are caught and logged so a single bad tenant cannot starve the
 * cron tick.
 */
export async function runForAllWorkspaces(db: Db): Promise<RunResult> {
  const result: RunResult = {
    workspacesProcessed: 0,
    insightsCreated: 0,
    insightsSuppressed: 0,
    errors: [],
  };

  const activeCompanies = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.status, "active"));

  for (const company of activeCompanies) {
    try {
      const r = await detectForCompany(db, company.id);
      result.workspacesProcessed++;
      result.insightsCreated += r.created;
      result.insightsSuppressed += r.suppressed;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      result.errors.push({ companyId: company.id, error: errorMsg });
      logger.error(
        { companyId: company.id, err },
        "KPI anomaly detection failed for workspace (non-fatal, continuing)",
      );
    }
  }

  logger.info(
    {
      workspacesProcessed: result.workspacesProcessed,
      insightsCreated: result.insightsCreated,
      insightsSuppressed: result.insightsSuppressed,
      errorCount: result.errors.length,
    },
    "KPI anomaly cycle complete",
  );

  return result;
}

interface PerCompanyResult {
  created: number;
  suppressed: number;
}

/**
 * Run detection for a single company. Exposed for testing — the test seeds
 * events directly and calls this rather than the full BullMQ tick.
 */
export async function detectForCompany(
  db: Db,
  companyId: string,
): Promise<PerCompanyResult> {
  const result: PerCompanyResult = { created: 0, suppressed: 0 };

  // 30d cutoff (UTC, day-aligned) for both fetch + dedup.
  const baselineCutoff = new Date(Date.now() - BASELINE_DAYS * 86_400_000);

  for (const metric of KPI_METRICS) {
    // ── Fetch raw KPI events ────────────────────────────────────────────
    const rows = await db
      .select({
        occurredAt: events.occurredAt,
        payload: events.payload,
      })
      .from(events)
      .where(
        and(
          eq(events.companyId, companyId),
          eq(events.entityType, "kpi"),
          eq(events.eventName, metric),
          gte(events.occurredAt, baselineCutoff),
        ),
      );

    if (rows.length === 0) continue;

    // ── Aggregate per UTC day (mean of multi-source values) ─────────────
    const dailyValues = aggregateDaily(
      rows.map((r) => ({
        occurredAt: r.occurredAt,
        value: extractValue(r.payload),
      })).filter((r): r is { occurredAt: Date; value: number } =>
        r.value !== null,
      ),
    );

    if (dailyValues.length < MIN_BASELINE_SAMPLES) continue;

    // Sort ascending by day; current = newest, baseline = the rest.
    dailyValues.sort((a, b) => a.day.getTime() - b.day.getTime());
    const current = dailyValues[dailyValues.length - 1]!;
    const baselineSeries = dailyValues.slice(0, -1);
    if (baselineSeries.length < MIN_BASELINE_SAMPLES - 1) continue;

    const baselineValues = baselineSeries.map((d) => d.value);
    const baselineMean = mean(baselineValues);
    const baselineStddev = stddev(baselineValues, baselineMean);

    // ── (1) Z-score anomaly ─────────────────────────────────────────────
    const zAnomaly = checkZScore({
      current: current.value,
      mean: baselineMean,
      stddev: baselineStddev,
    });

    if (zAnomaly) {
      const inserted = await maybeWriteInsight(db, {
        companyId,
        metric,
        check: "z_score",
        current: current.value,
        baselineMean,
        baselineStddev,
        severity: zAnomaly.severity,
        delta: zAnomaly.delta,
        sigmaCount: zAnomaly.sigmaCount,
        direction: zAnomaly.direction,
      });
      if (inserted) result.created++;
      else result.suppressed++;
    }

    // ── (2) Trend-break (linear regression on last 14d) ─────────────────
    if (dailyValues.length >= MIN_TREND_SAMPLES) {
      const trendWindow = dailyValues.slice(-TREND_DAYS);
      if (trendWindow.length >= MIN_TREND_SAMPLES) {
        const trendBreak = checkTrendBreak(trendWindow);
        if (trendBreak) {
          // De-collide with z-score: only emit if z-score did NOT already fire
          // or if the trend break severity is critical (which z-score would
          // also have caught — keeping the second insight is redundant).
          if (!zAnomaly) {
            const inserted = await maybeWriteInsight(db, {
              companyId,
              metric,
              check: "trend_break",
              current: trendBreak.actual,
              baselineMean: trendBreak.predicted,
              baselineStddev: trendBreak.residualStddev,
              severity: trendBreak.severity,
              delta: trendBreak.actual - trendBreak.predicted,
              sigmaCount: trendBreak.sigmaCount,
              direction: trendBreak.actual >= trendBreak.predicted ? "up" : "down",
            });
            if (inserted) result.created++;
            else result.suppressed++;
          }
        }
      }
    }
  }

  return result;
}

// ── Statistics helpers ───────────────────────────────────────────────────

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function stddev(values: number[], precomputedMean?: number): number {
  if (values.length < 2) return 0;
  const m = precomputedMean ?? mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) ** 2;
  // Sample stddev (Bessel's correction) — n-1 is the right denominator for
  // a baseline drawn from a population we can't fully observe.
  return Math.sqrt(acc / (values.length - 1));
}

interface ZAnomaly {
  severity: "warning" | "critical";
  delta: number;
  sigmaCount: number;
  direction: "up" | "down";
}

function checkZScore(args: {
  current: number;
  mean: number;
  stddev: number;
}): ZAnomaly | null {
  // Stddev floor: if the baseline is perfectly flat (stddev 0), any change
  // is technically "infinite sigmas" — meaningless. Require a small absolute
  // change relative to the mean to avoid noise on a flat series.
  if (args.stddev === 0) {
    if (Math.abs(args.mean) < 1e-9) return null;
    const relChange = Math.abs(args.current - args.mean) / Math.abs(args.mean);
    if (relChange < 0.05) return null;
    return {
      severity: relChange > 0.3 ? "critical" : "warning",
      delta: args.current - args.mean,
      sigmaCount: Number.POSITIVE_INFINITY,
      direction: args.current >= args.mean ? "up" : "down",
    };
  }

  const delta = args.current - args.mean;
  const sigmaCount = Math.abs(delta) / args.stddev;
  if (sigmaCount <= Z_WARNING) return null;
  return {
    severity: sigmaCount > Z_CRITICAL ? "critical" : "warning",
    delta,
    sigmaCount,
    direction: delta >= 0 ? "up" : "down",
  };
}

interface TrendBreak {
  actual: number;
  predicted: number;
  residualStddev: number;
  sigmaCount: number;
  severity: "warning" | "critical";
}

/**
 * Ordinary least-squares regression on (day_index, value). Returns a
 * trend-break signal only when today's residual exceeds 2× residual stddev
 * (computed over the historical window ex-today).
 */
function checkTrendBreak(window: Array<{ day: Date; value: number }>): TrendBreak | null {
  // Use day index 0..n-1; values are already sorted ascending.
  const n = window.length;
  const xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push(i);
  const ys = window.map((w) => w.value);

  // Fit on the first n-1 points (history); evaluate the last point.
  const histX = xs.slice(0, n - 1);
  const histY = ys.slice(0, n - 1);
  if (histX.length < 2) return null;

  const meanX = mean(histX);
  const meanY = mean(histY);
  let num = 0;
  let den = 0;
  for (let i = 0; i < histX.length; i++) {
    num += (histX[i]! - meanX) * (histY[i]! - meanY);
    den += (histX[i]! - meanX) ** 2;
  }
  if (den === 0) return null;

  const slope = num / den;
  const intercept = meanY - slope * meanX;

  // Residuals on the historical fit.
  const residuals: number[] = [];
  for (let i = 0; i < histX.length; i++) {
    const pred = intercept + slope * histX[i]!;
    residuals.push(histY[i]! - pred);
  }
  const residualStddev = stddev(residuals, 0);

  // Predict + compare today's actual.
  const todayX = xs[n - 1]!;
  const predicted = intercept + slope * todayX;
  const actual = ys[n - 1]!;

  // Perfect-fit fallback: when historical residuals are exactly zero (noise-
  // free linear ramp in the test fixtures, or any synthetic time series),
  // a sigma test is undefined. Use a relative-deviation guard against the
  // predicted value: >5% off → warning, >30% off → critical. Skip when
  // predicted is ~zero to avoid divide-by-zero in the relative form.
  if (residualStddev === 0) {
    if (Math.abs(predicted) < 1e-9) return null;
    const relDev = Math.abs(actual - predicted) / Math.abs(predicted);
    if (relDev < 0.05) return null;
    return {
      actual,
      predicted,
      residualStddev,
      sigmaCount: Number.POSITIVE_INFINITY,
      severity: relDev > 0.3 ? "critical" : "warning",
    };
  }

  const sigmaCount = Math.abs(actual - predicted) / residualStddev;
  if (sigmaCount <= Z_WARNING) return null;

  return {
    actual,
    predicted,
    residualStddev,
    sigmaCount,
    severity: sigmaCount > Z_CRITICAL ? "critical" : "warning",
  };
}

// ── Aggregation ──────────────────────────────────────────────────────────

interface DailyPoint {
  day: Date;
  value: number;
}

/** Bucket per UTC day, mean of values within each day. */
function aggregateDaily(
  rows: Array<{ occurredAt: Date; value: number }>,
): DailyPoint[] {
  const buckets = new Map<string, { sum: number; count: number; day: Date }>();
  for (const row of rows) {
    const day = new Date(
      Date.UTC(
        row.occurredAt.getUTCFullYear(),
        row.occurredAt.getUTCMonth(),
        row.occurredAt.getUTCDate(),
      ),
    );
    const key = day.toISOString();
    const existing = buckets.get(key);
    if (existing) {
      existing.sum += row.value;
      existing.count += 1;
    } else {
      buckets.set(key, { sum: row.value, count: 1, day });
    }
  }
  return Array.from(buckets.values()).map((b) => ({
    day: b.day,
    value: b.sum / b.count,
  }));
}

/** Read a numeric value from the event payload. Tolerant of common shapes. */
function extractValue(payload: unknown): number | null {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.value === "number" && Number.isFinite(obj.value)) {
      return obj.value;
    }
  }
  return null;
}

// ── Insight write + dedup ────────────────────────────────────────────────

interface InsightInput {
  companyId: string;
  metric: KpiMetric;
  check: "z_score" | "trend_break";
  current: number;
  baselineMean: number;
  baselineStddev: number;
  severity: "warning" | "critical";
  delta: number;
  sigmaCount: number;
  direction: "up" | "down";
}

/**
 * Insert an `insights` row unless an open kpi_anomaly insight for the same
 * metric exists for this company within the last 24h (alert-fatigue
 * suppressor). Returns true on insert, false on suppression.
 */
async function maybeWriteInsight(db: Db, input: InsightInput): Promise<boolean> {
  // Dedup query — 24h window, same metric, same kind, status=open.
  // The JSON path lookup MUST live inside the WHERE clause as raw sql
  // because Drizzle's chained `.where()` REPLACES rather than ANDs.
  const dedupRow = await db.execute(sql`
    SELECT 1 FROM "insights"
    WHERE "company_id" = ${input.companyId}
      AND "kind" = 'kpi_anomaly'
      AND "status" = 'open'
      AND "created_at" > now() - interval '24 hours'
      AND "evidence"->>'metric' = ${input.metric}
    LIMIT 1
  `);

  // pg-driver responses surface as { rows: [...] } in node-postgres but as
  // a plain array under PGlite. Handle both.
  const matched =
    Array.isArray(dedupRow)
      ? dedupRow.length > 0
      : Array.isArray((dedupRow as { rows?: unknown[] }).rows) &&
        (dedupRow as { rows: unknown[] }).rows.length > 0;
  if (matched) return false;

  const pctText = formatPctChange(input.current, input.baselineMean);
  const sigmaText =
    Number.isFinite(input.sigmaCount)
      ? input.sigmaCount.toFixed(2)
      : "∞";

  const title =
    input.check === "trend_break"
      ? `${input.severity}: ${input.metric} trend break ${input.direction} ${pctText}`
      : `${input.severity}: ${input.metric} ${input.direction} ${pctText}`;

  const body =
    input.check === "trend_break"
      ? `${input.metric} actual ${roundedValue(input.current)} vs predicted ` +
        `${roundedValue(input.baselineMean)} (${sigmaText}σ from regression).`
      : `${input.metric} moved from ${roundedValue(input.baselineMean)} to ` +
        `${roundedValue(input.current)} (${sigmaText}σ).`;

  await db.insert(insights).values({
    companyId: input.companyId,
    department: "chief-of-staff",
    kind: "kpi_anomaly",
    title,
    body,
    confidence: ANOMALY_CONFIDENCE,
    evidence: {
      metric: input.metric,
      check: input.check,
      baseline: input.baselineMean,
      stddev: input.baselineStddev,
      current: input.current,
      severity: input.severity,
      sigmaCount: Number.isFinite(input.sigmaCount) ? input.sigmaCount : null,
      direction: input.direction,
    },
  });

  return true;
}

function formatPctChange(current: number, baseline: number): string {
  if (Math.abs(baseline) < 1e-9) return "Δ"; // baseline ~0; pct is meaningless
  const pct = ((current - baseline) / Math.abs(baseline)) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function roundedValue(v: number): string {
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(4);
}
