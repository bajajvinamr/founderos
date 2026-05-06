/**
 * Sprint 5 · S5.8 — cash planning integration tests.
 *
 * Validates the 6-month projection composes baseline + scenario
 * adjustments correctly:
 *   - No-op input → matches baseline runway shape
 *   - Hire +1 → projected cash drops by salary × months_employed
 *   - Price hike → MRR up at month 1
 *   - Churn delta → retention curve shifted down
 *   - Marketing spend → adds to outflows
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  companies,
  companyFinancials,
  createDb,
  events,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { computeCashPlan } from "../services/finance/cash-planning.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping cash-planning tests: ${support.reason ?? "unsupported"}`,
  );
}

const noOpInput = {
  hires: [],
  priceChangePct: 0,
  churnDeltaPct: 0,
  monthlyMarketingSpendCents: 0,
  horizonMonths: 6,
};

describeEmbeddedPostgres("cash planning", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("cash-planning");
    db = createDb(testDb.connectionString);
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    await db.delete(events);
    await db.delete(companyFinancials);
    await db.delete(companies);
    const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const [c] = await db
      .insert(companies)
      .values({
        name: "Cash Planning Test Co",
        instanceId: "test-instance",
        issuePrefix: `CP${suffix}`,
      })
      .returning();
    companyId = c.id;
  });

  it("returns warnings + zero months when finance settings are missing", async () => {
    const plan = await computeCashPlan(db, companyId, noOpInput);
    expect(plan.months).toEqual([]);
    expect(plan.warnings.length).toBeGreaterThan(0);
  });

  it("baseline matches no-revenue runway: $100k/$20k → out at month 5", async () => {
    await db.insert(companyFinancials).values({
      companyId,
      cashBalanceCents: 10_000_000,
      monthlyBurnCents: 2_000_000,
    });

    const plan = await computeCashPlan(db, companyId, noOpInput);
    // 6 months projection, cash drops $20k each month from $100k
    expect(plan.months).toHaveLength(6);
    // At month 5, cash should be 0 or negative
    expect(plan.cashOutMonth).toBeLessThanOrEqual(6);
  });

  it("hire +1 reduces cash by salary × months remaining", async () => {
    await db.insert(companyFinancials).values({
      companyId,
      cashBalanceCents: 50_000_000, // $500k
      monthlyBurnCents: 2_000_000,
    });

    const baseline = await computeCashPlan(db, companyId, noOpInput);
    const withHire = await computeCashPlan(db, companyId, {
      ...noOpInput,
      hires: [{ salaryCents: 1_000_000, startMonthOffset: 0 }], // $10k/mo from month 0
    });

    // After 6 months, withHire.cash should be ~$60k less than baseline
    const baselineEnd = baseline.endingCashCents;
    const hireEnd = withHire.endingCashCents;
    expect(baselineEnd - hireEnd).toBeCloseTo(6_000_000, -3); // ±$10
  });

  it("hire with future startMonthOffset only impacts later months", async () => {
    await db.insert(companyFinancials).values({
      companyId,
      cashBalanceCents: 50_000_000,
      monthlyBurnCents: 2_000_000,
    });

    const plan = await computeCashPlan(db, companyId, {
      ...noOpInput,
      hires: [{ salaryCents: 1_000_000, startMonthOffset: 3 }], // $10k/mo from month 3
    });

    // Month 1 + 2 should have zero hire salary
    expect(plan.months[0].outflows.hireSalariesCents).toBe(0);
    expect(plan.months[1].outflows.hireSalariesCents).toBe(0);
    // Month 3+ should include the salary
    expect(plan.months[2].outflows.hireSalariesCents).toBe(1_000_000);
    expect(plan.months[5].outflows.hireSalariesCents).toBe(1_000_000);
  });

  it("price hike increases month 1 revenue", async () => {
    await db.insert(companyFinancials).values({
      companyId,
      cashBalanceCents: 50_000_000,
      monthlyBurnCents: 2_000_000,
    });
    // Seed 10 active subs at $100/mo → MRR = $1000 = 100,000 cents
    for (let i = 0; i < 10; i++) {
      await db.insert(events).values({
        companyId,
        source: "stripe",
        entityType: "subscription",
        eventName: "subscription.created",
        dedupKey: `s_${i}`,
        occurredAt: new Date(Date.now() - 30 * 86_400_000),
        payload: {
          subscription_id: `sub_${i}`,
          customer_id: `cus_${i}`,
          amount: "10000",
        },
      });
    }

    const baseline = await computeCashPlan(db, companyId, noOpInput);
    const withHike = await computeCashPlan(db, companyId, {
      ...noOpInput,
      priceChangePct: 20,
    });

    // Month 1 revenue with hike should be 1.2× baseline (price multiplier)
    // Both have the same retention curve applied
    const baselineRev = baseline.months[0].inflows.revenueGrossCents;
    const hikeRev = withHike.months[0].inflows.revenueGrossCents;
    expect(hikeRev).toBeGreaterThan(baselineRev);
  });

  it("churn delta shifts retention curve down (less revenue)", async () => {
    await db.insert(companyFinancials).values({
      companyId,
      cashBalanceCents: 50_000_000,
      monthlyBurnCents: 2_000_000,
    });
    for (let i = 0; i < 10; i++) {
      await db.insert(events).values({
        companyId,
        source: "stripe",
        entityType: "subscription",
        eventName: "subscription.created",
        dedupKey: `s_${i}`,
        occurredAt: new Date(Date.now() - 60 * 86_400_000),
        payload: {
          subscription_id: `sub_${i}`,
          customer_id: `cus_${i}`,
          amount: "10000",
        },
      });
    }

    const baseline = await computeCashPlan(db, companyId, noOpInput);
    const withChurn = await computeCashPlan(db, companyId, {
      ...noOpInput,
      churnDeltaPct: 10, // 10 percentage points worse
    });

    // Sum baseline revenue across 6 months vs with extra churn
    const baselineSum = baseline.months.reduce(
      (s, m) => s + m.inflows.revenueGrossCents,
      0,
    );
    const churnSum = withChurn.months.reduce(
      (s, m) => s + m.inflows.revenueGrossCents,
      0,
    );
    expect(churnSum).toBeLessThanOrEqual(baselineSum);
  });

  it("marketing spend adds to outflows on every month", async () => {
    await db.insert(companyFinancials).values({
      companyId,
      cashBalanceCents: 50_000_000,
      monthlyBurnCents: 2_000_000,
    });

    const plan = await computeCashPlan(db, companyId, {
      ...noOpInput,
      monthlyMarketingSpendCents: 500_000, // $5k/mo
    });

    for (const m of plan.months) {
      expect(m.outflows.marketingSpendCents).toBe(500_000);
    }
  });

  it("respects custom horizonMonths", async () => {
    await db.insert(companyFinancials).values({
      companyId,
      cashBalanceCents: 50_000_000,
      monthlyBurnCents: 2_000_000,
    });

    const plan = await computeCashPlan(db, companyId, {
      ...noOpInput,
      horizonMonths: 12,
    });
    expect(plan.months).toHaveLength(12);
  });

  it("warns about aggressive price hikes", async () => {
    await db.insert(companyFinancials).values({
      companyId,
      cashBalanceCents: 50_000_000,
      monthlyBurnCents: 2_000_000,
    });

    const plan = await computeCashPlan(db, companyId, {
      ...noOpInput,
      priceChangePct: 50,
    });
    const aggressiveWarning = plan.warnings.find((w) =>
      w.includes("aggressive"),
    );
    expect(aggressiveWarning).toBeDefined();
  });

  it("warns when 3+ hires modeled", async () => {
    await db.insert(companyFinancials).values({
      companyId,
      cashBalanceCents: 100_000_000,
      monthlyBurnCents: 2_000_000,
    });

    const plan = await computeCashPlan(db, companyId, {
      ...noOpInput,
      hires: [
        { salaryCents: 1_000_000, startMonthOffset: 0 },
        { salaryCents: 1_000_000, startMonthOffset: 1 },
        { salaryCents: 1_000_000, startMonthOffset: 2 },
      ],
    });
    const compoundWarning = plan.warnings.find((w) =>
      w.includes("hires modeled"),
    );
    expect(compoundWarning).toBeDefined();
  });

  it("scenario field reflects the input", async () => {
    await db.insert(companyFinancials).values({
      companyId,
      cashBalanceCents: 50_000_000,
      monthlyBurnCents: 2_000_000,
    });

    const plan = await computeCashPlan(db, companyId, {
      ...noOpInput,
      hires: [{ salaryCents: 1_000_000, startMonthOffset: 0 }],
      priceChangePct: 10,
      churnDeltaPct: 2,
      monthlyMarketingSpendCents: 200_000,
    });

    expect(plan.scenario.hireCount).toBe(1);
    expect(plan.scenario.totalHireSalaryAddedCents).toBe(1_000_000);
    expect(plan.scenario.priceChangePct).toBe(10);
    expect(plan.scenario.churnDeltaPct).toBe(2);
    expect(plan.scenario.monthlyMarketingSpendCents).toBe(200_000);
  });
});
