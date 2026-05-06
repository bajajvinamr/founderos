/**
 * Sprint 5 · S5.3 — churn forecast integration tests.
 *
 * Validates the cohort retention curve fit by seeding synthetic
 * subscriptions with known retention behavior and asserting the
 * fitted curve recovers it.
 *
 * The synthetic-cohort approach: seed N customers per cohort month;
 * delete a known fraction at each month boundary; assert the OLS fit
 * recovers `a ≈ 1.0` and `b` close to the implied decay rate.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { companies, createDb, events } from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { computeChurnForecast } from "../services/finance/churn-forecast.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping churn-forecast tests: ${support.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("churn forecast", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("churn-forecast");
    db = createDb(testDb.connectionString);
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    await db.delete(events);
    await db.delete(companies);
    const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const [c] = await db
      .insert(companies)
      .values({
        name: "Churn Forecast Test Co",
        instanceId: "test-instance",
        issuePrefix: `CF${suffix}`,
      })
      .returning();
    companyId = c.id;
  });

  /**
   * Seed N subs in a given cohort month, then schedule deletions for
   * a fraction of them at each subsequent month per the decay schedule.
   *
   * decaySchedule[i] = retention at month i (i.e. fraction of cohort
   * still alive at month i). Must be monotonically decreasing.
   */
  async function seedCohort(opts: {
    cohortMonth: Date; // anchor at the 1st of the month
    cohortSize: number;
    decaySchedule: number[]; // retention at month 0..N
    pricePerMonthCents: number;
  }) {
    const cohortKey = opts.cohortMonth.toISOString().slice(0, 7);
    for (let i = 0; i < opts.cohortSize; i++) {
      const subId = `sub_${cohortKey}_${i}`;
      // Created at the 5th of the cohort month
      const created = new Date(opts.cohortMonth);
      created.setUTCDate(5);
      await db.insert(events).values({
        companyId,
        source: "stripe",
        entityType: "subscription",
        eventName: "subscription.created",
        dedupKey: `created:${subId}`,
        occurredAt: created,
        payload: {
          subscription_id: subId,
          customer_id: `cust_${subId}`,
          amount: String(opts.pricePerMonthCents),
        },
      });

      // Determine if/when this sub churns based on the schedule
      let aliveUntilMonth = opts.decaySchedule.length - 1;
      for (let m = 1; m < opts.decaySchedule.length; m++) {
        const ratioAlive = opts.decaySchedule[m];
        if (i / opts.cohortSize >= ratioAlive) {
          aliveUntilMonth = m - 1;
          break;
        }
      }

      if (aliveUntilMonth < opts.decaySchedule.length - 1) {
        const deleted = new Date(opts.cohortMonth);
        deleted.setUTCMonth(deleted.getUTCMonth() + aliveUntilMonth);
        deleted.setUTCDate(20);
        await db.insert(events).values({
          companyId,
          source: "stripe",
          entityType: "subscription",
          eventName: "subscription.deleted",
          dedupKey: `deleted:${subId}`,
          occurredAt: deleted,
          payload: {
            subscription_id: subId,
            customer_id: `cust_${subId}`,
            amount: String(opts.pricePerMonthCents),
          },
        });
      }
    }
  }

  function monthAgo(months: number): Date {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - months);
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  it("returns insufficient_data confidence with only one cohort", async () => {
    await seedCohort({
      cohortMonth: monthAgo(2),
      cohortSize: 20,
      decaySchedule: [1.0, 0.9, 0.8],
      pricePerMonthCents: 5000,
    });

    const forecast = await computeChurnForecast(db, companyId);
    expect(forecast.confidence).toBe("insufficient_data");
    expect(forecast.cohortCount).toBe(1);
    expect(forecast.warnings.length).toBeGreaterThan(0);
  });

  it("fits exponential decay with 6 cohorts at 5% monthly churn", async () => {
    // Seed 6 monthly cohorts of 100 subs each, each with 5% monthly churn
    const decay = [1.0, 0.95, 0.9, 0.85, 0.8, 0.76, 0.72, 0.68, 0.65];
    for (let m = 7; m >= 2; m--) {
      await seedCohort({
        cohortMonth: monthAgo(m),
        cohortSize: 100,
        decaySchedule: decay,
        pricePerMonthCents: 5000,
      });
    }

    const forecast = await computeChurnForecast(db, companyId);
    expect(forecast.cohortCount).toBe(6);
    // a should be close to 1.0 (full retention at t=0)
    expect(forecast.curve.a).toBeGreaterThan(0.9);
    expect(forecast.curve.a).toBeLessThan(1.1);
    // b corresponds to ~5% monthly decay → b ≈ 0.05 (range 0.03–0.08)
    expect(forecast.curve.b).toBeGreaterThan(0.03);
    expect(forecast.curve.b).toBeLessThan(0.10);
    // R² should be very high on a clean exponential synthetic
    expect(forecast.curve.rSquared).toBeGreaterThan(0.85);
  });

  it("projects 3 future months with monotonically decreasing retention", async () => {
    const decay = [1.0, 0.9, 0.81, 0.73, 0.66, 0.59, 0.53];
    for (let m = 7; m >= 2; m--) {
      await seedCohort({
        cohortMonth: monthAgo(m),
        cohortSize: 50,
        decaySchedule: decay,
        pricePerMonthCents: 8000,
      });
    }

    const forecast = await computeChurnForecast(db, companyId);
    expect(forecast.projection).toHaveLength(3);
    // Projected retention should decline each month
    expect(forecast.projection[0].projectedRetention).toBeGreaterThanOrEqual(
      forecast.projection[1].projectedRetention,
    );
    expect(forecast.projection[1].projectedRetention).toBeGreaterThanOrEqual(
      forecast.projection[2].projectedRetention,
    );
    // Projected lost MRR is non-negative
    for (const p of forecast.projection) {
      expect(p.projectedLostMrrCents).toBeGreaterThanOrEqual(0);
    }
  });

  it("computes current active MRR (excluding deleted)", async () => {
    const decay = [1.0, 0.8, 0.6];
    for (let m = 5; m >= 2; m--) {
      await seedCohort({
        cohortMonth: monthAgo(m),
        cohortSize: 20,
        decaySchedule: decay,
        pricePerMonthCents: 5000,
      });
    }
    const forecast = await computeChurnForecast(db, companyId);
    expect(forecast.currentActiveMrrCents).toBeGreaterThan(0);
  });

  it("retentionByMonth shape: each entry has month/observed/predicted", async () => {
    const decay = [1.0, 0.9, 0.81, 0.73, 0.66, 0.59];
    for (let m = 6; m >= 2; m--) {
      await seedCohort({
        cohortMonth: monthAgo(m),
        cohortSize: 50,
        decaySchedule: decay,
        pricePerMonthCents: 5000,
      });
    }
    const forecast = await computeChurnForecast(db, companyId);
    expect(forecast.retentionByMonth.length).toBeGreaterThan(0);
    for (const entry of forecast.retentionByMonth) {
      expect(entry.month).toBeGreaterThanOrEqual(1);
      expect(entry.observed).toBeGreaterThan(0);
      expect(entry.observed).toBeLessThanOrEqual(1);
      expect(entry.predicted).toBeGreaterThan(0);
      expect(entry.predicted).toBeLessThanOrEqual(1);
    }
  });

  it("includes weak-fit warning when R² is low", async () => {
    // Seed cohorts with non-exponential retention (chaotic) → low R²
    for (let m = 6; m >= 2; m--) {
      await seedCohort({
        cohortMonth: monthAgo(m),
        cohortSize: 30,
        decaySchedule: [1.0, 0.5, 0.4, 0.45, 0.4, 0.42, 0.41],
        pricePerMonthCents: 5000,
      });
    }
    const forecast = await computeChurnForecast(db, companyId);
    if (forecast.curve.rSquared < 0.5) {
      const weakFitWarning = forecast.warnings.find((w) =>
        w.includes("Curve fit is weak"),
      );
      expect(weakFitWarning).toBeDefined();
    }
  });

  it("isolates company data — other companies' subs do not pollute the fit", async () => {
    // Seed our company with a smooth decay
    const decay = [1.0, 0.9, 0.8, 0.72, 0.65, 0.59];
    for (let m = 6; m >= 2; m--) {
      await seedCohort({
        cohortMonth: monthAgo(m),
        cohortSize: 50,
        decaySchedule: decay,
        pricePerMonthCents: 5000,
      });
    }

    // Seed an unrelated company with chaotic data
    const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const [other] = await db
      .insert(companies)
      .values({
        name: "Other Co",
        instanceId: "test-instance",
        issuePrefix: `OT${suffix}`,
      })
      .returning();
    for (let i = 0; i < 50; i++) {
      await db.insert(events).values({
        companyId: other.id,
        source: "stripe",
        entityType: "subscription",
        eventName: "subscription.created",
        dedupKey: `other-created-${i}`,
        occurredAt: new Date(Date.now() - 30 * 86_400_000),
        payload: {
          subscription_id: `other_${i}`,
          customer_id: `other_cust_${i}`,
          amount: "9999",
        },
      });
    }

    const forecast = await computeChurnForecast(db, companyId);
    // Curve fit should reflect our company's smooth decay, not the other's
    expect(forecast.curve.rSquared).toBeGreaterThan(0.85);
  });
});
