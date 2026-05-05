/**
 * channel-recommender.ts — Growth-agent channel recommendation engine (S3.8).
 *
 * For each company, aggregates the last 30 days of signups and attributes each
 * to a marketing channel using **last-touch** attribution within a 7-day
 * pre-signup window. When attributed signup volume between any two channels
 * differs by > 1.5× and both have > 30 signups, we surface a
 * `channel_recommendation` insight on the Growth department suggesting
 * reallocation toward the higher-performing channel.
 *
 * ── Inputs ────────────────────────────────────────────────────────────────
 * Two `events` row shapes are treated as signups:
 *
 *   1. Explicit signup events:
 *        entity_type='signup'  (any source)
 *        payload may include { channel: 'linkedin'|... } for direct attribution
 *
 *   2. PostHog identifies:
 *        event_name='$identify' (or 'identify' — handle both since
 *        posthog-poll normalizes the leading $ into entityType, leaving the raw
 *        event_name unchanged at '$identify')
 *
 * Channel-touch events are recognized by:
 *   payload.channel ∈ CHANNELS  (any source/event_name; this covers ad-network
 *   pixel events, manual CRM logs, content-engagement events, etc.)
 *
 * ── Attribution ───────────────────────────────────────────────────────────
 * For every signup, scan all channel-touch events for the same company that
 * occurred in the 7d window strictly BEFORE the signup. The most recent one
 * wins (last-touch). If none found, fall back to:
 *   (a) the signup's own payload.channel if present,
 *   (b) PostHog UTM (`payload.properties.$initial_utm_source` or
 *       `payload.properties.utm_source`) mapped to a CHANNELS bucket,
 *   (c) 'direct' as the terminal default.
 *
 * v1 limitation (documented in the body): we do NOT have spend/CAC data per
 * channel. The recommendation compares VOLUME only — useful as a starting
 * point but blind to economics. v2 plan: thread cost-per-channel rows in via
 * a new `entity_type='channel_spend'` event shape and switch the ratio to
 * (volume / spend). Multi-touch attribution (first-touch + linear) is also
 * v2 — flagged in the body comment so founders read recommendations with the
 * right caveats.
 *
 * ── Insight write contract ────────────────────────────────────────────────
 * One insight per run when a reallocation is suggested:
 *   department='growth', kind='channel_recommendation',
 *   confidence=0.7 normally, 0.4 when total signups < 30 (low-confidence),
 *   body = markdown table of per-channel volume + textual recommendation.
 *
 * Drizzle gotcha (per FounderOS invariants): chained `.where(a).where(b)`
 * REPLACES, not ANDs. This service uses `.where(and(...))` everywhere a
 * multi-clause filter is required. Verified by the test suite under embedded
 * Postgres (PGlite).
 */

import { and, eq, gte } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { events, insights } from "@founderos/db";

// ── Constants ────────────────────────────────────────────────────────────

/**
 * Marketing channels we attribute signups to. Anything not in this set is
 * collapsed into `direct` to avoid an open-ended bucket explosion.
 */
export const CHANNELS = [
  "linkedin",
  "meta",
  "google",
  "direct",
  "referral",
  "content",
] as const;

export type Channel = (typeof CHANNELS)[number];

/** Lookup window for last-touch attribution. */
const ATTRIBUTION_WINDOW_DAYS = 7;

/** Aggregation window for the recommendation. */
const RECOMMENDATION_WINDOW_DAYS = 30;

/**
 * Volume ratio that triggers a reallocation recommendation. Below this and
 * the channels are within noise; above it and the gap is meaningful enough
 * to act on.
 */
const RATIO_THRESHOLD = 1.5;

/** Each side of the ratio must clear this many signups before we recommend. */
const MIN_SIGNUPS_PER_CHANNEL = 30;

/** Total signups below this trigger the low-confidence flag. */
const LOW_CONFIDENCE_TOTAL = 30;

const CONFIDENCE_NORMAL = 0.7;
const CONFIDENCE_LOW = 0.4;

// ── Public API ───────────────────────────────────────────────────────────

export interface ChannelRecommenderResult {
  /** True when an insight row was written. */
  wrote: boolean;
  /** Per-channel attributed signup counts in the 30d window. */
  volumes: Record<Channel, number>;
  /** Total attributed signups. */
  totalSignups: number;
  /**
   * The recommendation, if any. `null` when total<30 (low-confidence prefix
   * still written), when no signups exist (no insight), or when no pair of
   * channels exceeded the 1.5× ratio with both above the 30-signup floor.
   */
  recommendation: { from: Channel; to: Channel; ratio: number } | null;
  /** True when total signups < LOW_CONFIDENCE_TOTAL (note: 0 → no insight). */
  lowConfidence: boolean;
}

/**
 * Run channel recommendation for a single company. Pure-ish: queries `events`,
 * possibly inserts one `insights` row, returns a structured summary for tests.
 *
 * Edge cases:
 *  - 0 signups → `wrote=false`, no DB write (silent skip).
 *  - <30 signups → write with `confidence=0.4`, body prefixed with the
 *    low-confidence warning.
 *  - No pair > 1.5× with both > 30 → `recommendation=null`, no DB write
 *    UNLESS we're in low-confidence mode (where we surface the data anyway
 *    so the founder sees the early signal).
 */
export async function recommendChannels(
  db: Db,
  companyId: string,
): Promise<ChannelRecommenderResult> {
  const now = new Date();
  const windowStart = new Date(
    now.getTime() - RECOMMENDATION_WINDOW_DAYS * 86_400_000,
  );

  // Pull 30d of relevant events for the company. We over-fetch (channel
  // touches AND signups in one sweep) so we can attribute in-memory rather
  // than issuing a per-signup correlated subquery — at the volumes we expect
  // (low thousands of events per company per month) this is cheaper.
  const rows = await db
    .select({
      entityType: events.entityType,
      eventName: events.eventName,
      occurredAt: events.occurredAt,
      payload: events.payload,
    })
    .from(events)
    .where(
      and(
        eq(events.companyId, companyId),
        gte(events.occurredAt, windowStart),
      ),
    );

  const signups: Array<{ occurredAt: Date; payload: unknown }> = [];
  const channelTouches: Array<{ occurredAt: Date; channel: Channel }> = [];

  for (const r of rows) {
    if (isSignupRow(r.entityType, r.eventName)) {
      signups.push({ occurredAt: r.occurredAt, payload: r.payload });
      // A signup row is NOT a channel touch — even if it carries
      // payload.channel for self-attribution, treating it as a touch would
      // cross-attribute earlier signups in *other* channels to *this*
      // signup's channel. Self-attribution still happens via the
      // extractChannelTouch(signup.payload) fallback inside attribute().
      continue;
    }
    const touch = extractChannelTouch(r.payload);
    if (touch) {
      channelTouches.push({ occurredAt: r.occurredAt, channel: touch });
    }
  }

  // Sort touches ascending by time so last-touch lookup is a simple
  // backward linear scan from the signup time. n*m is fine at our scale; if
  // this hot-path matters later, switch to a sorted array + binary search.
  channelTouches.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  const volumes: Record<Channel, number> = freshVolumeBuckets();

  for (const s of signups) {
    const channel = attribute(s, channelTouches);
    volumes[channel]++;
  }

  const totalSignups = signups.length;

  // Silent skip: nothing to recommend on, nothing to flag.
  if (totalSignups === 0) {
    return {
      wrote: false,
      volumes,
      totalSignups,
      recommendation: null,
      lowConfidence: false,
    };
  }

  const lowConfidence = totalSignups < LOW_CONFIDENCE_TOTAL;
  const recommendation = pickRecommendation(volumes);

  // No reallocation signal AND we have plenty of data → silent skip. There's
  // nothing actionable to surface and noise is worse than silence here.
  if (!recommendation && !lowConfidence) {
    return {
      wrote: false,
      volumes,
      totalSignups,
      recommendation: null,
      lowConfidence: false,
    };
  }

  await db.insert(insights).values({
    companyId,
    department: "growth",
    kind: "channel_recommendation",
    title: buildTitle(recommendation, lowConfidence),
    body: buildBody({ volumes, totalSignups, recommendation, lowConfidence }),
    confidence: lowConfidence ? CONFIDENCE_LOW : CONFIDENCE_NORMAL,
    recommendation: recommendation
      ? `Shift budget from ${recommendation.from} toward ${recommendation.to}.`
      : null,
    evidence: {
      windowDays: RECOMMENDATION_WINDOW_DAYS,
      attributionWindowDays: ATTRIBUTION_WINDOW_DAYS,
      attribution: "last-touch",
      volumes,
      totalSignups,
      ratioThreshold: RATIO_THRESHOLD,
      minSignupsPerChannel: MIN_SIGNUPS_PER_CHANNEL,
      recommendation,
    },
  });

  return {
    wrote: true,
    volumes,
    totalSignups,
    recommendation,
    lowConfidence,
  };
}

// ── Internals ────────────────────────────────────────────────────────────

function freshVolumeBuckets(): Record<Channel, number> {
  return {
    linkedin: 0,
    meta: 0,
    google: 0,
    direct: 0,
    referral: 0,
    content: 0,
  };
}

/**
 * `entity_type='signup'` (canonical) OR PostHog `$identify` (raw) OR
 * `identify` (normalized form some upstream emitters use).
 */
function isSignupRow(entityType: string, eventName: string): boolean {
  if (entityType === "signup") return true;
  if (eventName === "$identify" || eventName === "identify") return true;
  return false;
}

/**
 * Read a channel name out of an event payload. We accept either:
 *   payload.channel              — the canonical channel-touch field
 *   payload.properties.utm_source / $initial_utm_source — PostHog UTM passthrough
 *
 * Returns `null` if the value isn't recognized as one of CHANNELS.
 */
function extractChannelTouch(payload: unknown): Channel | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  const direct = obj["channel"];
  if (typeof direct === "string") {
    const c = normalizeChannel(direct);
    if (c) return c;
  }
  const props = obj["properties"];
  if (props && typeof props === "object" && !Array.isArray(props)) {
    const p = props as Record<string, unknown>;
    const utm =
      (typeof p["utm_source"] === "string" ? (p["utm_source"] as string) : null) ??
      (typeof p["$initial_utm_source"] === "string"
        ? (p["$initial_utm_source"] as string)
        : null);
    if (utm) {
      const c = normalizeChannel(utm);
      if (c) return c;
    }
  }
  return null;
}

/**
 * Map a free-form string to one of CHANNELS. Aliases handle common UTM
 * patterns (e.g. `facebook`, `fb`, `instagram` → `meta`). Unknown sources
 * become `null` (caller decides whether to bucket them as `direct`).
 */
function normalizeChannel(raw: string): Channel | null {
  const v = raw.trim().toLowerCase();
  if (v === "") return null;
  if ((CHANNELS as readonly string[]).includes(v)) return v as Channel;
  if (v === "facebook" || v === "fb" || v === "instagram" || v === "ig") {
    return "meta";
  }
  if (v === "google_ads" || v === "googleads" || v === "adwords") {
    return "google";
  }
  if (v === "linkedin_ads" || v === "li") return "linkedin";
  if (v === "blog" || v === "newsletter") return "content";
  if (v === "ref" || v === "word-of-mouth") return "referral";
  return null;
}

/**
 * Last-touch attribution. Walk backwards through channel-touches up to 7d
 * before the signup; first hit wins. If no touch found, fall back to the
 * signup's own payload (covers ad-network landing pages where the signup
 * row carries the channel directly), then to `direct`.
 */
function attribute(
  signup: { occurredAt: Date; payload: unknown },
  touches: Array<{ occurredAt: Date; channel: Channel }>,
): Channel {
  const signupTime = signup.occurredAt.getTime();
  const windowFloor = signupTime - ATTRIBUTION_WINDOW_DAYS * 86_400_000;

  // Touches are sorted ascending — scan from the end for the most recent
  // strictly-before signup time within the 7d window.
  for (let i = touches.length - 1; i >= 0; i--) {
    const t = touches[i]!;
    const ts = t.occurredAt.getTime();
    if (ts >= signupTime) continue;
    if (ts < windowFloor) break;
    return t.channel;
  }

  const fromPayload = extractChannelTouch(signup.payload);
  if (fromPayload) return fromPayload;
  return "direct";
}

/**
 * Pick the largest channel and the largest qualified channel below it,
 * test the ratio. Returns `null` if no qualified pair exceeds the threshold.
 *
 * Both sides MUST clear MIN_SIGNUPS_PER_CHANNEL — comparing 60 vs 5 is a
 * bait recommendation when the smaller channel just hasn't been spent on.
 */
function pickRecommendation(
  volumes: Record<Channel, number>,
): { from: Channel; to: Channel; ratio: number } | null {
  const ranked = (Object.keys(volumes) as Channel[])
    .map((c) => ({ channel: c, volume: volumes[c] }))
    .filter((x) => x.volume >= MIN_SIGNUPS_PER_CHANNEL)
    .sort((a, b) => b.volume - a.volume);

  if (ranked.length < 2) return null;

  const top = ranked[0]!;
  // Compare against the *smallest* qualified channel — biggest delta, most
  // actionable recommendation. (Compared to "next biggest", this surfaces
  // a clearer signal when there's a long tail of mid-sized channels.)
  const bottom = ranked[ranked.length - 1]!;
  const ratio = top.volume / bottom.volume;
  if (ratio > RATIO_THRESHOLD) {
    return { from: bottom.channel, to: top.channel, ratio };
  }
  return null;
}

function buildTitle(
  rec: { from: Channel; to: Channel; ratio: number } | null,
  lowConfidence: boolean,
): string {
  if (lowConfidence) return "Channel mix (early read)";
  if (rec) {
    return `Double down on ${rec.to} (${rec.ratio.toFixed(1)}× ${rec.from})`;
  }
  return "Channel mix balanced";
}

function buildBody(args: {
  volumes: Record<Channel, number>;
  totalSignups: number;
  recommendation: { from: Channel; to: Channel; ratio: number } | null;
  lowConfidence: boolean;
}): string {
  const lines: string[] = [];
  if (args.lowConfidence) {
    lines.push(
      `low-confidence — not enough data yet (only ${args.totalSignups} signups in the last ${RECOMMENDATION_WINDOW_DAYS} days; threshold is ${LOW_CONFIDENCE_TOTAL}).`,
    );
    lines.push("");
  }

  lines.push(
    `Channel volume over the last ${RECOMMENDATION_WINDOW_DAYS} days, attributed via last-touch within a ${ATTRIBUTION_WINDOW_DAYS}-day window:`,
  );
  lines.push("");
  lines.push("| Channel | Signups | Share |");
  lines.push("| --- | ---: | ---: |");
  const ranked = (Object.keys(args.volumes) as Channel[])
    .map((c) => ({ channel: c, volume: args.volumes[c] }))
    .sort((a, b) => b.volume - a.volume);
  for (const r of ranked) {
    const share =
      args.totalSignups === 0
        ? "0.0%"
        : `${((r.volume / args.totalSignups) * 100).toFixed(1)}%`;
    lines.push(`| ${r.channel} | ${r.volume} | ${share} |`);
  }
  lines.push("");

  if (args.recommendation) {
    lines.push(
      `**Recommendation.** ${args.recommendation.to} is generating ${args.recommendation.ratio.toFixed(2)}× the signup volume of ${args.recommendation.from}. Shift incremental spend from ${args.recommendation.from} toward ${args.recommendation.to} for the next two weeks and re-evaluate.`,
    );
  } else if (!args.lowConfidence) {
    lines.push(
      "**Recommendation.** No channel pair exceeds the 1.5× volume ratio with > 30 signups each — channel mix is balanced.",
    );
  }

  lines.push("");
  lines.push(
    "_v1 caveat: comparison is by VOLUME only; channel spend / CAC is not yet wired in. v2 will add cost-per-channel and switch the ratio to (volume / spend). Multi-touch attribution (first-touch + linear) is also v2 — current logic is last-touch only._",
  );

  return lines.join("\n");
}
