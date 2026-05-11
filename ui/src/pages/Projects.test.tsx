// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Project } from "@founderos/shared";
import { projectGoalCount } from "./Projects";

type GoalShape = Pick<Project, "goals" | "goalIds">;

describe("projectGoalCount", () => {
  it("counts goalIds when present", () => {
    const project: GoalShape = {
      goalIds: ["g1", "g2", "g3"],
      goals: [],
    };
    expect(projectGoalCount(project)).toBe(3);
  });

  it("prefers goalIds even when the deprecated goals array is empty", () => {
    // Regression pin: prior impl used `||` which short-circuits on empty
    // arrays (length 0 is falsy), so a project with goalIds=["g1","g2"] and
    // goals=[] would report goalCount=0. `??` must report 2.
    const project: GoalShape = {
      goalIds: ["g1", "g2"],
      goals: [],
    };
    expect(projectGoalCount(project)).toBe(2);
  });

  it("falls back to deprecated goals only when goalIds is absent", () => {
    const project = {
      goalIds: undefined as unknown as string[],
      goals: [
        { id: "g1", title: "Goal one" },
        { id: "g2", title: "Goal two" },
      ],
    } as GoalShape;
    expect(projectGoalCount(project)).toBe(2);
  });

  it("returns 0 when both fields are empty or absent", () => {
    expect(projectGoalCount({ goalIds: [], goals: [] })).toBe(0);
    expect(
      projectGoalCount({
        goalIds: undefined as unknown as string[],
        goals: undefined as unknown as Project["goals"],
      }),
    ).toBe(0);
  });
});
