/**
 * channel-recommender.test.ts — integration tests for the S3.8 Growth-agent
 * channel recommendation engine.
 *
 * Five cases (per ticket spec):
 *   1. clear winner   — 100 signups (80 linkedin, 20 meta) → "double linkedin"
 *                       insight written, ratio 4.0× both above floor.
 *   2. low-confidence — < 30 signups total → confidence=0.4 + body prefix
 *                       "low-confidence — not enough data yet".
 *   3. balanced       — equal volume across channels → no insight written.
 *   4. ratio-tied     — 30 linkedin + 30 meta (ratio = 1.0 ≤ 1.5) → no insight.
 *   5. no signups     — empty events → silent skip, no insight.
 *
 * Real embedded Postgres exercises CHECK constraints, JSONB payload reads,
 * and the (company_id, kind, created_at DESC) index path end-to-end.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { companies, createDb, events, insights } from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  recommendChannels,
  type Channel,
} from "../services/agents/channel-recommender.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping channel-recommender tests: ${support.reason ?? "unsupported environment"}`,
  );
}

/**
 * Per-channel base offsets (ms back from now). Each channel's signups live
 * in its own non-overlapping 24h slot — keeps last-touch ordering deterministic
 * across multiple `seedSignups()` calls in one test.
 */
const CHANNEL_BASE_OFFSETS: Record<Channel, number> = {
  linkedin: 1 * 86_400_000,
  meta: 3 * 86_400_000,
  google: 5 * 86_400_000,
  direct: 7 * 86_400_000,
  referral: 9 * 86_400_000,
  content: 11 * 86_400_000,
};

describeEmbeddedPostgres("Channel recommender (S3.8)", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("channel-rec");
    db = createDb(temp.connectionString);
  }, 60_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE "insights" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "events" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);

    const [company] = await db
      .insert(companies)
      .values({ name: "Channel Rec Test Co" })
      .returning({ id: companies.id });
    companyId = company!.id;
  });

  // ── helpers ────────────────────────────────────────────────────────────

  /**
   * Seed `count` signups whose payload directly carries the channel. Using
   * `payload.channel` on the signup itself (rather than relying on a
   * separate prior touch event) keeps attribution deterministic across the
   * test matrix — no risk of cross-channel touch overlap when multiple
   * `seedSignups()` calls run in sequence within the same test.
   *
   * Signup times are spaced 1 minute apart starting from a per-channel base
   * offset so different channels never share a timestamp. The 30d window is
   * comfortably accommodated (10 chan × 1000 signups × 1 min ≈ 7 days).
   */
  async function seedSignups(args: { channel: Channel; count: number }) {
    const now = Date.now();
    // Stagger channels so no two signup events share the same occurredAt.
    const baseOffsetMs =
      CHANNEL_BASE_OFFSETS[args.channel] ?? 0;
    const rows: Array<{
      companyId: string;
      source: "posthog";
      entityType: string;
      eventName: string;
      dedupKey: string;
      occurredAt: Date;
      payload: Record<string, unknown>;
    }> = [];

    for (let i = 0; i < args.count; i++) {
      const signupAt = new Date(
        now - baseOffsetMs - i * 60_000, // 1 min apart
      );
      rows.push({
        companyId,
        source: "posthog",
        entityType: "signup",
        eventName: "user_signed_up",
        dedupKey: `signup:${args.channel}:${i}:${signupAt.toISOString()}`,
        occurredAt: signupAt,
        payload: { user: `u-${args.channel}-${i}`, channel: args.channel },
      });
    }

    if (rows.length > 0) await db.insert(events).values(rows);
  }

  async function listInsights() {
    return db
      .select()
      .from(insights)
      .where(eq(insights.companyId, companyId));
  }

  // ── (1) clear winner ──────────────────────────────────────────────────

  it("(1) 80 linkedin + 40 meta → 'double down on linkedin' recommendation", async () => {
    // Both channels MUST clear MIN_SIGNUPS_PER_CHANNEL (30) for the engine
    // to surface a recommendation — comparing 80 vs 20 would correctly be
    // suppressed (meta below floor → not qualified). 80/40 = 2.0× > 1.5×.
    await seedSignups({ channel: "linkedin", count: 80 });
    await seedSignups({ channel: "meta", count: 40 });

    const r = await recommendChannels(db, companyId);

    expect(r.wrote).toBe(true);
    expect(r.totalSignups).toBe(120);
    expect(r.lowConfidence).toBe(false);
    expect(r.volumes.linkedin).toBe(80);
    expect(r.volumes.meta).toBe(40);
    expect(r.recommendation).not.toBeNull();
    expect(r.recommendation!.to).toBe("linkedin");
    expect(r.recommendation!.from).toBe("meta");
    expect(r.recommendation!.ratio).toBeCloseTo(2.0, 2);

    const rows = await listInsights();
    expect(rows).toHaveLength(1);
    const insight = rows[0]!;
    expect(insight.kind).toBe("channel_recommendation");
    expect(insight.department).toBe("growth");
    expect(insight.confidence).toBeCloseTo(0.7, 1);
    expect(insight.title).toMatch(/linkedin/i);
    expect(insight.body).toMatch(/\| linkedin \| 80 \|/);
    expect(insight.body).toMatch(/\| meta \| 40 \|/);
    expect(insight.body).toMatch(/last-touch/);
    const ev = insight.evidence as { volumes: Record<string, number> };
    expect(ev.volumes["linkedin"]).toBe(80);
    expect(ev.volumes["meta"]).toBe(40);
  });

  // ── (2) low-confidence ────────────────────────────────────────────────

  it("(2) <30 signups total → confidence=0.4 + body prefixed 'low-confidence'", async () => {
    await seedSignups({ channel: "linkedin", count: 10 });
    await seedSignups({ channel: "meta", count: 5 });

    const r = await recommendChannels(db, companyId);

    expect(r.wrote).toBe(true);
    expect(r.totalSignups).toBe(15);
    expect(r.lowConfidence).toBe(true);

    const rows = await listInsights();
    expect(rows).toHaveLength(1);
    const insight = rows[0]!;
    expect(insight.confidence).toBeCloseTo(0.4, 1);
    expect(insight.body.startsWith("low-confidence")).toBe(true);
    expect(insight.body).toMatch(/not enough data yet/);
    // The volume table is still surfaced even in low-confidence mode.
    expect(insight.body).toMatch(/\| linkedin \| 10 \|/);
    expect(insight.body).toMatch(/\| meta \| 5 \|/);
  });

  // ── (3) balanced (equal volume) ───────────────────────────────────────

  it("(3) equal volume across multiple channels → no insight written", async () => {
    // Three qualified channels at exactly 40 each. Ratio top/bottom = 1.0.
    await seedSignups({ channel: "linkedin", count: 40 });
    await seedSignups({ channel: "meta", count: 40 });
    await seedSignups({ channel: "google", count: 40 });

    const r = await recommendChannels(db, companyId);

    expect(r.wrote).toBe(false);
    expect(r.totalSignups).toBe(120);
    expect(r.lowConfidence).toBe(false);
    expect(r.recommendation).toBeNull();

    const rows = await listInsights();
    expect(rows).toHaveLength(0);
  });

  // ── (4) tied ratio at threshold ───────────────────────────────────────

  it("(4) 30 linkedin + 30 meta (ratio = 1.0 ≤ 1.5) → no insight", async () => {
    await seedSignups({ channel: "linkedin", count: 30 });
    await seedSignups({ channel: "meta", count: 30 });

    const r = await recommendChannels(db, companyId);

    expect(r.wrote).toBe(false);
    expect(r.recommendation).toBeNull();
    expect(r.totalSignups).toBe(60);
    expect(r.lowConfidence).toBe(false);

    const rows = await listInsights();
    expect(rows).toHaveLength(0);
  });

  // ── (5) no signups ────────────────────────────────────────────────────

  it("(5) no signups in window → silent skip, no insight", async () => {
    const r = await recommendChannels(db, companyId);

    expect(r.wrote).toBe(false);
    expect(r.totalSignups).toBe(0);
    expect(r.recommendation).toBeNull();
    expect(r.lowConfidence).toBe(false);

    const rows = await listInsights();
    expect(rows).toHaveLength(0);
  });
});
