import { describe, it, expect } from "vitest";
import type { CompanyTemplate } from "@founderos/shared";
import { assertTemplateShape } from "../services/template-spawn.js";

/**
 * Server-side defense against malformed template JSON uploaded by users
 * through POST /api/templates/spawn with inlineTemplate. These tests lock
 * the invariants — if someone weakens assertTemplateShape, these break.
 */

function validTemplate(overrides: Partial<CompanyTemplate> = {}): CompanyTemplate {
  return {
    id: "valid-t",
    name: "Valid",
    tagline: "tag",
    summary: "s",
    icon: "📂",
    issuePrefix: "VAL",
    budgetUsd: 100,
    category: "custom",
    metrics: {},
    agents: [
      {
        key: "ceo",
        name: "CEO",
        role: "ceo",
        title: "CEO",
        budgetUsd: 100,
        capabilities: "Runs the company.",
        heartbeatPrompt: "Each heartbeat: review open issues.",
      },
    ],
    goals: [],
    projects: [],
    issues: [],
    ...overrides,
  };
}

describe("assertTemplateShape — acceptance", () => {
  it("accepts a minimal valid template", () => {
    expect(() => assertTemplateShape(validTemplate())).not.toThrow();
  });

  it("accepts a template with multiple agents + reports-to graph", () => {
    expect(() =>
      assertTemplateShape(
        validTemplate({
          agents: [
            { key: "ceo", name: "CEO", role: "ceo", title: "CEO", budgetUsd: 100, capabilities: "c", heartbeatPrompt: "Each heartbeat: x." },
            { key: "cmo", name: "CMO", role: "cmo", title: "CMO", reportsTo: "ceo", budgetUsd: 50, capabilities: "c", heartbeatPrompt: "Each heartbeat: y." },
          ],
        }),
      ),
    ).not.toThrow();
  });
});

describe("assertTemplateShape — rejection", () => {
  it("rejects empty agent list", () => {
    expect(() => assertTemplateShape(validTemplate({ agents: [] }))).toThrow(/no agents/i);
  });

  it("rejects duplicate agent keys", () => {
    expect(() =>
      assertTemplateShape(
        validTemplate({
          agents: [
            { key: "dup", name: "A", role: "r", title: "t", budgetUsd: 50, capabilities: "c", heartbeatPrompt: "Each heartbeat: x." },
            { key: "dup", name: "B", role: "r", title: "t", budgetUsd: 50, capabilities: "c", heartbeatPrompt: "Each heartbeat: y." },
          ],
        }),
      ),
    ).toThrow(/duplicate agent keys/i);
  });

  it("rejects duplicate goal keys", () => {
    expect(() =>
      assertTemplateShape(
        validTemplate({
          agents: [
            { key: "ceo", name: "CEO", role: "ceo", title: "CEO", budgetUsd: 100, capabilities: "c", heartbeatPrompt: "Each heartbeat: x." },
          ],
          goals: [
            { key: "g1", title: "A", description: "", ownerKey: "ceo" },
            { key: "g1", title: "B", description: "", ownerKey: "ceo" },
          ],
        }),
      ),
    ).toThrow(/duplicate goal keys/i);
  });

  it("rejects duplicate project keys", () => {
    expect(() =>
      assertTemplateShape(
        validTemplate({
          agents: [
            { key: "ceo", name: "CEO", role: "ceo", title: "CEO", budgetUsd: 100, capabilities: "c", heartbeatPrompt: "Each heartbeat: x." },
          ],
          goals: [{ key: "g1", title: "G", description: "", ownerKey: "ceo" }],
          projects: [
            { key: "p1", name: "A", description: "", goalKey: "g1", leadKey: "ceo" },
            { key: "p1", name: "B", description: "", goalKey: "g1", leadKey: "ceo" },
          ],
        }),
      ),
    ).toThrow(/duplicate project keys/i);
  });
});
