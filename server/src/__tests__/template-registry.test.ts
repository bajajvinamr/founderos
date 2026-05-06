/**
 * Sprint 6 · S6.5 — template registry tests.
 *
 * Pure-data registry; no DB needed. Tests cover:
 *   1. The 3 named templates are present (growth-anomaly, content-loop,
 *      revenue-rescue) — invariant: PRD requires all three.
 *   2. revenue-rescue is live and instantiates as `churn-rescue` (the
 *      runtime template enum value already in production).
 *   3. growth-anomaly + content-loop are status=v1_1_planned with
 *      instantiateAs=null.
 *   4. liveCount + plannedCount are derived correctly.
 *   5. findNamedTemplate returns the right row, null on miss.
 */

import { describe, expect, it } from "vitest";
import {
  NAMED_TEMPLATES,
  findNamedTemplate,
  getTemplateRegistry,
} from "../services/workflows/template-registry.js";

describe("template registry (S6.5)", () => {
  it("exposes exactly the 3 PRD-flagship templates", () => {
    const ids = NAMED_TEMPLATES.map((t) => t.id);
    expect(new Set(ids)).toEqual(
      new Set(["growth-anomaly", "content-loop", "revenue-rescue"]),
    );
  });

  it("revenue-rescue is live and instantiates as churn-rescue", () => {
    const t = findNamedTemplate("revenue-rescue");
    expect(t).not.toBeNull();
    expect(t!.status).toBe("live");
    expect(t!.instantiateAs).toBe("churn-rescue");
    expect(t!.department).toBe("finance");
  });

  it("growth-anomaly is v1.1-planned with no instantiateAs", () => {
    const t = findNamedTemplate("growth-anomaly");
    expect(t).not.toBeNull();
    expect(t!.status).toBe("v1_1_planned");
    expect(t!.instantiateAs).toBeNull();
    expect(t!.department).toBe("growth");
  });

  it("content-loop is v1.1-planned with no instantiateAs", () => {
    const t = findNamedTemplate("content-loop");
    expect(t).not.toBeNull();
    expect(t!.status).toBe("v1_1_planned");
    expect(t!.instantiateAs).toBeNull();
    expect(t!.department).toBe("content");
  });

  it("registry view counts live vs planned correctly", () => {
    const view = getTemplateRegistry();
    expect(view.liveCount).toBe(1);
    expect(view.plannedCount).toBe(2);
    expect(view.templates).toHaveLength(3);
  });

  it("findNamedTemplate returns null for unknown ids", () => {
    expect(findNamedTemplate("totally-bogus")).toBeNull();
  });

  it("every live template's instantiateAs MUST point at a real WORKFLOW_TEMPLATES enum value", async () => {
    const { WORKFLOW_TEMPLATES } = await import("@founderos/db");
    const live = NAMED_TEMPLATES.filter((t) => t.status === "live");
    for (const t of live) {
      expect(t.instantiateAs).not.toBeNull();
      expect(WORKFLOW_TEMPLATES).toContain(t.instantiateAs);
    }
  });

  it("every template has a non-empty department + summaries", () => {
    for (const t of NAMED_TEMPLATES) {
      expect(t.department.length).toBeGreaterThan(0);
      expect(t.triggerSummary.length).toBeGreaterThan(10);
      expect(t.outcomeSummary.length).toBeGreaterThan(10);
      expect([1, 2, 3, 4]).toContain(t.defaultAutonomy);
    }
  });
});
