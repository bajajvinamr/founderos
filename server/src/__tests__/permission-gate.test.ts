import { describe, expect, it } from "vitest";
import { injectPermissionAddendum } from "../services/heartbeat.js";
import { evaluateToolCall, isSideEffectTool, buildPermissionDeniedPayload } from "@founderos/shared";
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

// ---------------------------------------------------------------------------
// Tool-gate integration tests (simulating gatedOnLog behaviour in heartbeat.ts)
//
// These tests simulate what happens when a JSONL chunk from adapter stdout
// is scanned for tool-use events and evaluated through the permission gate.
// The actual gatedOnLog closure in heartbeat.ts calls evaluateToolCall
// then logs tool_call_blocked / tool_call_needs_approval activities.
// We test the gate decisions here without the DB dependency.
// ---------------------------------------------------------------------------

/**
 * Simulate what gatedOnLog does: parse tool names from a claude stream-json
 * chunk and run them through evaluateToolCall.
 */
function simulateGatedOnLog(
  permissionLevel: AgentPermissionLevel,
  stdoutChunk: string,
): Array<{ toolName: string; decision: string; reason: string }> {
  const results: Array<{ toolName: string; decision: string; reason: string }> = [];
  for (const rawLine of stdoutChunk.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.startsWith("{")) continue;
    let event: Record<string, unknown> | null = null;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!event) continue;

    const toolNames: string[] = [];
    // Claude stream-json assistant message format
    if (event.type === "assistant") {
      const message = event.message as Record<string, unknown> | null;
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const block of content) {
        if (typeof block === "object" && block !== null) {
          const b = block as Record<string, unknown>;
          if (b.type === "tool_use" && typeof b.name === "string" && b.name) {
            toolNames.push(b.name);
          }
        }
      }
    }
    // Generic tool_use event
    if (event.type === "tool_use" && typeof event.name === "string" && event.name) {
      toolNames.push(event.name as string);
    }

    for (const toolName of toolNames) {
      const gateResult = evaluateToolCall({ permissionLevel, toolName });
      results.push({ toolName, decision: gateResult.decision, reason: gateResult.reason });
    }
  }
  return results;
}

describe("tool-gate: draft agent blocked from git_commit", () => {
  it("detects and blocks git_commit in JSONL stream", () => {
    const chunk = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "git_commit", input: { message: "feat: ship it" } }],
      },
    });
    const results = simulateGatedOnLog("draft", chunk);
    expect(results).toHaveLength(1);
    expect(results[0].toolName).toBe("git_commit");
    expect(results[0].decision).toBe("block");
    expect(results[0].reason).toBe("draft_side_effect");
  });

  it("allows read_file for draft agent", () => {
    const chunk = JSON.stringify({
      type: "tool_use",
      name: "read_file",
      input: { path: "/README.md" },
    });
    const results = simulateGatedOnLog("draft", chunk);
    expect(results).toHaveLength(1);
    expect(results[0].toolName).toBe("read_file");
    expect(results[0].decision).toBe("allow");
    expect(results[0].reason).toBe("ok");
  });
});

describe("tool-gate: autonomous agent can run git_commit", () => {
  it("allows git_commit for autonomous agent", () => {
    const chunk = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "git_commit", input: { message: "chore: bump version" } }],
      },
    });
    const results = simulateGatedOnLog("autonomous", chunk);
    expect(results).toHaveLength(1);
    expect(results[0].toolName).toBe("git_commit");
    expect(results[0].decision).toBe("allow");
    expect(results[0].reason).toBe("ok");
  });
});

describe("tool-gate: approve agent logs git_commit as needs_approval", () => {
  it("allows but flags git_commit with approve_log reason", () => {
    const chunk = JSON.stringify({
      type: "tool_use",
      name: "git_commit",
      input: { message: "fix: patch" },
    });
    const results = simulateGatedOnLog("approve", chunk);
    expect(results).toHaveLength(1);
    expect(results[0].toolName).toBe("git_commit");
    expect(results[0].decision).toBe("allow");
    expect(results[0].reason).toBe("approve_log");
  });
});

describe("tool-gate: multiple tool calls in one chunk", () => {
  it("blocks side-effect tools and allows read-only tools for draft", () => {
    const lines = [
      JSON.stringify({ type: "tool_use", name: "search_web", input: {} }),
      JSON.stringify({ type: "tool_use", name: "send_email", input: { to: "a@b.com" } }),
      JSON.stringify({ type: "tool_use", name: "read_file", input: { path: "/x" } }),
      JSON.stringify({ type: "tool_use", name: "slack_send", input: { channel: "c" } }),
    ].join("\n");

    const results = simulateGatedOnLog("draft", lines);
    expect(results).toHaveLength(4);

    const blocked = results.filter((r) => r.decision === "block");
    const allowed = results.filter((r) => r.decision === "allow");

    expect(blocked.map((r) => r.toolName).sort()).toEqual(["send_email", "slack_send"].sort());
    expect(allowed.map((r) => r.toolName).sort()).toEqual(["read_file", "search_web"].sort());
  });
});

describe("tool-gate: buildPermissionDeniedPayload structure", () => {
  it("returns correctly shaped payload for draft + git_commit", () => {
    const payload = buildPermissionDeniedPayload("draft", "git_commit");
    expect(payload.type).toBe("permission_denied");
    expect(payload.level).toBe("draft");
    expect(payload.tool).toBe("git_commit");
    expect(typeof payload.message).toBe("string");
    expect(payload.message.length).toBeGreaterThan(0);
  });
});

describe("tool-gate: isSideEffectTool coverage", () => {
  it("catches all expected patterns", () => {
    const sideEffects = [
      "git_commit", "git_push", "npm_publish", "deploy", "fly_deploy",
      "kubectl_apply", "docker_push", "gh_pr_merge", "gh_release",
      "slack_send", "slack_post", "send_email", "gmail_send",
      "stripe_charge", "payment_method", "subscribe_plan",
      "create_agent", "terminate_agent", "update_agent", "set_permission",
      "integration_create", "integration_delete", "oauth_revoke",
      "publish_post", "commit_changes", "push_branch", "release_version",
    ];
    for (const name of sideEffects) {
      expect(isSideEffectTool(name)).toBe(true);
    }
  });

  it("does not catch read-only patterns", () => {
    const readOnly = [
      "read_file", "list_issues", "search_web", "get_agent",
      "fetch_context", "describe_project", "list_agents",
    ];
    for (const name of readOnly) {
      expect(isSideEffectTool(name)).toBe(false);
    }
  });
});
