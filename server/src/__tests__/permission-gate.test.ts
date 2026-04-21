import { describe, expect, it } from "vitest";
import { injectPermissionAddendum } from "../services/heartbeat.js";
import type { AgentPermissionLevel } from "@founderos/shared";

describe("injectPermissionAddendum", () => {
  it("observe agent: returns prompt unchanged (adapter dispatch skipped upstream)", () => {
    // The observe gate short-circuits before adapter.execute in heartbeat.ts.
    // This test verifies injectPermissionAddendum itself adds no addendum for observe.
    const result = injectPermissionAddendum("observe" as AgentPermissionLevel, "My existing prompt.");
    expect(result).toBe("My existing prompt.");
    // No permission addendum should be present
    expect(result).not.toMatch(/Permission level: observe/);
    expect(result).not.toMatch(/Do NOT/);
  });

  it("draft agent: prompt contains 'draft' addendum and the words 'Do NOT'", () => {
    const base = "<company_charter>\nBuild fast.\n</company_charter>\n\nYou are the CMO.";
    const result = injectPermissionAddendum("draft" as AgentPermissionLevel, base);
    expect(result).toContain("draft");
    expect(result).toContain("Do NOT");
    expect(result).toContain("publish, send, deploy, commit, spend");
    // Original content preserved
    expect(result).toContain("You are the CMO.");
  });

  it("approve agent: prompt contains 'approve' addendum and 'create_approval'", () => {
    const base = "<company_charter>\nWe ship weekly.\n</company_charter>\n\nYou are the CTO.";
    const result = injectPermissionAddendum("approve" as AgentPermissionLevel, base);
    expect(result).toContain("approve");
    expect(result).toContain("create_approval");
    // Original content preserved
    expect(result).toContain("You are the CTO.");
  });

  it("autonomous agent: no permission addendum injected", () => {
    const base = "You are an autonomous data-sync agent.";
    const result = injectPermissionAddendum("autonomous" as AgentPermissionLevel, base);
    expect(result).toBe("You are an autonomous data-sync agent.");
    expect(result).not.toMatch(/Permission level/);
    expect(result).not.toMatch(/create_approval/);
    expect(result).not.toMatch(/Do NOT/);
  });

  it("default: undefined permissionLevel falls back to approve behavior at normalizePermissionLevel", () => {
    // When permissionLevel is missing/invalid, normalizePermissionLevel returns 'approve'.
    // Simulate by passing 'approve' directly (the fallback value assigned in heartbeat.ts).
    const result = injectPermissionAddendum("approve" as AgentPermissionLevel, "Some task prompt.");
    expect(result).toContain("create_approval");
    expect(result).toContain("approve");
  });
});
