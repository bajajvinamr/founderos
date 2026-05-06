/**
 * attribution.ts — LinkedIn growth attribution insight (S3.9).
 *
 * THE DEMO LINE: "Your LinkedIn founder content drove 32% of signups."
 *
 * Cross-references PostHog signup events against LinkedIn post activity over
 * the last 30 days, using two complementary signals:
 *
 *   1) UTM-based attribution (preferred, confidence=0.9):
 *      A signup whose `payload.properties.$initial_utm_source = 'linkedin'`
 *      OR whose `payload.properties.$initial_utm_medium` contains 'linkedin'
 *      is attributed to LinkedIn unconditionally — the founder's content
 *      tagged the link, the user clicked through, the click is durable.
 *
 *   2) Time-correlation fallback (used when UTM is absent, confidence=0.6):
 *      For signups with no LinkedIn UTM, we look back 7 days for any
 *      LinkedIn post by the company AND any LinkedIn click event by the
 *      same `distinctId`. Both must be present — a post with no click is
 *      not attribution; a click with no post is not founder content. We
 *      additionally require that at least one LinkedIn post exists in the
 *      lookback window so the signal is grounded in real founder activity.
 *
 *   3) Sample-size guard (confidence=0.4 floor):
 *      With < 30 total signups in the window, attribution percentages are
 *      noisy. We still emit the insight (founders need to see the signal
 *      forming) but flag low confidence and append a "(low sample: N)"
 *      note to the body so the UI can present it as preliminary.
 *
 * Skip silently:
 *   - No LinkedIn integration connected — defined as zero `source='linkedin'`
 *     events (any entity_type) over the 30d window. No insight is written;
 *     the agent is a no-op for unconfigured workspaces.
 *
 * Drizzle gotchas guarded for here:
 *   - `.where(a).where(b)` REPLACES the first clause — every multi-clause
 *     filter uses `and(...)`.
 *   - JSON path lookups (`payload->'properties'->>'$initial_utm_source'`) are
 *     written as raw `sql\`\`` template literals inside a single `and(...)`
 *     so Drizzle does not flatten or re-parse them.
 *
 * Insight write contract:
 *   department='growth', kind='attribution', confidence per the rules above.
 *   Body ends with "over last 30d" so the daily-brief LLM picks it up
 *   verbatim as a quotable sentence.
 *
 * Idempotency:
 *   The agent is invoked at most a few times per day (cron + manual). We
 *   suppress writes when an open `attribution` insight for this company in
 *   the last 24h already exists — the same dedup pattern used by the KPI
 *   anomaly job (S3.2). Re-emission only happens after the dedup window
 *   closes OR the prior insight was acted on / dismissed.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { events, insights } from "@founderos/db";
import { logger } from "../../middleware/logger.js";

// ── Constants ────────────────────────────────────────────────────────────

/** Lookback window for both LinkedIn posts and PostHog signups. */
const WINDOW_DAYS = 30;

/** Time-correlation lookback (LinkedIn click → signup). */
const CORRELATION_WINDOW_DAYS = 7;

/** Below this signup count we still emit but flag low confidence. */
const LOW_SAMPLE_THRESHOLD = 30;

const CONFIDENCE_UTM = 0.9;
const CONFIDENCE_TIME_CORRELATION = 0.6;
const CONFIDENCE_LOW_SAMPLE = 0.4;

/** PostHog signup event names (per ticket spec). */
const SIGNUP_EVENTS = ["signup", "identify"] as const;

// ── Public types ─────────────────────────────────────────────────────────

export interface AttributionResult {
  /** Whether an insight row was written this invocation. */
  emitted: boolean;
  /** Why the agent was skipped (when emitted=false). */
  skipReason?:
    | "no_linkedin_integration"
    | "no_signups"
    | "deduped_within_24h";
  /** Total signups observed in the 30d window. */
  totalSignups: number;
  /** Signups attributed via UTM tags. */
  utmAttributed: number;
  /** Signups attributed via time-correlation (mutually exclusive with UTM). */
  timeCorrelated: number;
  /** Combined attribution % rounded to nearest integer. */
  attributionPct: number;
  /** Confidence assigned to the insight row (matches schema's [0,1]). */
  confidence: number;
}

// ── Public entrypoint ────────────────────────────────────────────────────

/**
 * Run LinkedIn attribution analysis for a single company. Idempotent within
 * a 24h window — re-running while an `attribution` insight is open is a
 * no-op (returns `{ emitted: false, skipReason: 'deduped_within_24h' }`).
 *
 * Errors propagate — caller (cron tick, daily brief refresh) is expected to
 * catch and continue past per-company failures so one bad workspace cannot
 * starve the cycle.
 */
export async function runLinkedInAttribution(
  db: Db,
  companyId: string,
): Promise<AttributionResult> {
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000);

  // ── (a) Skip silently if no LinkedIn integration ──────────────────────
  const linkedinSignal = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(events)
    .where(
      and(
        eq(events.companyId, companyId),
        eq(events.source, "linkedin"),
        gte(events.occurredAt, cutoff),
      ),
    );

  const linkedinCount = Number(linkedinSignal[0]?.count ?? 0);
  if (linkedinCount === 0) {
    return {
      emitted: false,
      skipReason: "no_linkedin_integration",
      totalSignups: 0,
      utmAttributed: 0,
      timeCorrelated: 0,
      attributionPct: 0,
      confidence: 0,
    };
  }

  // ── (b) Pull all signup events in the window ──────────────────────────
  // Note: chained `.where()` REPLACES — must use and(...) for the OR-shaped
  // event_name predicate. The IN clause is a raw sql template because
  // Drizzle's helpers don't compose well with a string-array of literals
  // alongside the JSON path filters below.
  const signupRows = await db
    .select({
      id: events.id,
      occurredAt: events.occurredAt,
      payload: events.payload,
    })
    .from(events)
    .where(
      and(
        eq(events.companyId, companyId),
        eq(events.source, "posthog"),
        sql`${events.eventName} IN ('signup', 'identify')`,
        gte(events.occurredAt, cutoff),
      ),
    );

  const totalSignups = signupRows.length;

  if (totalSignups === 0) {
    return {
      emitted: false,
      skipReason: "no_signups",
      totalSignups: 0,
      utmAttributed: 0,
      timeCorrelated: 0,
      attributionPct: 0,
      confidence: 0,
    };
  }

  // ── (c) Compute UTM-based attribution ─────────────────────────────────
  // Split signup rows into UTM-attributed vs not. We iterate in JS rather
  // than a SQL aggregation because the time-correlation fallback in (d)
  // needs the same per-signup detail (distinctId + occurredAt) and a
  // single pass over the rows is cleaner than two separate queries.
  const utmAttributedUserIds = new Set<string>();
  const nonUtmSignups: Array<{ distinctId: string | null; occurredAt: Date }> = [];

  for (const row of signupRows) {
    const props = extractProperties(row.payload);
    const distinctId = extractDistinctId(row.payload);

    const utmSource = props["$initial_utm_source"];
    const utmMedium = props["$initial_utm_medium"];

    const utmHit =
      (typeof utmSource === "string" &&
        utmSource.toLowerCase() === "linkedin") ||
      (typeof utmMedium === "string" &&
        utmMedium.toLowerCase().includes("linkedin"));

    if (utmHit) {
      // De-dup by user when distinctId present; fall back to event id when
      // it's missing so multiple anonymous signups still get counted once
      // each (no false-positive double counting from a single user).
      utmAttributedUserIds.add(distinctId ?? `event:${row.id}`);
    } else {
      nonUtmSignups.push({ distinctId, occurredAt: row.occurredAt });
    }
  }

  const utmAttributed = utmAttributedUserIds.size;

  // ── (d) Time-correlation fallback for non-UTM signups ─────────────────
  // For each non-UTM signup with a distinctId, look back 7d for a LinkedIn
  // click event by the same distinctId. We require at least one LinkedIn
  // post in the same window so the signal is grounded in founder activity
  // and not a stale "linkedin click" from before any post existed.
  const correlationCutoff = new Date(
    Date.now() - CORRELATION_WINDOW_DAYS * 86_400_000,
  );

  // Pre-pull LinkedIn clicks once and bucket by distinctId for O(N) lookup.
  const clickRows = await db
    .select({
      occurredAt: events.occurredAt,
      payload: events.payload,
    })
    .from(events)
    .where(
      and(
        eq(events.companyId, companyId),
        eq(events.source, "linkedin"),
        eq(events.eventName, "click"),
        gte(events.occurredAt, correlationCutoff),
      ),
    );

  const clicksByDistinctId = new Map<string, Date[]>();
  for (const click of clickRows) {
    const did = extractDistinctId(click.payload);
    if (!did) continue;
    const list = clicksByDistinctId.get(did);
    if (list) list.push(click.occurredAt);
    else clicksByDistinctId.set(did, [click.occurredAt]);
  }

  // Confirm at least one LinkedIn POST exists in the correlation window.
  const recentPostRows = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.companyId, companyId),
        eq(events.source, "linkedin"),
        eq(events.entityType, "post"),
        gte(events.occurredAt, correlationCutoff),
      ),
    )
    .limit(1);

  const hasRecentPost = recentPostRows.length > 0;

  const timeCorrelatedUserIds = new Set<string>();
  if (hasRecentPost && clicksByDistinctId.size > 0) {
    for (const sup of nonUtmSignups) {
      if (!sup.distinctId) continue;
      // Skip users we already counted via UTM — deduplication.
      if (utmAttributedUserIds.has(sup.distinctId)) continue;
      const userClicks = clicksByDistinctId.get(sup.distinctId);
      if (!userClicks) continue;
      // Any click within the 7d lookback ending at the signup time counts.
      const signupTime = sup.occurredAt.getTime();
      const earliestAllowed = signupTime - CORRELATION_WINDOW_DAYS * 86_400_000;
      const matched = userClicks.some((c) => {
        const ct = c.getTime();
        return ct <= signupTime && ct >= earliestAllowed;
      });
      if (matched) timeCorrelatedUserIds.add(sup.distinctId);
    }
  }

  const timeCorrelated = timeCorrelatedUserIds.size;
  const totalAttributed = utmAttributed + timeCorrelated;
  const attributionPct =
    totalSignups > 0 ? Math.round((totalAttributed / totalSignups) * 100) : 0;

  // ── (e) Pick confidence ───────────────────────────────────────────────
  // Sample-size guard takes precedence — a small denominator makes any
  // percentage noisy regardless of which signal type produced it.
  let confidence: number;
  if (totalSignups < LOW_SAMPLE_THRESHOLD) {
    confidence = CONFIDENCE_LOW_SAMPLE;
  } else if (utmAttributed >= timeCorrelated) {
    // UTM dominates → high confidence; the click→signup link is durable.
    confidence = CONFIDENCE_UTM;
  } else {
    // Mostly time-correlation → mid confidence; correlation is not causation.
    confidence = CONFIDENCE_TIME_CORRELATION;
  }

  // ── (f) Dedup within 24h ──────────────────────────────────────────────
  // Same JSONB-aware pattern used by the KPI anomaly job. The JSON path
  // (->'attribution_kind'->>'...') is written via raw sql to avoid Drizzle
  // .where() chain replacement.
  const dedupResult = await db.execute(sql`
    SELECT 1 FROM "insights"
    WHERE "company_id" = ${companyId}
      AND "kind" = 'attribution'
      AND "department" = 'growth'
      AND "status" = 'open'
      AND "created_at" > now() - interval '24 hours'
    LIMIT 1
  `);
  const matched =
    Array.isArray(dedupResult)
      ? dedupResult.length > 0
      : Array.isArray((dedupResult as { rows?: unknown[] }).rows) &&
        (dedupResult as { rows: unknown[] }).rows.length > 0;
  if (matched) {
    return {
      emitted: false,
      skipReason: "deduped_within_24h",
      totalSignups,
      utmAttributed,
      timeCorrelated,
      attributionPct,
      confidence,
    };
  }

  // ── (g) Write the insight ─────────────────────────────────────────────
  const lowSampleSuffix =
    totalSignups < LOW_SAMPLE_THRESHOLD
      ? ` (low sample: ${totalSignups} signups)`
      : "";
  const body =
    `${attributionPct}% of signups attributed to LinkedIn founder content ` +
    `over last 30d${lowSampleSuffix}`;
  const title = `LinkedIn drove ${attributionPct}% of signups (last 30d)`;

  await db.insert(insights).values({
    companyId,
    department: "growth",
    kind: "attribution",
    title,
    body,
    confidence,
    evidence: {
      window_days: WINDOW_DAYS,
      total_signups: totalSignups,
      utm_attributed: utmAttributed,
      time_correlated: timeCorrelated,
      attribution_pct: attributionPct,
      attribution_kind:
        utmAttributed >= timeCorrelated ? "utm" : "time_correlation",
      low_sample: totalSignups < LOW_SAMPLE_THRESHOLD,
    },
  });

  logger.info(
    {
      companyId,
      totalSignups,
      utmAttributed,
      timeCorrelated,
      attributionPct,
      confidence,
    },
    "linkedin-attribution: insight emitted",
  );

  return {
    emitted: true,
    totalSignups,
    utmAttributed,
    timeCorrelated,
    attributionPct,
    confidence,
  };
}

// ── Payload helpers ──────────────────────────────────────────────────────

/**
 * Read `payload.properties` defensively — PostHog ingest writes it but raw
 * SQL inserts in tests or future ingest paths may not. Always returns an
 * object so callers can index without an `?? {}` at every site.
 */
function extractProperties(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const obj = payload as Record<string, unknown>;
  const props = obj["properties"];
  if (!props || typeof props !== "object" || Array.isArray(props)) {
    return {};
  }
  return props as Record<string, unknown>;
}

/**
 * Read `payload.distinctId` (PostHog ingest path) or `payload.distinct_id`
 * (raw PostHog REST shape). Returns null when absent or not a string.
 */
function extractDistinctId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  const a = obj["distinctId"];
  if (typeof a === "string" && a.length > 0) return a;
  const b = obj["distinct_id"];
  if (typeof b === "string" && b.length > 0) return b;
  return null;
}
