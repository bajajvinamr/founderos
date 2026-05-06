/**
 * Sprint 5 · S5.1 — revenue cockpit math integration tests.
 *
 * Validates the computeCockpitMetrics() service against a hand-built
 * fixture set. Each test seeds the events table with explicit Stripe
 * subscription events and asserts the computed metric matches a
 * hand-calculated truth value.
 *
 * Why integration not unit: the math is SQL-heavy (DISTINCT ON, COUNT
 * FILTER, JSONB extraction, cross-table JOINs). Mocking Drizzle would
 * just exercise the mock. Real Postgres catches the case of "the SQL
 * looks right but DISTINCT ON ordering is wrong" — a class of bug the
 * S2.6 ingest tests hit before the embedded-pg fixture pattern landed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  companies,
  companyFinancials,
  createDb,
  events,
  marketingSpend,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { computeCockpitMetrics } from "../services/finance/cockpit.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping finance-cockpit tests: ${support.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("finance cockpit math", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("finance-cockpit");
    db = createDb(testDb.connectionString);
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    // events has ON DELETE RESTRICT on company_id so we must clear events
    // BEFORE re-seeding companies. marketing_spend + company_financials
    // both ON DELETE CASCADE so they're easier.
    await db.delete(events);
    await db.delete(marketingSpend);
    await db.delete(companyFinancials);
    await db.delete(companies);

    const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const [c] = await db
      .insert(companies)
      .values({
        name: "Cockpit Test Co",
        instanceId: "test-instance",
        issuePrefix: `CT${suffix}`,
      })
      .returning();
    companyId = c.id;
  });

  /**
   * Helper: seed a Stripe subscription event with our payload contract.
   */
  async function seedEvent(opts: {
    eventName: string;
    subscriptionId: string;
    customerId: string;
    amountCents: number;
    occurredAt: Date;
    dedupKey?: string;
  }) {
    await db.insert(events).values({
      companyId,
      source: "stripe",
      entityType: "subscription",
      eventName: opts.eventName,
      dedupKey:
        opts.dedupKey ??
        `${opts.eventName}:${opts.subscriptionId}:${opts.occurredAt.getTime()}`,
      occurredAt: opts.occurredAt,
      payload: {
        subscription_id: opts.subscriptionId,
        customer_id: opts.customerId,
        amount: String(opts.amountCents),
      },
    });
  }

  it("returns zeroes for empty workspace with insufficient_data confidence", async () => {
    const m = await computeCockpitMetrics(db, companyId);
    expect(m.mrr.cents).toBe(0);
    expect(m.mrr.confidence).toBe("insufficient_data");
    expect(m.arr.cents).toBe(0);
    expect(m.customerCount.total).toBe(0);
    expect(m.ltv.confidence).toBe("insufficient_data");
    expect(m.cac.cents).toBeNull();
    expect(m.cac.note).toMatch(/Add marketing spend/i);
  });

  it("computes MRR as sum of active subscription amounts", async () => {
    const now = new Date();
    await seedEvent({
      eventName: "subscription.created",
      subscriptionId: "sub_1",
      customerId: "cus_1",
      amountCents: 5000,
      occurredAt: new Date(now.getTime() - 10 * 86_400_000),
    });
    await seedEvent({
      eventName: "subscription.created",
      subscriptionId: "sub_2",
      customerId: "cus_2",
      amountCents: 7500,
      occurredAt: new Date(now.getTime() - 5 * 86_400_000),
    });

    const m = await computeCockpitMetrics(db, companyId);
    expect(m.mrr.cents).toBe(12_500);
    expect(m.arr.cents).toBe(150_000);
    expect(m.customerCount.paying).toBe(2);
    expect(m.arpu.cents).toBe(6_250);
  });

  it("excludes deleted subscriptions from MRR (latest event wins)", async () => {
    const now = new Date();
    await seedEvent({
      eventName: "subscription.created",
      subscriptionId: "sub_1",
      customerId: "cus_1",
      amountCents: 5000,
      occurredAt: new Date(now.getTime() - 20 * 86_400_000),
    });
    await seedEvent({
      eventName: "subscription.deleted",
      subscriptionId: "sub_1",
      customerId: "cus_1",
      amountCents: 5000,
      occurredAt: new Date(now.getTime() - 5 * 86_400_000),
    });
    await seedEvent({
      eventName: "subscription.created",
      subscriptionId: "sub_2",
      customerId: "cus_2",
      amountCents: 9000,
      occurredAt: new Date(now.getTime() - 3 * 86_400_000),
    });

    const m = await computeCockpitMetrics(db, companyId);
    expect(m.mrr.cents).toBe(9_000);
    expect(m.customerCount.paying).toBe(1);
  });

  it("computes 30d churn rate and lost MRR", async () => {
    const now = new Date();
    // 5 subs created 60 days ago
    for (let i = 0; i < 5; i++) {
      await seedEvent({
        eventName: "subscription.created",
        subscriptionId: `sub_${i}`,
        customerId: `cus_${i}`,
        amountCents: 5000,
        occurredAt: new Date(now.getTime() - 60 * 86_400_000),
      });
    }
    // 1 churned in last 30d
    await seedEvent({
      eventName: "subscription.deleted",
      subscriptionId: "sub_0",
      customerId: "cus_0",
      amountCents: 5000,
      occurredAt: new Date(now.getTime() - 5 * 86_400_000),
    });

    const m = await computeCockpitMetrics(db, companyId);
    // active = 4, lost = 1, started = 5; churn = 1/5 = 20%
    expect(m.churn.rate30dPct).toBeCloseTo(20, 0);
    expect(m.churn.lostMrrCents).toBe(5_000);
  });

  it("computes LTV with low confidence at small sample sizes", async () => {
    const now = new Date();
    // 12 active subs at $50 each, 1 churned in last 30d
    for (let i = 0; i < 12; i++) {
      await seedEvent({
        eventName: "subscription.created",
        subscriptionId: `sub_${i}`,
        customerId: `cus_${i}`,
        amountCents: 5000,
        occurredAt: new Date(now.getTime() - 40 * 86_400_000),
      });
    }
    await seedEvent({
      eventName: "subscription.deleted",
      subscriptionId: "sub_0",
      customerId: "cus_0",
      amountCents: 5000,
      occurredAt: new Date(now.getTime() - 5 * 86_400_000),
    });

    const m = await computeCockpitMetrics(db, companyId);
    // Active subs = 11. Churn = 1/12 ≈ 8.33%. ARPU = 5000.
    // LTV = ARPU / churn_rate = 5000 / 0.0833 ≈ 60,000.
    expect(m.ltv.cents).toBeGreaterThan(50_000);
    expect(m.ltv.cents).toBeLessThan(70_000);
    expect(m.ltv.confidence).toBe("low"); // <50 sample
    expect(m.ltv.sampleSize).toBe(11);
  });

  it("returns insufficient_data LTV when sample is <10 customers", async () => {
    const now = new Date();
    for (let i = 0; i < 5; i++) {
      await seedEvent({
        eventName: "subscription.created",
        subscriptionId: `sub_${i}`,
        customerId: `cus_${i}`,
        amountCents: 5000,
        occurredAt: new Date(now.getTime() - 5 * 86_400_000),
      });
    }
    const m = await computeCockpitMetrics(db, companyId);
    expect(m.ltv.confidence).toBe("insufficient_data");
    expect(m.ltv.cents).toBe(0);
  });

  it("computes CAC from marketing_spend ÷ new customers", async () => {
    const now = new Date();
    // 10 new customers in last 30d
    for (let i = 0; i < 10; i++) {
      await seedEvent({
        eventName: "subscription.created",
        subscriptionId: `sub_${i}`,
        customerId: `cus_${i}`,
        amountCents: 5000,
        occurredAt: new Date(now.getTime() - 5 * 86_400_000),
      });
    }
    // $1000 spend on LinkedIn in last 60d
    await db.insert(marketingSpend).values({
      companyId,
      channel: "linkedin",
      periodStart: new Date(now.getTime() - 30 * 86_400_000)
        .toISOString()
        .slice(0, 10),
      periodEnd: new Date().toISOString().slice(0, 10),
      amountCents: 100_000,
    });

    const m = await computeCockpitMetrics(db, companyId);
    // CAC = $100,000 / 10 = $10,000 cents = $100
    expect(m.cac.cents).toBe(10_000);
    expect(m.cac.confidence).toBe("medium"); // ≥10 new customers
    expect(m.cac.channelBreakdown).toHaveLength(1);
    expect(m.cac.channelBreakdown[0].channel).toBe("linkedin");
  });

  it("ranks channels by CAC ascending (cheapest first)", async () => {
    const now = new Date();
    for (let i = 0; i < 20; i++) {
      await seedEvent({
        eventName: "subscription.created",
        subscriptionId: `sub_${i}`,
        customerId: `cus_${i}`,
        amountCents: 5000,
        occurredAt: new Date(now.getTime() - 5 * 86_400_000),
      });
    }
    const start = new Date(now.getTime() - 30 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const end = new Date().toISOString().slice(0, 10);
    await db.insert(marketingSpend).values([
      {
        companyId,
        channel: "linkedin",
        periodStart: start,
        periodEnd: end,
        amountCents: 200_000,
      },
      {
        companyId,
        channel: "seo",
        periodStart: start,
        periodEnd: end,
        amountCents: 50_000,
      },
    ]);

    const m = await computeCockpitMetrics(db, companyId);
    // 20 customers split 10/10 across 2 channels (per v1 equal-split)
    // SEO: $50k / 10 = $5000 cents → CAC=$50
    // LinkedIn: $200k / 10 = $20000 cents → CAC=$200
    // SEO ranks first
    expect(m.cac.channelBreakdown[0].channel).toBe("seo");
    expect(m.cac.channelBreakdown[0].cac).toBeLessThan(
      m.cac.channelBreakdown[1].cac,
    );
  });

  it("computes payback months from CAC ÷ (ARPU × gross margin)", async () => {
    const now = new Date();
    for (let i = 0; i < 10; i++) {
      await seedEvent({
        eventName: "subscription.created",
        subscriptionId: `sub_${i}`,
        customerId: `cus_${i}`,
        amountCents: 10_000, // $100
        occurredAt: new Date(now.getTime() - 5 * 86_400_000),
      });
    }
    await db.insert(marketingSpend).values({
      companyId,
      channel: "linkedin",
      periodStart: new Date(now.getTime() - 30 * 86_400_000)
        .toISOString()
        .slice(0, 10),
      periodEnd: new Date().toISOString().slice(0, 10),
      amountCents: 100_000, // $1000
    });

    const m = await computeCockpitMetrics(db, companyId);
    // CAC = $1000 / 10 = $100 → 10000 cents
    // ARPU = $100 → 10000 cents
    // payback = 10000 / (10000 * 0.7) = 1.43 months
    expect(m.paybackMonths.value).toBeCloseTo(1.43, 1);
  });

  it("returns null payback when CAC unknown", async () => {
    const now = new Date();
    await seedEvent({
      eventName: "subscription.created",
      subscriptionId: "sub_1",
      customerId: "cus_1",
      amountCents: 5000,
      occurredAt: new Date(now.getTime() - 5 * 86_400_000),
    });
    const m = await computeCockpitMetrics(db, companyId);
    expect(m.cac.cents).toBeNull();
    expect(m.paybackMonths.value).toBeNull();
  });

  it("hydrates cash + runway from company_financials when present", async () => {
    await db.insert(companyFinancials).values({
      companyId,
      cashBalanceCents: 10_000_000, // $100k
      monthlyBurnCents: 2_000_000, // $20k/mo
    });

    const m = await computeCockpitMetrics(db, companyId);
    expect(m.cash.cents).toBe(10_000_000);
    // No revenue yet — net burn = full $20k. runway = 100/20 = 5 months
    expect(m.cash.runwayMonths).toBeCloseTo(5, 0);
  });

  it("isolates company data — subs from another company do not bleed in", async () => {
    const now = new Date();
    const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const [other] = await db
      .insert(companies)
      .values({
        name: "Other Co",
        instanceId: "test-instance",
        issuePrefix: `OT${suffix}`,
      })
      .returning();

    // Seed events on the OTHER company
    await db.insert(events).values({
      companyId: other.id,
      source: "stripe",
      entityType: "subscription",
      eventName: "subscription.created",
      dedupKey: "iso-test-other",
      occurredAt: new Date(now.getTime() - 5 * 86_400_000),
      payload: {
        subscription_id: "other_sub",
        customer_id: "other_cus",
        amount: "9999",
      },
    });

    const m = await computeCockpitMetrics(db, companyId);
    expect(m.mrr.cents).toBe(0);
    expect(m.customerCount.total).toBe(0);
  });

  it("computes positive MoM delta when MRR is growing", async () => {
    const now = new Date();
    // Sub created 60 days ago at $50
    await seedEvent({
      eventName: "subscription.created",
      subscriptionId: "sub_old",
      customerId: "cus_old",
      amountCents: 5000,
      occurredAt: new Date(now.getTime() - 60 * 86_400_000),
    });
    // New sub added 5 days ago at $100
    await seedEvent({
      eventName: "subscription.created",
      subscriptionId: "sub_new",
      customerId: "cus_new",
      amountCents: 10_000,
      occurredAt: new Date(now.getTime() - 5 * 86_400_000),
    });

    const m = await computeCockpitMetrics(db, companyId);
    // Now: $150. 30d ago: $50. Delta = (150-50)/50 = 200%
    expect(m.mrr.deltaPctMoM).toBeCloseTo(200, 0);
  });
});
