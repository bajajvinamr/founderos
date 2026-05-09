/**
 * Pure-function tests for the spawn module — argv builder and stream-json
 * line parser. No actual child processes; those are exercised in M4.
 */

import { describe, it, expect } from "vitest";
import { buildClaudeArgs, parseStreamJsonLine } from "../spawn.js";

describe("buildClaudeArgs", () => {
  it("emits the canonical flag set with no overrides", () => {
    expect(buildClaudeArgs({})).toEqual([
      "--print",
      "-",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
  });

  it("threads --resume when sessionId is provided", () => {
    expect(buildClaudeArgs({ sessionId: "sess_abc" })).toContain("--resume");
    const argv = buildClaudeArgs({ sessionId: "sess_abc" });
    expect(argv[argv.indexOf("--resume") + 1]).toBe("sess_abc");
  });

  it("threads --model + --max-turns + --append-system-prompt-file + --add-dir", () => {
    const argv = buildClaudeArgs({
      model: "claude-opus-4-7",
      maxTurns: 8,
      instructionsFilePath: "/tmp/instructions.md",
      addDirs: ["/repo", "/repo/docs"],
    });
    expect(argv).toContain("--model");
    expect(argv).toContain("claude-opus-4-7");
    expect(argv).toContain("--max-turns");
    expect(argv).toContain("8");
    expect(argv).toContain("--append-system-prompt-file");
    expect(argv).toContain("/tmp/instructions.md");
    expect(argv.filter((a) => a === "--add-dir")).toHaveLength(2);
    expect(argv).toContain("/repo");
    expect(argv).toContain("/repo/docs");
  });

  it("ignores zero/negative max-turns (claude rejects those)", () => {
    expect(buildClaudeArgs({ maxTurns: 0 })).not.toContain("--max-turns");
    expect(buildClaudeArgs({ maxTurns: -1 })).not.toContain("--max-turns");
  });
});

describe("parseStreamJsonLine", () => {
  it("returns null for blank lines", () => {
    expect(parseStreamJsonLine("")).toBeNull();
    expect(parseStreamJsonLine("   \n")).toBeNull();
  });

  it("parses model_message from assistant/user/system types", () => {
    const evt = parseStreamJsonLine(JSON.stringify({ type: "assistant", message: { role: "assistant" } }));
    expect(evt?.kind).toBe("model_message");
    expect((evt?.payload as Record<string, unknown>).type).toBe("assistant");
  });

  it("parses tool_call", () => {
    const evt = parseStreamJsonLine(
      JSON.stringify({ type: "tool_use", name: "bash", input: { cmd: "ls" } }),
    );
    expect(evt?.kind).toBe("tool_call");
  });

  it("parses tool_result", () => {
    const evt = parseStreamJsonLine(JSON.stringify({ type: "tool_result", content: "ok" }));
    expect(evt?.kind).toBe("tool_result");
  });

  it("parses run_complete with cost + session_id intact", () => {
    const evt = parseStreamJsonLine(
      JSON.stringify({
        type: "result",
        session_id: "sess_after",
        total_cost_usd: 0.0123,
        is_error: false,
      }),
    );
    expect(evt?.kind).toBe("run_complete");
    const p = evt?.payload as Record<string, unknown>;
    expect(p.session_id).toBe("sess_after");
    expect(p.total_cost_usd).toBeCloseTo(0.0123);
  });

  it("falls through to stdout_line for non-JSON noise", () => {
    const evt = parseStreamJsonLine("Loading config...");
    expect(evt?.kind).toBe("stdout_line");
    expect(evt?.payload).toBe("Loading config...");
  });

  it("falls through to stdout_line for unknown JSON shapes (preserves raw payload)", () => {
    const evt = parseStreamJsonLine(JSON.stringify({ type: "unknown_future_kind", x: 1 }));
    expect(evt?.kind).toBe("stdout_line");
    expect((evt?.payload as Record<string, unknown>).type).toBe("unknown_future_kind");
  });
});
