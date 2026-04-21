import { describe, it, expect } from "vitest";
import { runScenario, type ScenarioInputs, type TierCurrent } from "./scenario-modeling.js";

const BASE_TIERS: TierCurrent[] = [
  { name: "Solo Founder", priceCentsPerMonth: 29900, customerCount: 12 },
  { name: "Lean Team", priceCentsPerMonth: 200000, customerCount: 6 },
  { name: "Venture Studio", priceCentsPerMonth: 1000000, customerCount: 1 },
];

const BASE_INPUTS: ScenarioInputs = {
  tiers: BASE_TIERS,
  priceChanges: {},
  expectedChurnUpliftPct: 5,
  expectedNewCustomerDecreasePct: 15,
  currentMonthlyNewCustomers: 8,
  avgAcquisitionCostCents: 50000,
};

// Baseline MRR = 12*29900 + 6*200000 + 1*1000000 = 358800 + 1200000 + 1000000 = 2558800
const BASELINE_MRR = 12 * 29900 + 6 * 200000 + 1 * 1000000;

describe("runScenario", () => {
  it("1. No price changes → projected MRR equals baseline MRR", () => {
    const result = runScenario({ ...BASE_INPUTS, priceChanges: {} });
    expect(result.baselineMrrCents).toBe(BASELINE_MRR);
    // No price changes → no churn hit, but new customers add revenue
    // projectedMrr will be > baseline because new customers still come in
    // BUT with no price changes changedTiers is empty → churnedCustomers = 0
    // new revenue = 8 * (1 - 0.15) * avgPrice
    // This test verifies projectedMrr === baselineMrr when newCustomers = 0
    const noNewResult = runScenario({
      ...BASE_INPUTS,
      priceChanges: {},
      currentMonthlyNewCustomers: 0,
      expectedNewCustomerDecreasePct: 0,
    });
    expect(noNewResult.projectedMrrCents).toBe(noNewResult.baselineMrrCents);
  });

  it("2. 10% price hike with 5% expected churn → projected MRR increases", () => {
    const result = runScenario({
      ...BASE_INPUTS,
      priceChanges: {
        "Solo Founder": Math.round(29900 * 1.1),    // +10%
        "Lean Team": Math.round(200000 * 1.1),       // +10%
      },
      expectedChurnUpliftPct: 5,
      currentMonthlyNewCustomers: 8,
      expectedNewCustomerDecreasePct: 10,
    });
    expect(result.projectedMrrCents).toBeGreaterThan(result.baselineMrrCents);
    expect(result.mrrDeltaCents).toBeGreaterThan(0);
  });

  it("3. Doubled price with 30% churn → may drop MRR, includes 'Price more than doubled' warning", () => {
    const result = runScenario({
      ...BASE_INPUTS,
      priceChanges: {
        "Solo Founder": 29900 * 2,    // exactly doubled — should NOT trigger (need >2x)
        "Lean Team": 200000 * 3,      // tripled — should trigger warning
      },
      expectedChurnUpliftPct: 30,
      currentMonthlyNewCustomers: 2,
      expectedNewCustomerDecreasePct: 50,
    });
    const hasDoubledWarning = result.warnings.some((w) =>
      w.includes("Price more than doubled"),
    );
    expect(hasDoubledWarning).toBe(true);
    // With 30% churn uplift: churn warning should also appear
    const hasChurnWarning = result.warnings.some((w) =>
      w.includes("Churn assumption above 20%"),
    );
    expect(hasChurnWarning).toBe(true);
  });

  it("4. 12-month projection has exactly 12 entries (months 1-12)", () => {
    const result = runScenario(BASE_INPUTS);
    // twelveMonthMrrProjection includes month 0 through month 12 = 13 entries
    // but the spec says "12-month projection" — we store 0..12 = 13 points (month 0 = baseline)
    // The chart shows horizonMonths bars; filter to months 1-12 for 12 entries
    const monthsOnly = result.twelveMonthMrrProjection.filter((p) => p.month > 0);
    expect(monthsOnly).toHaveLength(12);
  });

  it("5. Month 0 of projection equals baseline MRR", () => {
    const result = runScenario(BASE_INPUTS);
    const month0 = result.twelveMonthMrrProjection.find((p) => p.month === 0);
    expect(month0).toBeDefined();
    expect(month0!.mrrCents).toBe(BASELINE_MRR);
  });

  it("6. expectedNewCustomerDecreasePct = 100 → projectedMonthlyNewCustomers === 0", () => {
    const result = runScenario({
      ...BASE_INPUTS,
      expectedNewCustomerDecreasePct: 100,
    });
    expect(result.projectedMonthlyNewCustomers).toBe(0);
  });

  it("7. Zero baseline (no customers) triggers 'No paying customers' warning", () => {
    const result = runScenario({
      ...BASE_INPUTS,
      tiers: [{ name: "Solo Founder", priceCentsPerMonth: 29900, customerCount: 0 }],
    });
    const hasWarning = result.warnings.some((w) =>
      w.includes("No paying customers yet"),
    );
    expect(hasWarning).toBe(true);
    expect(result.baselineMrrCents).toBe(0);
  });

  it("8. Payback delta is negative when price rises (faster payback)", () => {
    const result = runScenario({
      ...BASE_INPUTS,
      priceChanges: {
        "Solo Founder": 50000,   // up from 29900
        "Lean Team": 300000,     // up from 200000
        "Venture Studio": 1500000, // up from 1000000
      },
      avgAcquisitionCostCents: 500000, // meaningful CAC
    });
    // Higher price → shorter payback → delta should be negative
    expect(result.paybackDeltaMonths).toBeLessThan(0);
  });

  it("9. New-customer decrease > 30 triggers warning", () => {
    const result = runScenario({
      ...BASE_INPUTS,
      expectedNewCustomerDecreasePct: 35,
    });
    const hasWarning = result.warnings.some((w) =>
      w.includes("New-customer drop above 30%"),
    );
    expect(hasWarning).toBe(true);
  });

  it("10. NRR is 100 when projected MRR equals baseline (zero new/churned customers)", () => {
    const result = runScenario({
      ...BASE_INPUTS,
      priceChanges: {},
      currentMonthlyNewCustomers: 0,
      expectedNewCustomerDecreasePct: 0,
    });
    expect(result.nrrPct).toBeCloseTo(100, 1);
  });
});
