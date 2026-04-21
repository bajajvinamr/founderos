import { describe, expect, it } from "vitest";
import {
  evaluateToolCall,
  isSideEffectTool,
  buildPermissionDeniedPayload,
} from "./permission-tool-gate.js";
import type { AgentPermissionLevel } from "../constants.js";

// ---------------------------------------------------------------------------
// isSideEffectTool
// ---------------------------------------------------------------------------

describe("isSideEffectTool", () => {
  it("returns true for exact side-effect tool names", () => {
    expect(isSideEffectTool("git_commit")).toBe(true);
    expect(isSideEffectTool("git_push")).toBe(true);
    expect(isSideEffectTool("send_email")).toBe(true);
    expect(isSideEffectTool("slack_send")).toBe(true);
    expect(isSideEffectTool("stripe_charge")).toBe(true);
    expect(isSideEffectTool("deploy_to_prod")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isSideEffectTool("GIT_COMMIT")).toBe(true);
    expect(isSideEffectTool("Slack_Send")).toBe(true);
    expect(isSideEffectTool("STRIPE_BILLING")).toBe(true);
  });

  it("returns true for substring matches", () => {
    expect(isSideEffectTool("mcp_git_commit_tool")).toBe(true);
    expect(isSideEffectTool("custom_stripe_charge")).toBe(true);
    expect(isSideEffectTool("do_deploy_now")).toBe(true);
  });

  it("returns false for read-only tool names", () => {
    expect(isSideEffectTool("read_file")).toBe(false);
    expect(isSideEffectTool("list_issues")).toBe(false);
    expect(isSideEffectTool("search_web")).toBe(false);
    expect(isSideEffectTool("get_agent")).toBe(false);
    expect(isSideEffectTool("fetch_context")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isSideEffectTool("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateToolCall — observe level
// ---------------------------------------------------------------------------

describe("evaluateToolCall — observe", () => {
  const level = "observe" as AgentPermissionLevel;

  it("blocks read-only tools", () => {
    const result = evaluateToolCall({ permissionLevel: level, toolName: "read_file" });
    expect(result.decision).toBe("block");
    expect(result.reason).toBe("observe_level");
  });

  it("blocks side-effect tools", () => {
    const result = evaluateToolCall({ permissionLevel: level, toolName: "git_commit" });
    expect(result.decision).toBe("block");
    expect(result.reason).toBe("observe_level");
  });

  it("blocks all tools including unknown names", () => {
    const result = evaluateToolCall({ permissionLevel: level, toolName: "totally_unknown_tool" });
    expect(result.decision).toBe("block");
    expect(result.reason).toBe("observe_level");
  });
});

// ---------------------------------------------------------------------------
// evaluateToolCall — draft level
// ---------------------------------------------------------------------------

describe("evaluateToolCall — draft", () => {
  const level = "draft" as AgentPermissionLevel;

  it("blocks git_commit", () => {
    const result = evaluateToolCall({ permissionLevel: level, toolName: "git_commit" });
    expect(result.decision).toBe("block");
    expect(result.reason).toBe("draft_side_effect");
    expect(result.message).toContain("Draft mode");
  });

  it("blocks send_email", () => {
    const result = evaluateToolCall({ permissionLevel: level, toolName: "send_email" });
    expect(result.decision).toBe("block");
    expect(result.reason).toBe("draft_side_effect");
  });

  it("blocks slack_send", () => {
    const result = evaluateToolCall({ permissionLevel: level, toolName: "slack_send" });
    expect(result.decision).toBe("block");
    expect(result.reason).toBe("draft_side_effect");
  });

  it("blocks stripe_charge", () => {
    const result = evaluateToolCall({ permissionLevel: level, toolName: "stripe_charge" });
    expect(result.decision).toBe("block");
    expect(result.reason).toBe("draft_side_effect");
  });

  it("allows read_file", () => {
    const result = evaluateToolCall({ permissionLevel: level, toolName: "read_file" });
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("ok");
  });

  it("allows list_issues", () => {
    const result = evaluateToolCall({ permissionLevel: level, toolName: "list_issues" });
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("ok");
  });

  it("allows search_web", () => {
    const result = evaluateToolCall({ permissionLevel: level, toolName: "search_web" });
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("ok");
  });

  it("allows unknown tool name (not side-effect by default)", () => {
    const result = evaluateToolCall({ permissionLevel: level, toolName: "totally_unknown_tool" });
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("ok");
  });

  it("allows empty tool name", () => {
    const result = evaluateToolCall({ permissionLevel: level, toolName: "" });
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// evaluateToolCall — approve level
// ---------------------------------------------------------------------------

describe("evaluateToolCall — approve", () => {
  const level = "approve" as AgentPermissionLevel;

  it("allows side-effect tool with approve_log reason", () => {
    const result = evaluateToolCall({ permissionLevel: level, toolName: "git_commit" });
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("approve_log");
    expect(result.message).toContain("logged for audit");
  });

  it("allows non-side-effect tool with ok reason", () => {
    const result = evaluateToolCall({ permissionLevel: level, toolName: "read_file" });
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// evaluateToolCall — autonomous level
// ---------------------------------------------------------------------------

describe("evaluateToolCall — autonomous", () => {
  const level = "autonomous" as AgentPermissionLevel;

  it("allows side-effect tools", () => {
    const result = evaluateToolCall({ permissionLevel: level, toolName: "git_commit" });
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("ok");
  });

  it("allows all tools including send_email, stripe", () => {
    expect(evaluateToolCall({ permissionLevel: level, toolName: "send_email" }).decision).toBe("allow");
    expect(evaluateToolCall({ permissionLevel: level, toolName: "stripe_charge" }).decision).toBe("allow");
    expect(evaluateToolCall({ permissionLevel: level, toolName: "deploy" }).decision).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("evaluateToolCall — edge cases", () => {
  it("empty tool name is allowed by default across all levels (unknown ≠ side-effect)", () => {
    // Empty tool name short-circuits before permission level check — allow by default.
    // Rationale: we cannot classify an unnamed call as a side-effect, so we
    // err on the side of allowing rather than blocking valid but unnamed tools.
    for (const level of ["observe", "draft", "approve", "autonomous"] as AgentPermissionLevel[]) {
      const result = evaluateToolCall({ permissionLevel: level, toolName: "" });
      expect(result.decision).toBe("allow");
    }
  });

  it("toolInput is optional and does not affect the decision", () => {
    const withInput = evaluateToolCall({
      permissionLevel: "draft",
      toolName: "git_commit",
      toolInput: { message: "test commit" },
    });
    const withoutInput = evaluateToolCall({
      permissionLevel: "draft",
      toolName: "git_commit",
    });
    expect(withInput.decision).toBe(withoutInput.decision);
    expect(withInput.reason).toBe(withoutInput.reason);
  });
});

// ---------------------------------------------------------------------------
// buildPermissionDeniedPayload
// ---------------------------------------------------------------------------

describe("buildPermissionDeniedPayload", () => {
  it("returns structured payload for draft level", () => {
    const payload = buildPermissionDeniedPayload("draft", "git_commit");
    expect(payload.type).toBe("permission_denied");
    expect(payload.level).toBe("draft");
    expect(payload.tool).toBe("git_commit");
    expect(payload.message).toContain("Draft mode");
  });
});
