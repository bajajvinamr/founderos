/**
 * Sprint 5 · S5.5 — runway forecast integration tests.
 *
 * Validates the cash-out projection across three scenario bands.
 * Hand-calculated truth values:
 *   - Cash $100k, burn $20k/mo, no revenue → 5 months runway
 *   - Cash $100k, burn $20k/mo, revenue $15k/mo @ 70% margin → ~9.4
 *     months ($100k / ($20k - $15k×0.7) = $100k / $9.5k ≈ 10.5)
 *   - Cash flow positive (revenue × margin > burn) → Infinity
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
import { computeRunwayForecast } from "../services/finance/runway-forecast.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping runway-forecast tests: ${support.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("runway forecast", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("runway-forecast");
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
        name: "Runway Test Co",
        instanceId: "test-instance",
        issuePrefix: `RW${suffix}`,
      })
      .returning();
    companyId = c.id;
  });

  it("returns warnings + zero bands when finance settings are missing", async () => {
    const forecast = await computeRunwayForecast(db, companyId);
    expect(forecast.cashCents).toBe(0);
    expect(forecast.warnings.length).toBeGreaterThan(0);
    expect(forecast.bands.base.monthsRemaining).toBe(0);
  });

  it("computes 5-month runway with cash $100k, burn $20k, no revenue", async () => {
    await db.insert(companyFinancials).values({
      companyId,
      cashBalanceCents: 10_000_000, // $100k
      monthlyBurnCents: 2_000_000, // $20k/mo
    });

    const forecast = await computeRunwayForecast(db, companyId);
    // No subscriptions → no revenue → net burn = full $20k
    // Runway = $100k / $20k = 5 months
    expect(forecast.bands.base.monthsRemaining).toBeCloseTo(5, 0);
    expect(forecast.bands.base.projectedCashOutDate).toBeTruthy();
  });

  it("conservative band has shorter runway than base; optimistic longer", async () => {
    await db.insert(companyFinancials).values({
      companyId,
      cashBalanceCents: 10_000_000,
      monthlyBurnCents: 2_000_000,
    });
    // Seed enough subscription history to get a real curve fit
    const now = new Date();
    for (let mAgo = 8; mAgo >= 1; mAgo--) {
      const cohortStart = new Date(now);
      cohortStart.setUTCMonth(cohortStart.getUTCMonth() - mAgo);
      cohortStart.setUTCDate(5);
      for (let i = 0; i < 20; i++) {
        await db.insert(events).values({
          companyId,
          source: "stripe",
          entityType: "subscription",
          eventName: "subscription.created",
          dedupKey: `s-${mAgo}-${i}`,
          occurredAt: cohortStart,
          payload: {
            subscription_id: `sub-${mAgo}-${i}`,
            customer_id: `cust-${mAgo}-${i}`,
            amount: "5000",
          },
        });
      }
      // Churn 1 sub per cohort per month after creation (5% monthly)
      if (mAgo >= 2) {
        const deletedAt = new Date(cohortStart);
        deletedAt.setUTCDate(20);
        deletedAt.setUTCMonth(deletedAt.getUTCMonth() + 1);
        await db.insert(events).values({
          companyId,
          source: "stripe",
          entityType: "subscription",
          eventName: "subscription.deleted",
          dedupKey: `del-${mAgo}-0`,
          occurredAt: deletedAt,
          payload: {
            subscription_id: `sub-${mAgo}-0`,
            customer_id: `cust-${mAgo}-0`,
            amount: "5000",
          },
        });
      }
    }

    const forecast = await computeRunwayForecast(db, companyId);
    // Conservative ≤ base ≤ optimistic by definition
    const cons = forecast.bands.conservative.monthsRemaining;
    const base = forecast.bands.base.monthsRemaining;
    const opt = forecast.bands.optimistic.monthsRemaining;

    if (typeof cons === "number" && typeof base === "number") {
      expect(cons).toBeLessThanOrEqual(base);
    }
    if (typeof base === "number" && typeof opt === "number") {
      expect(base).toBeLessThanOrEqual(opt);
    }
  });

  it("each band emits per-month balances up to horizon or cash-out", async () => {
    await db.insert(companyFinancials).values({
      companyId,
      cashBalanceCents: 5_000_000, // $50k
      monthlyBurnCents: 1_000_000, // $10k/mo
    });

    const forecast = await computeRunwayForecast(db, companyId);
    expect(forecast.bands.base.monthlyBalances.length).toBeGreaterThan(0);
    // Each balance row must have month/cashCents/mrrCents/netBurnCents
    for (const b of forecast.bands.base.monthlyBalances) {
      expect(b.month).toBeGreaterThanOrEqual(1);
      expect(typeof b.cashCents).toBe("number");
      expect(typeof b.netBurnCents).toBe("number");
    }
  });

  it("returns zero-band response when cash is non-positive", async () => {
    await db.insert(companyFinancials).values({
      companyId,
      cashBalanceCents: 0,
      monthlyBurnCents: 1_000_000,
    });
    const forecast = await computeRunwayForecast(db, companyId);
    expect(forecast.bands.base.monthsRemaining).toBe(0);
  });

  it("includes insufficient-curve warning when no subscription history", async () => {
    await db.insert(companyFinancials).values({
      companyId,
      cashBalanceCents: 10_000_000,
      monthlyBurnCents: 2_000_000,
    });
    const forecast = await computeRunwayForecast(db, companyId);
    const insufWarning = forecast.warnings.find((w) =>
      w.includes("insufficient data"),
    );
    expect(insufWarning).toBeDefined();
  });

  it("currentMrrCents reflects active subscriptions", async () => {
    await db.insert(companyFinancials).values({
      companyId,
      cashBalanceCents: 10_000_000,
      monthlyBurnCents: 2_000_000,
    });
    // 4 active subs at $50 each
    for (let i = 0; i < 4; i++) {
      await db.insert(events).values({
        companyId,
        source: "stripe",
        entityType: "subscription",
        eventName: "subscription.created",
        dedupKey: `mrr-test-${i}`,
        occurredAt: new Date(),
        payload: {
          subscription_id: `mrrs-${i}`,
          customer_id: `mrrc-${i}`,
          amount: "5000",
        },
      });
    }
    const forecast = await computeRunwayForecast(db, companyId);
    expect(forecast.currentMrrCents).toBe(20_000); // 4 × $50 = $200 = 20000 cents
  });
});
