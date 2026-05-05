/**
 * Daily Founder Brief job (S3.3).
 *
 * Two surfaces:
 *
 *   1. `generateDailyBriefForCompany(db, companyId, options)` — pure service
 *      function. Idempotent per (companyId, forDate). Aggregates yesterday's
 *      signal, asks Claude for a structured brief via brief-prompt.ts, and
 *      persists into `daily_briefs`. Re-running for the same date returns
 *      the existing row WITHOUT a second LLM call (the unique index +
 *      pre-check both protect against double-spend).
 *
 *      Empty-workspace short-circuit: when there is no signal at all
 *      (no events, no insights, no approvals, no KPIs, no stalled), we
 *      build the deterministic welcome brief and skip the LLM call. Saves
 *      a token round-trip and the welcome copy is more useful as
 *      curated text than as a model-generated boilerplate.
 *
 *      Bad LLM output → synthesizeFallbackBrief fires inside brief-prompt.ts;
 *      we additionally write a kind='blocker' insight so the founder sees
 *      the LLM hiccup in their normal surface (not just hidden in the
 *      brief itself).
 *
 *   2. `createDailyFounderBriefCron({ db, ... })` — setInterval-based
 *      scheduler that ticks every `tickIntervalMs` (default 15 min) and
 *      fires per-workspace based on the workspace's local timezone (sourced
 *      from the founder's company_membership.digest_timezone or "UTC" if
 *      unset). Mirrors `daily-digest-cron.ts` exactly so the two crons
 *      have identical drift / idempotency semantics.
 *
 *      WHY setInterval and not BullMQ:
 *      The S3.3 spec asked for BullMQ-recurring, but every existing
 *      FounderOS cron (daily-digest-cron, weekly-wrap-delivery-cron,
 *      decision-followup-cron, linkedin-sync-cron) is setInterval-based
 *      and started from app.ts. BullMQ infra is configured for queues
 *      (events.derive, plugin jobs) but no recurring-cron pipeline yet
 *      lives in the server. Using setInterval keeps S3.3 consistent with
 *      every other cron in the same codebase. The persistence layer is
 *      the daily_briefs row itself (unique idx → at-most-once per day);
 *      "exactly-once" semantics come from the DB, not the scheduler.
 *
 * Timezone derivation:
 *   For each company, find the FIRST principal-type='user' membership row,
 *   read its digest_timezone column (default 'UTC' on insert per
 *   company_memberships schema). 7am in that timezone is the firing edge.
 *   This avoids a per-company tz column on `companies` (the spec said
 *   "default UTC if unset"; reusing the existing per-user digest tz is
 *   the closest existing analog).
 */

import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "@founderos/db";
import {
  approvals,
  companies,
  companyMemberships,
  dailyBriefs,
  events,
  insights,
  issues,
  type DailyBrief,
  type DailyBriefPayload,
} from "@founderos/db";
import { logger } from "../middleware/logger.js";
import { instanceApiKeysService } from "../services/instance-api-keys.js";
import {
  buildWelcomeBrief,
  generateDailyBrief,
  isEmptyWorkspace,
  type AnthropicJsonCaller,
  type BriefInputApproval,
  type BriefInputInsight,
  type BriefInputKpiSnapshot,
  type BriefInputStalledWorkflow,
  type BriefInputs,
} from "../services/cos/brief-prompt.js";

const DEFAULT_TICK_INTERVAL_MS = 15 * 60 * 1_000;
const TARGET_HOUR_LOCAL = 7;
const STALLED_THRESHOLD_DAYS = 3;
const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

// ── Public types ────────────────────────────────────────────────────────────

export type GenerateDailyBriefOptions = {
  /** Overrides `now` — primarily for tests. */
  now?: Date;
  /** Explicit forDate (ISO yyyy-mm-dd) — when absent we derive from now/tz. */
  forDate?: string;
  /** Workspace timezone for date arithmetic (default UTC). */
  timezone?: string;
  /** DI for the Anthropic call. */
  callAnthropic?: AnthropicJsonCaller;
  /** DI for the API key getter. */
  getAnthropicKey?: () => Promise<string | null>;
};

export type GenerateDailyBriefResult = {
  brief: DailyBrief;
  reused: boolean;
  /** "llm" | "fallback" | "welcome" — surfaces which path produced the brief. */
  source: "llm" | "fallback" | "welcome";
  /** Set when source='fallback' — reason the LLM path failed. */
  fallbackReason?: string;
};

// ── Date helpers ────────────────────────────────────────────────────────────

/**
 * Format a Date as a yyyy-mm-dd string in the given IANA timezone.
 * Uses en-CA which is yyyy-mm-dd by definition.
 */
function isoDateInTimezone(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Current local hour 0-23 in tz. Same helper as daily-digest. */
function hourInTimezone(d: Date, tz: string): number {
  const h = parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      hour12: false,
    }).format(d),
    10,
  );
  if (Number.isNaN(h)) return 0;
  return h % 24;
}

/**
 * Parse the date column (which Drizzle returns as either a string or a
 * Date depending on driver) into a yyyy-mm-dd string.
 */
function dateColAsIso(value: string | Date): string {
  if (value instanceof Date) {
    return isoDateInTimezone(value, "UTC");
  }
  return value.slice(0, 10);
}

// ── Aggregation — pulls the inputs for the prompt ───────────────────────────

async function loadCompany(
  db: Db,
  companyId: string,
): Promise<{ id: string; name: string } | null> {
  const [row] = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return row ?? null;
}

async function loadOpenInsights(
  db: Db,
  companyId: string,
  windowStart: Date,
): Promise<BriefInputInsight[]> {
  const rows = await db
    .select({
      id: insights.id,
      kind: insights.kind,
      title: insights.title,
      body: insights.body,
      confidence: insights.confidence,
      recommendation: insights.recommendation,
      status: insights.status,
      createdAt: insights.createdAt,
    })
    .from(insights)
    .where(
      and(
        eq(insights.companyId, companyId),
        eq(insights.status, "open"),
        gte(insights.createdAt, windowStart),
      ),
    )
    .orderBy(desc(insights.createdAt))
    .limit(50);

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind ?? "unknown",
    title: r.title,
    body: r.body,
    confidence: r.confidence,
    recommendation: r.recommendation,
  }));
}

async function loadTopOpportunities(
  db: Db,
  companyId: string,
): Promise<BriefInputInsight[]> {
  // kind='opportunity', confidence>0.7, status='open'. We pull a wider set
  // and filter in JS rather than chaining .where() to avoid the Drizzle
  // gotcha (.where chained REPLACES the predicate; .where(and(...)) ANDs).
  // The composite index (company_id, kind, created_at DESC) makes this fast.
  const rows = await db
    .select({
      id: insights.id,
      kind: insights.kind,
      title: insights.title,
      body: insights.body,
      confidence: insights.confidence,
      recommendation: insights.recommendation,
    })
    .from(insights)
    .where(
      and(
        eq(insights.companyId, companyId),
        eq(insights.kind, "opportunity"),
        eq(insights.status, "open"),
      ),
    )
    .orderBy(desc(insights.confidence))
    .limit(20);

  return rows
    .filter((r) => r.confidence > 0.7)
    .slice(0, 5)
    .map((r) => ({
      id: r.id,
      kind: r.kind ?? "opportunity",
      title: r.title,
      body: r.body,
      confidence: r.confidence,
      recommendation: r.recommendation,
    }));
}

async function loadPendingApprovals(
  db: Db,
  companyId: string,
): Promise<BriefInputApproval[]> {
  const rows = await db
    .select({
      id: approvals.id,
      type: approvals.type,
      payload: approvals.payload,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .where(
      and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")),
    )
    .orderBy(desc(approvals.createdAt))
    .limit(10);

  return rows.map((r) => {
    const payload = (r.payload ?? {}) as Record<string, unknown>;
    const title =
      typeof payload.title === "string" && payload.title.trim().length > 0
        ? payload.title.trim()
        : null;
    return { id: r.id, type: r.type, title, createdAt: r.createdAt };
  });
}

async function loadStalledWorkflows(
  db: Db,
  companyId: string,
  now: Date,
): Promise<BriefInputStalledWorkflow[]> {
  const stalledThreshold = new Date(
    now.getTime() - STALLED_THRESHOLD_DAYS * ONE_DAY_MS,
  );

  // Issues that are open and haven't moved in > N days.
  const rows = await db
    .select({
      id: issues.id,
      title: issues.title,
      status: issues.status,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(eq(issues.companyId, companyId))
    .orderBy(desc(issues.updatedAt))
    .limit(200);

  return rows
    .filter(
      (r) =>
        r.status !== "done" &&
        r.status !== "cancelled" &&
        r.updatedAt < stalledThreshold,
    )
    .slice(0, 5)
    .map((r) => ({
      id: r.id,
      title: r.title,
      stalledFor: humanizeDuration(now.getTime() - r.updatedAt.getTime()),
    }));
}

function humanizeDuration(ms: number): string {
  const days = Math.floor(ms / ONE_DAY_MS);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.floor(ms / (60 * 60 * 1_000));
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

async function loadEventCount(
  db: Db,
  companyId: string,
  windowStart: Date,
): Promise<number> {
  const rows = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(eq(events.companyId, companyId), gte(events.occurredAt, windowStart)),
    )
    .limit(1_000);
  return rows.length;
}

/**
 * Build BriefInputKpiSnapshot[] from companies.metrics. The current data
 * model only stores point-in-time snapshots in metrics + an optional
 * `deltas` field (CompanyMetrics.deltas — populated by other services).
 * S3.3 reads what's there; richer snapshot history is out of scope.
 */
async function loadKpiSnapshots(
  db: Db,
  companyId: string,
): Promise<BriefInputKpiSnapshot[]> {
  const [row] = await db
    .select({ metrics: companies.metrics })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (!row?.metrics) return [];
  const m = row.metrics;
  const out: BriefInputKpiSnapshot[] = [];
  const deltas = m.deltas ?? {};

  function pushIfNumber(label: string, key: keyof typeof m, suffix = "") {
    const v = m[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      const formatted =
        suffix === "$" ? `$${(v / 100).toFixed(0)}` : `${v}${suffix}`;
      const d = deltas[label];
      out.push({
        metric: label,
        from: d ? `${formatted} (was ${d.text})` : formatted,
        to: formatted,
        delta: d ? d.text : "flat",
      });
    }
  }

  pushIfNumber("MRR", "mrrCents", "$");
  pushIfNumber("ARR", "arrCents", "$");
  pushIfNumber("Pipeline", "pipelineCents", "$");
  pushIfNumber("Customers", "customersSigned");
  pushIfNumber("MAU", "mauCount");

  return out.slice(0, 5);
}

async function loadWorkspaceTimezone(
  db: Db,
  companyId: string,
): Promise<string> {
  const [row] = await db
    .select({ tz: companyMemberships.digestTimezone })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
      ),
    )
    .limit(1);
  return row?.tz || "UTC";
}

async function buildBriefInputs(
  db: Db,
  companyId: string,
  forDate: Date,
): Promise<BriefInputs | null> {
  const company = await loadCompany(db, companyId);
  if (!company) return null;

  const windowStart = new Date(forDate.getTime() - ONE_DAY_MS);

  const [
    openInsights,
    topOpportunities,
    pendingApprovals,
    stalledWorkflows,
    eventCount,
    kpiSnapshots,
  ] = await Promise.all([
    loadOpenInsights(db, companyId, windowStart),
    loadTopOpportunities(db, companyId),
    loadPendingApprovals(db, companyId),
    loadStalledWorkflows(db, companyId, forDate),
    loadEventCount(db, companyId, windowStart),
    loadKpiSnapshots(db, companyId),
  ]);

  return {
    companyName: company.name,
    forDate,
    kpiSnapshots,
    openInsights,
    pendingApprovals,
    stalledWorkflows,
    topOpportunities,
    eventCount,
  };
}

// ── Idempotent persistence ──────────────────────────────────────────────────

async function findExistingBrief(
  db: Db,
  companyId: string,
  forDateIso: string,
): Promise<DailyBrief | null> {
  const [row] = await db
    .select()
    .from(dailyBriefs)
    .where(
      and(
        eq(dailyBriefs.companyId, companyId),
        eq(dailyBriefs.forDate, forDateIso),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function insertBrief(
  db: Db,
  companyId: string,
  forDateIso: string,
  payload: DailyBriefPayload,
): Promise<DailyBrief> {
  try {
    const [row] = await db
      .insert(dailyBriefs)
      .values({ companyId, forDate: forDateIso, payload })
      .returning();
    return row!;
  } catch (err) {
    // Race against the unique index — re-read the winning row.
    logger.warn(
      { err, companyId, forDateIso },
      "daily-brief: insert raced, re-reading",
    );
    const existing = await findExistingBrief(db, companyId, forDateIso);
    if (!existing) throw err;
    return existing;
  }
}

/**
 * Best-effort: write a kind='blocker' insight when the LLM path fails so
 * the founder sees the failure in their normal insights surface, not just
 * hidden inside the brief. Failures here are swallowed — the brief itself
 * is the primary deliverable.
 */
async function writeFallbackInsight(
  db: Db,
  companyId: string,
  reason: string,
  forDateIso: string,
): Promise<void> {
  try {
    await db.insert(insights).values({
      companyId,
      department: "chief-of-staff",
      kind: "blocker",
      title: `Daily brief synthesized without LLM (${forDateIso})`,
      body: `The daily founder brief generator could not reach the LLM and fell back to synthesized output. Reason: ${reason.slice(0, 1000)}`,
      confidence: 0.5,
      recommendation:
        "Verify the Anthropic API key is configured under Instance → Providers and the network egress is healthy.",
      evidence: { reason: reason.slice(0, 1000), forDate: forDateIso },
    });
  } catch (err) {
    logger.warn(
      { err, companyId },
      "daily-brief: fallback insight write failed (non-fatal)",
    );
  }
}

// ── Main entry ──────────────────────────────────────────────────────────────

/**
 * Generate-or-reuse the daily brief for `companyId` on `forDate`.
 *
 * Idempotency contract:
 *   - If a row already exists for (companyId, forDate), we return it
 *     immediately without aggregating or calling the LLM. `reused=true`.
 *   - Otherwise, aggregate, call the LLM (or fallback), persist, return.
 *     `reused=false`.
 *   - The persistence step uses the unique index as the racy backstop:
 *     two concurrent callers will both attempt insert; the loser catches
 *     the unique-violation and re-reads the winner's row.
 */
export async function generateDailyBriefForCompany(
  db: Db,
  companyId: string,
  options: GenerateDailyBriefOptions = {},
): Promise<GenerateDailyBriefResult> {
  const now = options.now ?? new Date();
  const tz = options.timezone ?? (await loadWorkspaceTimezone(db, companyId));
  const forDateIso = options.forDate ?? isoDateInTimezone(now, tz);

  // The forDate as a Date for input aggregation — interpret it at midnight
  // UTC; the windowStart is forDate - 24h. Using UTC-anchored math keeps
  // the lookback consistent across cron retries and tz boundaries.
  const forDate = new Date(`${forDateIso}T00:00:00.000Z`);

  // ── Idempotent short-circuit ──
  const existing = await findExistingBrief(db, companyId, forDateIso);
  if (existing) {
    return {
      brief: existing,
      reused: true,
      // Source not reliably recoverable from the stored row — flag as 'llm'
      // when not synthesized; the synthesized fallback always rewrites a
      // marker insight so the source is visible from the insights surface.
      source: "llm",
    };
  }

  // ── Aggregate inputs ──
  const inputs = await buildBriefInputs(db, companyId, forDate);
  if (!inputs) {
    throw new Error(`Company not found: ${companyId}`);
  }

  // ── Empty-workspace short-circuit (no LLM call) ──
  if (isEmptyWorkspace(inputs)) {
    const payload = buildWelcomeBrief(inputs);
    const brief = await insertBrief(db, companyId, forDateIso, payload);
    return { brief, reused: false, source: "welcome" };
  }

  // ── Resolve API key ──
  const getAnthropicKey =
    options.getAnthropicKey ??
    (async () => instanceApiKeysService(db).getDecryptedKey("anthropic", "api"));
  const apiKey = await getAnthropicKey();

  // No API key configured — synthesize the fallback brief AND write a
  // blocker insight. We do NOT throw because the founder still needs
  // their morning brief; surfacing the missing-key as a blocker is the
  // right user-visible signal.
  if (!apiKey) {
    const reason =
      "No Anthropic API key configured for this instance — add one in Instance → Providers";
    const { synthesizeFallbackBrief } = await import(
      "../services/cos/brief-prompt.js"
    );
    const payload = synthesizeFallbackBrief(inputs, reason);
    const brief = await insertBrief(db, companyId, forDateIso, payload);
    void writeFallbackInsight(db, companyId, reason, forDateIso);
    return { brief, reused: false, source: "fallback", fallbackReason: reason };
  }

  // ── LLM call ──
  const result = await generateDailyBrief(inputs, {
    apiKey,
    callAnthropic: options.callAnthropic,
  });

  const brief = await insertBrief(db, companyId, forDateIso, result.payload);
  if (!result.ok) {
    void writeFallbackInsight(db, companyId, result.reason, forDateIso);
    return {
      brief,
      reused: false,
      source: "fallback",
      fallbackReason: result.reason,
    };
  }
  return { brief, reused: false, source: "llm" };
}

// ── Cron scheduler — setInterval-based, per the existing FounderOS pattern ──

export interface DailyFounderBriefCronOptions {
  db: Db;
  tickIntervalMs?: number;
  /** Test hook for `now`. */
  clock?: () => Date;
  /** Test hook for the LLM call. */
  callAnthropic?: AnthropicJsonCaller;
  /** Test hook for the API key getter. */
  getAnthropicKey?: () => Promise<string | null>;
}

export interface DailyFounderBriefCron {
  start(): void;
  stop(): void;
  /** Run a single tick immediately — primarily for tests. */
  tick(): Promise<{ eligible: number; generated: number; skipped: number }>;
}

export function createDailyFounderBriefCron(
  opts: DailyFounderBriefCronOptions,
): DailyFounderBriefCron {
  const {
    db,
    tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
    clock = () => new Date(),
    callAnthropic,
    getAnthropicKey,
  } = opts;

  const log = logger.child({ service: "daily-founder-brief-cron" });
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let inFlight = false;

  async function tick(): Promise<{
    eligible: number;
    generated: number;
    skipped: number;
  }> {
    if (inFlight) {
      log.debug("skipping daily-founder-brief tick — previous still running");
      return { eligible: 0, generated: 0, skipped: 0 };
    }
    inFlight = true;
    const now = clock();

    let eligible = 0;
    let generated = 0;
    let skipped = 0;

    try {
      // Walk all active companies. We could pre-filter by the per-user
      // membership tz, but iterating companies + reading the workspace tz
      // per-company is bounded — the query is cheap and the fan-out
      // is naturally rate-limited by the 7am-local edge check.
      const companyRows = await db
        .select({ id: companies.id, status: companies.status })
        .from(companies)
        .where(eq(companies.status, "active"));

      if (companyRows.length === 0) {
        return { eligible: 0, generated: 0, skipped: 0 };
      }

      // Bulk-load the per-company workspace timezone in one round-trip.
      const companyIds = companyRows.map((c) => c.id);
      const memberships = await db
        .select({
          companyId: companyMemberships.companyId,
          tz: companyMemberships.digestTimezone,
        })
        .from(companyMemberships)
        .where(
          and(
            inArray(companyMemberships.companyId, companyIds),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.status, "active"),
          ),
        );
      const tzByCompany = new Map<string, string>();
      for (const m of memberships) {
        if (!tzByCompany.has(m.companyId)) {
          tzByCompany.set(m.companyId, m.tz || "UTC");
        }
      }

      for (const c of companyRows) {
        const tz = tzByCompany.get(c.id) ?? "UTC";
        const localHour = hourInTimezone(now, tz);
        if (localHour !== TARGET_HOUR_LOCAL) continue;

        eligible++;

        // forDate = today in the workspace tz.
        const forDateIso = isoDateInTimezone(now, tz);

        // Idempotency: skip if we already generated for this date. This is
        // a redundant cheap check on top of the unique index — saves the
        // aggregate-and-call work when the cron runs every 15 min.
        const existing = await findExistingBrief(db, c.id, forDateIso);
        if (existing) {
          skipped++;
          continue;
        }

        try {
          const result = await generateDailyBriefForCompany(db, c.id, {
            now,
            timezone: tz,
            forDate: forDateIso,
            callAnthropic,
            getAnthropicKey,
          });
          if (result.reused) {
            skipped++;
          } else {
            generated++;
            log.info(
              {
                companyId: c.id,
                forDate: forDateIso,
                source: result.source,
                fallbackReason: result.fallbackReason,
              },
              "daily-founder-brief: generated",
            );
          }
        } catch (err) {
          log.error(
            {
              companyId: c.id,
              forDate: forDateIso,
              err: err instanceof Error ? err.message : String(err),
            },
            "daily-founder-brief: generation threw",
          );
          skipped++;
        }
      }

      return { eligible, generated, skipped };
    } finally {
      inFlight = false;
    }
  }

  function start(): void {
    if (running) return;
    running = true;
    timer = setInterval(() => {
      void tick().catch((err) => {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "daily-founder-brief tick threw",
        );
      });
    }, tickIntervalMs);
    timer.unref?.();
    log.info({ tickIntervalMs }, "daily-founder-brief cron started");
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    running = false;
  }

  return { start, stop, tick };
}

// ── Re-export the date-util that tests use ──────────────────────────────────

export { isoDateInTimezone };
export { dateColAsIso };
