/**
 * attribution.test.ts — integration tests for the LinkedIn growth
 * attribution agent (S3.9). THE DEMO LINE:
 *   "Your LinkedIn founder content drove 32% of signups."
 *
 * Cases (per ticket spec):
 *   1. UTM-only: 50 signups + 16 with linkedin UTM → 32% insight, conf=0.9
 *   2. No LinkedIn integration → no insight (silent skip)
 *   3. Small sample: 10 signups → low-confidence flag (conf=0.4) + body note
 *   4. Mixed UTM + time-correlation → math correct, no double counting
 *
 * Real embedded Postgres exercises CHECK constraints on insights enums and
 * the JSONB-aware dedup query path. We seed events directly via Drizzle
 * (no production ingest) — `initEventIngest` is unnecessary for this test.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { companies, createDb, events, insights } from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runLinkedInAttribution } from "../services/agents/attribution.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping attribution tests: ${support.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("LinkedIn growth attribution agent (S3.9)", () => {
  let db!: ReturnType<typeof createDb>;
  let temp:
    | Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>
    | null = null;
  let companyId!: string;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("founderos-attribution-");
    db = createDb(temp.connectionString);
  }, 60_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  beforeEach(async () => {
    // Wipe ledger tables. companies → insights/events cascade.
    await db.execute(sql`TRUNCATE TABLE "insights" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "events" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);

    const [company] = await db
      .insert(companies)
      .values({ name: "Attribution Test Co" })
      .returning({ id: companies.id });
    companyId = company!.id;
  });

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * Insert N PostHog signup events. `utmCount` of them get a linkedin UTM
   * source. `timeCorrelatedCount` get distinctIds matching pre-seeded
   * LinkedIn click events (callers seed those separately).
   */
  async function seedSignups(args: {
    total: number;
    utmCount: number;
    distinctIdPrefix?: string;
  }) {
    const prefix = args.distinctIdPrefix ?? "user";
    const now = Date.now();
    const rows = [] as Array<typeof events.$inferInsert>;
    for (let i = 0; i < args.total; i++) {
      const isUtm = i < args.utmCount;
      const occurredAt = new Date(now - i * 60_000); // staggered minutes
      rows.push({
        companyId,
        source: "posthog",
        entityType: "event",
        eventName: i % 2 === 0 ? "signup" : "identify",
        dedupKey: `attr-test:signup:${i}`,
        occurredAt,
        payload: {
          distinctId: `${prefix}-${i}`,
          properties: isUtm
            ? {
                $initial_utm_source: "linkedin",
                $initial_utm_medium: "social",
              }
            : {},
        },
      });
    }
    if (rows.length > 0) await db.insert(events).values(rows);
  }

  /** Seed a single LinkedIn post within the correlation window. */
  async function seedLinkedInPost(daysAgo = 3) {
    const occurredAt = new Date(Date.now() - daysAgo * 86_400_000);
    await db.insert(events).values({
      companyId,
      source: "linkedin",
      entityType: "post",
      eventName: "post.metrics_snapshot",
      dedupKey: `attr-test:post:${daysAgo}`,
      occurredAt,
      payload: { postId: `post-${daysAgo}`, metrics: { impressionCount: 100 } },
    });
  }

  /** Seed LinkedIn click events tied to specific distinctIds. */
  async function seedLinkedInClicks(distinctIds: string[], daysAgo = 1) {
    const occurredAt = new Date(Date.now() - daysAgo * 86_400_000);
    const rows = distinctIds.map((did, i) => ({
      companyId,
      source: "linkedin" as const,
      entityType: "click",
      eventName: "click",
      dedupKey: `attr-test:click:${did}:${i}`,
      occurredAt,
      payload: { distinctId: did, postId: `post-${i}` },
    }));
    if (rows.length > 0) await db.insert(events).values(rows);
  }

  async function listInsights() {
    return db
      .select()
      .from(insights)
      .where(eq(insights.companyId, companyId));
  }

  // ── (1) UTM-only: 50 signups, 16 LinkedIn UTM → 32% ─────────────────────

  it("(1) 50 signups + 16 LinkedIn UTM tags → insight body says '32%'", async () => {
    await seedLinkedInPost();
    await seedSignups({ total: 50, utmCount: 16 });

    const r = await runLinkedInAttribution(db, companyId);

    expect(r.emitted).toBe(true);
    expect(r.totalSignups).toBe(50);
    expect(r.utmAttributed).toBe(16);
    expect(r.attributionPct).toBe(32);
    expect(r.confidence).toBe(0.9);

    const rows = await listInsights();
    expect(rows).toHaveLength(1);
    const insight = rows[0]!;
    expect(insight.kind).toBe("attribution");
    expect(insight.department).toBe("growth");
    expect(insight.body).toContain("32%");
    expect(insight.body).toContain("over last 30d");
    expect(insight.title).toContain("32%");
    const evidence = insight.evidence as Record<string, unknown>;
    expect(evidence["attribution_pct"]).toBe(32);
    expect(evidence["utm_attributed"]).toBe(16);
    expect(evidence["total_signups"]).toBe(50);
    expect(evidence["attribution_kind"]).toBe("utm");
  });

  // ── (2) No LinkedIn integration → no insight, silent skip ───────────────

  it("(2) workspace with no LinkedIn events → no insight written", async () => {
    // Seed signups but ZERO LinkedIn events at all (no posts, no clicks).
    await seedSignups({ total: 50, utmCount: 16 });

    const r = await runLinkedInAttribution(db, companyId);

    expect(r.emitted).toBe(false);
    expect(r.skipReason).toBe("no_linkedin_integration");
    const rows = await listInsights();
    expect(rows).toHaveLength(0);
  });

  // ── (3) Small sample: 10 signups → low-confidence flag ──────────────────

  it("(3) 10 signups (small sample) → confidence=0.4 + low-sample note in body", async () => {
    await seedLinkedInPost();
    // 3 of 10 = 30%. Low-sample flag should fire because n=10 < 30.
    await seedSignups({ total: 10, utmCount: 3 });

    const r = await runLinkedInAttribution(db, companyId);

    expect(r.emitted).toBe(true);
    expect(r.totalSignups).toBe(10);
    expect(r.confidence).toBe(0.4);
    expect(r.attributionPct).toBe(30);

    const rows = await listInsights();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toMatch(/low sample/i);
    expect(rows[0]!.body).toContain("10");
    expect(rows[0]!.confidence).toBeCloseTo(0.4, 5);
    const evidence = rows[0]!.evidence as Record<string, unknown>;
    expect(evidence["low_sample"]).toBe(true);
  });

  // ── (4) Mixed UTM + time-correlation, no double counting ────────────────

  it("(4) mixed UTM + time-correlation → counts both signal types, dedupes by user", async () => {
    await seedLinkedInPost();

    // 50 total signups. First 10 get linkedin UTM. Next 5 get NO UTM but
    // their distinctIds will match LinkedIn click events. Plus, one of the
    // UTM users ALSO has a click — verify dedup (counted once via UTM).
    await seedSignups({
      total: 50,
      utmCount: 10,
      distinctIdPrefix: "user",
    });

    // Click events for users 9 (in UTM bucket — should be deduped) and
    // 10..14 (in non-UTM bucket — should be time-correlated).
    await seedLinkedInClicks(
      ["user-9", "user-10", "user-11", "user-12", "user-13", "user-14"],
      1,
    );

    const r = await runLinkedInAttribution(db, companyId);

    expect(r.emitted).toBe(true);
    expect(r.totalSignups).toBe(50);
    // UTM bucket = 10 (users 0..9).
    expect(r.utmAttributed).toBe(10);
    // Time-correlation bucket = 5 (users 10..14). user-9 already counted
    // via UTM, must NOT be double-counted here.
    expect(r.timeCorrelated).toBe(5);
    // Combined = 15 / 50 = 30%.
    expect(r.attributionPct).toBe(30);
    // UTM (10) >= time-correlated (5) → high confidence path.
    expect(r.confidence).toBe(0.9);

    const rows = await listInsights();
    expect(rows).toHaveLength(1);
    const evidence = rows[0]!.evidence as Record<string, unknown>;
    expect(evidence["utm_attributed"]).toBe(10);
    expect(evidence["time_correlated"]).toBe(5);
    expect(evidence["attribution_pct"]).toBe(30);
  });

  // ── (5) Idempotent dedup within 24h ─────────────────────────────────────

  it("(5) dedup: open attribution insight within 24h suppresses re-emit", async () => {
    await seedLinkedInPost();
    await seedSignups({ total: 50, utmCount: 16 });

    const r1 = await runLinkedInAttribution(db, companyId);
    expect(r1.emitted).toBe(true);

    const r2 = await runLinkedInAttribution(db, companyId);
    expect(r2.emitted).toBe(false);
    expect(r2.skipReason).toBe("deduped_within_24h");

    const rows = await listInsights();
    expect(rows).toHaveLength(1);
  });
});
