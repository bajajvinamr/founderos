/**
 * Sprint 5 · S5.7 — experiment ROI rollup integration tests.
 *
 * Validates:
 *   - Only completed + actualLiftPct experiments included
 *   - Positive vs negative lift split correctly
 *   - Per-channel rollup sums per-channel
 *   - Warning surfaced when many positive experiments stack
 *   - Window filter (only last 90 days)
 *   - Tenant isolation
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  events,
  experiments,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { computeExperimentRoi } from "../services/finance/experiment-roi.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping experiment-roi tests: ${support.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("experiment ROI rollup", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("experiment-roi");
    db = createDb(testDb.connectionString);
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    await db.delete(experiments);
    await db.delete(events);
    await db.delete(companies);
    const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const [c] = await db
      .insert(companies)
      .values({
        name: "Experiment ROI Co",
        instanceId: "test-instance",
        issuePrefix: `ER${suffix}`,
      })
      .returning();
    companyId = c.id;
  });

  async function seedActiveSubs(opts: {
    count: number;
    amountCents: number;
  }) {
    for (let i = 0; i < opts.count; i++) {
      await db.insert(events).values({
        companyId,
        source: "stripe",
        entityType: "subscription",
        eventName: "subscription.created",
        dedupKey: `mrr-${i}`,
        occurredAt: new Date(Date.now() - 30 * 86_400_000),
        payload: {
          subscription_id: `sub_${i}`,
          customer_id: `cus_${i}`,
          amount: String(opts.amountCents),
        },
      });
    }
  }

  async function seedExperiment(opts: {
    hypothesis: string;
    channel: string | null;
    actualLiftPct: number | null;
    status: string;
    completedDaysAgo: number;
  }) {
    await db.insert(experiments).values({
      companyId,
      hypothesis: opts.hypothesis,
      channel: opts.channel as
        | "linkedin"
        | "paid_meta"
        | "paid_google"
        | "referral"
        | "seo"
        | "partnerships"
        | "content"
        | null,
      actualLiftPct: opts.actualLiftPct,
      status: opts.status as
        | "proposed"
        | "running"
        | "completed"
        | "abandoned",
      iceImpact: 5,
      iceConfidence: 5,
      iceEase: 5,
      department: "growth",
      completedAt:
        opts.status === "completed"
          ? new Date(Date.now() - opts.completedDaysAgo * 86_400_000)
          : null,
    });
  }

  it("returns empty rollup with no experiments", async () => {
    const r = await computeExperimentRoi(db, companyId);
    expect(r.totals.positiveCount).toBe(0);
    expect(r.totals.negativeCount).toBe(0);
    expect(r.byChannel).toEqual([]);
  });

  it("ignores running/proposed experiments", async () => {
    await seedExperiment({
      hypothesis: "running exp",
      channel: "linkedin",
      actualLiftPct: 5,
      status: "running",
      completedDaysAgo: 0,
    });
    await seedExperiment({
      hypothesis: "proposed exp",
      channel: "linkedin",
      actualLiftPct: 5,
      status: "proposed",
      completedDaysAgo: 0,
    });
    const r = await computeExperimentRoi(db, companyId);
    expect(r.positiveLiftExperiments).toHaveLength(0);
    expect(r.negativeLiftExperiments).toHaveLength(0);
  });

  it("ignores experiments without actualLiftPct", async () => {
    await seedExperiment({
      hypothesis: "completed but no measurement",
      channel: "linkedin",
      actualLiftPct: null,
      status: "completed",
      completedDaysAgo: 10,
    });
    const r = await computeExperimentRoi(db, companyId);
    expect(r.positiveLiftExperiments).toHaveLength(0);
  });

  it("computes attributable MRR from actual lift × current MRR", async () => {
    await seedActiveSubs({ count: 10, amountCents: 5000 }); // MRR = $500 = 50,000 cents
    await seedExperiment({
      hypothesis: "Linkedin paid posts",
      channel: "linkedin",
      actualLiftPct: 10,
      status: "completed",
      completedDaysAgo: 30,
    });
    const r = await computeExperimentRoi(db, companyId);
    expect(r.currentMrrCents).toBe(50_000);
    expect(r.positiveLiftExperiments).toHaveLength(1);
    // 10% of 50,000 = 5,000 cents
    expect(r.positiveLiftExperiments[0].attributableMrrCents).toBe(5_000);
  });

  it("splits positive and negative lift", async () => {
    await seedActiveSubs({ count: 20, amountCents: 5000 });
    await seedExperiment({
      hypothesis: "winning",
      channel: "linkedin",
      actualLiftPct: 8,
      status: "completed",
      completedDaysAgo: 10,
    });
    await seedExperiment({
      hypothesis: "losing",
      channel: "paid_meta",
      actualLiftPct: -3,
      status: "completed",
      completedDaysAgo: 10,
    });
    const r = await computeExperimentRoi(db, companyId);
    expect(r.positiveLiftExperiments).toHaveLength(1);
    expect(r.negativeLiftExperiments).toHaveLength(1);
    expect(r.totals.cumulativeAttributableMrrCents).toBeGreaterThan(0);
  });

  it("rolls up per channel", async () => {
    await seedActiveSubs({ count: 10, amountCents: 5000 });
    await seedExperiment({
      hypothesis: "linkedin 1",
      channel: "linkedin",
      actualLiftPct: 5,
      status: "completed",
      completedDaysAgo: 10,
    });
    await seedExperiment({
      hypothesis: "linkedin 2",
      channel: "linkedin",
      actualLiftPct: 7,
      status: "completed",
      completedDaysAgo: 20,
    });
    await seedExperiment({
      hypothesis: "seo 1",
      channel: "seo",
      actualLiftPct: 3,
      status: "completed",
      completedDaysAgo: 30,
    });
    const r = await computeExperimentRoi(db, companyId);
    const linkedin = r.byChannel.find((c) => c.channel === "linkedin");
    const seo = r.byChannel.find((c) => c.channel === "seo");
    expect(linkedin?.experimentCount).toBe(2);
    expect(seo?.experimentCount).toBe(1);
    // Linkedin should rank higher than SEO since 5+7 > 3
    expect(r.byChannel[0].channel).toBe("linkedin");
  });

  it("filters by 90-day window", async () => {
    await seedActiveSubs({ count: 10, amountCents: 5000 });
    await seedExperiment({
      hypothesis: "recent",
      channel: "linkedin",
      actualLiftPct: 5,
      status: "completed",
      completedDaysAgo: 30,
    });
    await seedExperiment({
      hypothesis: "old",
      channel: "linkedin",
      actualLiftPct: 5,
      status: "completed",
      completedDaysAgo: 200, // outside window
    });
    const r = await computeExperimentRoi(db, companyId);
    expect(r.positiveLiftExperiments).toHaveLength(1);
    expect(r.positiveLiftExperiments[0].hypothesis).toBe("recent");
  });

  it("warns when many positive experiments stack (compounding caveat)", async () => {
    await seedActiveSubs({ count: 10, amountCents: 5000 });
    for (let i = 0; i < 5; i++) {
      await seedExperiment({
        hypothesis: `exp ${i}`,
        channel: "linkedin",
        actualLiftPct: 5,
        status: "completed",
        completedDaysAgo: 10 + i,
      });
    }
    const r = await computeExperimentRoi(db, companyId);
    const compoundingWarning = r.warnings.find((w) =>
      w.includes("compounds non-linearly"),
    );
    expect(compoundingWarning).toBeDefined();
  });

  it("warns when current MRR is zero", async () => {
    await seedExperiment({
      hypothesis: "won",
      channel: "linkedin",
      actualLiftPct: 5,
      status: "completed",
      completedDaysAgo: 10,
    });
    const r = await computeExperimentRoi(db, companyId);
    const zeroWarning = r.warnings.find((w) =>
      w.includes("Current MRR is zero"),
    );
    expect(zeroWarning).toBeDefined();
  });

  it("isolates company data", async () => {
    await seedActiveSubs({ count: 10, amountCents: 5000 });
    const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const [other] = await db
      .insert(companies)
      .values({
        name: "Other Co",
        instanceId: "test-instance",
        issuePrefix: `OT${suffix}`,
      })
      .returning();
    await db.insert(experiments).values({
      companyId: other.id,
      hypothesis: "other co exp",
      channel: "linkedin",
      actualLiftPct: 50, // huge lift to verify it does NOT bleed in
      status: "completed",
      iceImpact: 5,
      iceConfidence: 5,
      iceEase: 5,
      department: "growth",
      completedAt: new Date(),
    });
    const r = await computeExperimentRoi(db, companyId);
    expect(r.positiveLiftExperiments).toHaveLength(0);
  });
});
