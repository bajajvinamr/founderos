import { describe, it, expect } from "vitest";

/**
 * Family-mapping rules used by both the company-providers overview route
 * and the agent-provider badge UI. Locks the invariant that adapter types
 * map to a single consistent provider family.
 */
function family(adapter: string): "anthropic" | "openai" | "google" | "other" {
  if (adapter === "claude_local" || adapter === "claude_api") return "anthropic";
  if (adapter === "codex_local" || adapter === "openai_api") return "openai";
  if (adapter === "gemini_local") return "google";
  return "other";
}

function costEventProviderToFamily(provider: string): "anthropic" | "openai" | "google" | "other" {
  if (provider === "anthropic") return "anthropic";
  if (provider === "openai") return "openai";
  if (provider === "google" || provider === "gemini") return "google";
  return "other";
}

describe("adapter → family mapping", () => {
  it.each([
    ["claude_local", "anthropic"],
    ["claude_api", "anthropic"],
    ["codex_local", "openai"],
    ["openai_api", "openai"],
    ["gemini_local", "google"],
    ["cursor_local", "other"],
    ["opencode_local", "other"],
    ["openclaw_gateway", "other"],
    ["unknown_adapter", "other"],
  ])("%s → %s", (adapter, expected) => {
    expect(family(adapter)).toBe(expected);
  });
});

describe("cost_events.provider → family mapping", () => {
  it("maps 'gemini' AND 'google' both to google", () => {
    expect(costEventProviderToFamily("gemini")).toBe("google");
    expect(costEventProviderToFamily("google")).toBe("google");
  });

  it("falls through to 'other' for unknown providers", () => {
    expect(costEventProviderToFamily("cohere")).toBe("other");
    expect(costEventProviderToFamily("")).toBe("other");
  });
});
