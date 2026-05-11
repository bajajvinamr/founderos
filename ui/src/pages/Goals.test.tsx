// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Goal, GoalStatus } from "@founderos/shared";
import { deriveDrift } from "./Goals";

function makeGoal(status: GoalStatus): Goal {
  return {
    id: "goal-1",
    companyId: "company-1",
    title: "Test goal",
    description: null,
    level: "company",
    status,
    parentId: null,
    ownerAgentId: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
  };
}

describe("deriveDrift", () => {
  // TODO(W3-schema): when goal.drift_band lands on the schema, replace this
  // contract with a passthrough test and delete the status→band mapping above.
  it("maps achieved → ontrack with score 0", () => {
    const drift = deriveDrift(makeGoal("achieved"));
    expect(drift).toEqual({ band: "ontrack", score: 0, label: "Achieved" });
  });

  it("maps active → ontrack with low score", () => {
    const drift = deriveDrift(makeGoal("active"));
    expect(drift.band).toBe("ontrack");
    expect(drift.label).toBe("On track");
    expect(drift.score).toBeGreaterThanOrEqual(0);
    expect(drift.score).toBeLessThan(50);
  });

  it("maps planned → behind", () => {
    const drift = deriveDrift(makeGoal("planned"));
    expect(drift.band).toBe("behind");
    expect(drift.label).toBe("Behind plan");
  });

  it("maps cancelled → cancelled band with neutral styling (NOT atrisk)", () => {
    // Regression pin: cancelled goals are TERMINATED, not at-risk-of-failing.
    // The prior implementation rendered them red ("At risk", score 90) which
    // gave founders false signal that something was going wrong.
    const drift = deriveDrift(makeGoal("cancelled"));
    expect(drift.band).toBe("cancelled");
    expect(drift.band).not.toBe("atrisk");
    expect(drift.score).toBe(0);
    expect(drift.label).toBe("Cancelled");
  });

  it("returns a neutral band for unknown status values at runtime", () => {
    // The compile-time `never` check guards new status values, but defensively
    // verify the runtime default does not silently bucket as "behind".
    const goal = makeGoal("active");
    // Force an unknown status to exercise the default branch without breaking
    // the GoalStatus union elsewhere.
    const drift = deriveDrift({ ...goal, status: "lol-unknown" as GoalStatus });
    expect(drift.band).toBe("cancelled");
    expect(drift.score).toBe(0);
  });
});
