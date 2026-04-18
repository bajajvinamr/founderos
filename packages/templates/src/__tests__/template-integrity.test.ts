import { describe, it, expect } from "vitest";
import { BUILTIN_TEMPLATES, getTemplate, listTemplateSummaries } from "../index.js";

describe("Template library integrity", () => {
  it("ships at least 3 built-in templates", () => {
    expect(BUILTIN_TEMPLATES.length).toBeGreaterThanOrEqual(3);
  });

  it("every template has a unique slug id", () => {
    const ids = BUILTIN_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every template has a unique issue prefix", () => {
    const prefixes = BUILTIN_TEMPLATES.map((t) => t.issuePrefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("listTemplateSummaries returns a summary per built-in template", () => {
    const summaries = listTemplateSummaries();
    expect(summaries.length).toBe(BUILTIN_TEMPLATES.length);
    for (const s of summaries) {
      expect(s.id).toBeTruthy();
      expect(s.name).toBeTruthy();
      expect(s.agentCount).toBeGreaterThan(0);
    }
  });

  it("getTemplate returns null for unknown ids", () => {
    expect(getTemplate("nonexistent-template")).toBeNull();
  });
});

describe.each(BUILTIN_TEMPLATES)("Template: $id", (template) => {
  it("has a first agent with no reportsTo (the CEO-of-company)", () => {
    expect(template.agents[0]?.reportsTo).toBeUndefined();
  });

  it("all agent keys are unique", () => {
    const keys = template.agents.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("all reportsTo references resolve to an existing agent key", () => {
    const keys = new Set(template.agents.map((a) => a.key));
    for (const agent of template.agents) {
      if (agent.reportsTo) {
        expect(keys.has(agent.reportsTo)).toBe(true);
      }
    }
  });

  it("all goal ownerKey references resolve to an existing agent", () => {
    const agentKeys = new Set(template.agents.map((a) => a.key));
    for (const goal of template.goals) {
      expect(agentKeys.has(goal.ownerKey)).toBe(true);
    }
  });

  it("all project goalKey references resolve to existing goals", () => {
    const goalKeys = new Set(template.goals.map((g) => g.key));
    for (const project of template.projects) {
      expect(goalKeys.has(project.goalKey)).toBe(true);
    }
  });

  it("all project leadKey references resolve to existing agents", () => {
    const agentKeys = new Set(template.agents.map((a) => a.key));
    for (const project of template.projects) {
      expect(agentKeys.has(project.leadKey)).toBe(true);
    }
  });

  it("all issue projectKey references resolve to existing projects", () => {
    const projectKeys = new Set(template.projects.map((p) => p.key));
    for (const issue of template.issues) {
      expect(projectKeys.has(issue.projectKey)).toBe(true);
    }
  });

  it("all issue assigneeKey references (if set) resolve to existing agents", () => {
    const agentKeys = new Set(template.agents.map((a) => a.key));
    for (const issue of template.issues) {
      if (issue.assigneeKey) {
        expect(agentKeys.has(issue.assigneeKey)).toBe(true);
      }
    }
  });

  it("every agent has a non-empty heartbeat prompt", () => {
    for (const agent of template.agents) {
      expect(agent.heartbeatPrompt).toBeTruthy();
      expect(agent.heartbeatPrompt.length).toBeGreaterThan(50);
    }
  });

  it("heartbeat prompts are task-oriented (not role-play)", () => {
    // Task prompts mention "heartbeat" explicitly and describe concrete steps.
    // This guards against regressing to identity-only prompts like
    // "You are the CEO..." which Claude Code refuses to play.
    for (const agent of template.agents) {
      const prompt = agent.heartbeatPrompt.toLowerCase();
      expect(prompt).toContain("heartbeat");
    }
  });
});
