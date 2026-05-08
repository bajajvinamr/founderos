import { describe, expect, it } from "vitest";
import { AGENT_ADAPTER_TYPES, acceptInviteSchema, createAgentSchema, updateAgentSchema } from "./index.js";

describe("dynamic adapter type validation schemas", () => {
  it("accepts external adapter types in create/update agent schemas", () => {
    expect(
      createAgentSchema.parse({
        name: "External Agent",
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");

    expect(
      updateAgentSchema.parse({
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");
  });

  it("still rejects blank adapter types", () => {
    expect(() =>
      createAgentSchema.parse({
        name: "Blank Adapter",
        adapterType: "   ",
      }),
    ).toThrow();
  });

  it("accepts external adapter types in invite acceptance schema", () => {
    expect(
      acceptInviteSchema.parse({
        requestType: "agent",
        agentName: "External Joiner",
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");
  });
});

describe("AGENT_ADAPTER_TYPES registry (PHASE-S7 §3)", () => {
  // Treat the registry as an array of known types. Membership = "asserted
  // known"; any string outside this list is an external adapter type that
  // plugins may register at runtime (see adapter-type.ts describe comment).
  const KNOWN_TYPES: ReadonlySet<string> = new Set(AGENT_ADAPTER_TYPES);
  const isKnownAdapterType = (t: string): boolean => KNOWN_TYPES.has(t);

  it("registers openai_api as a known adapter type", () => {
    expect(isKnownAdapterType("openai_api")).toBe(true);
  });

  it("keeps the existing CLI-execution adapters registered", () => {
    expect(isKnownAdapterType("claude_local")).toBe(true);
    expect(isKnownAdapterType("codex_local")).toBe(true);
    expect(isKnownAdapterType("gemini_local")).toBe(true);
    expect(isKnownAdapterType("opencode_local")).toBe(true);
    expect(isKnownAdapterType("pi_local")).toBe(true);
  });

  it("rejects nonsense adapter type values via the membership check", () => {
    expect(isKnownAdapterType("nonsense")).toBe(false);
    expect(isKnownAdapterType("")).toBe(false);
  });

  it("orders openai_api after codex_local and before gemini_local (TRD §3 family contiguity)", () => {
    // Family grouping is load-bearing: anthropic (claude_local), openai-codex
    // (codex_local), openai-direct (openai_api), google (gemini_local).
    // Tools that snapshot the array ordering depend on the FAMILY block
    // being contiguous and ordered — but NOT on strict adjacency. This
    // tolerates a future insertion inside the family (e.g. adding
    // codex_local_v2 between codex_local and openai_api). Per S7.A.6
    // council 2026-05-08 P4: assert relative ordering, not strict +1
    // adjacency, so we don't false-fail on benign reorderings.
    const codexIdx = AGENT_ADAPTER_TYPES.indexOf("codex_local");
    const openaiIdx = AGENT_ADAPTER_TYPES.indexOf("openai_api");
    const geminiIdx = AGENT_ADAPTER_TYPES.indexOf("gemini_local");

    expect(codexIdx).toBeGreaterThanOrEqual(0);
    expect(openaiIdx).toBeGreaterThanOrEqual(0);
    expect(geminiIdx).toBeGreaterThanOrEqual(0);
    // Family ordering: codex < openai < gemini.
    expect(openaiIdx).toBeGreaterThan(codexIdx);
    expect(geminiIdx).toBeGreaterThan(openaiIdx);
  });
});
