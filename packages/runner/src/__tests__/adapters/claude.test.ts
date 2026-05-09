/**
 * Unit tests for `src/adapters/claude.ts` — the Claude-specific surfaces
 * extracted from `spawn.ts` in S7.1.a (pure code-motion, no behavior
 * change). The argv builder and stream-json parser are also covered
 * end-to-end via `spawn-pure.test.ts` against the `./spawn.js`
 * re-exports; this file additionally pins the new helpers
 * (`materializeInstructions`, `extractClaudeFinalResult`) that are
 * imported directly from the adapter module.
 *
 * No child processes — these are pure-function / fs-only checks.
 */

import { describe, it, expect } from "vitest";
import { readFile, stat } from "node:fs/promises";

import {
  buildClaudeArgs,
  parseStreamJsonLine,
  materializeInstructions,
  extractClaudeFinalResult,
} from "../../adapters/claude.js";

describe("adapters/claude — buildClaudeArgs", () => {
  it("emits the canonical flag set with no overrides", () => {
    expect(buildClaudeArgs({})).toEqual([
      "--print",
      "-",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
  });

  it("threads --resume / --model / --max-turns / --append-system-prompt-file / --add-dir", () => {
    const argv = buildClaudeArgs({
      sessionId: "sess_abc",
      model: "claude-opus-4-7",
      maxTurns: 8,
      instructionsFilePath: "/tmp/instructions.md",
      addDirs: ["/repo", "/repo/docs"],
    });
    expect(argv).toContain("--resume");
    expect(argv[argv.indexOf("--resume") + 1]).toBe("sess_abc");
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

describe("adapters/claude — parseStreamJsonLine", () => {
  it("returns null for blank lines", () => {
    expect(parseStreamJsonLine("")).toBeNull();
    expect(parseStreamJsonLine("   \n")).toBeNull();
  });

  it("classifies the canonical Claude stream-json event types", () => {
    expect(
      parseStreamJsonLine(JSON.stringify({ type: "assistant", message: {} }))?.kind,
    ).toBe("claude_message");
    expect(
      parseStreamJsonLine(JSON.stringify({ type: "user", message: {} }))?.kind,
    ).toBe("claude_message");
    expect(
      parseStreamJsonLine(JSON.stringify({ type: "system", message: {} }))?.kind,
    ).toBe("claude_message");
    expect(parseStreamJsonLine(JSON.stringify({ type: "tool_use" }))?.kind).toBe(
      "claude_tool_use",
    );
    expect(parseStreamJsonLine(JSON.stringify({ type: "tool_result" }))?.kind).toBe(
      "claude_tool_result",
    );
    expect(parseStreamJsonLine(JSON.stringify({ type: "result" }))?.kind).toBe(
      "claude_result",
    );
  });

  it("falls through to stdout_line for non-JSON noise and unknown shapes", () => {
    expect(parseStreamJsonLine("Loading config...")?.kind).toBe("stdout_line");
    expect(
      parseStreamJsonLine(JSON.stringify({ type: "unknown_future_kind", x: 1 }))?.kind,
    ).toBe("stdout_line");
  });
});

describe("adapters/claude — materializeInstructions", () => {
  it("writes the decoded base64 payload to a tempfile and cleans it up", async () => {
    const original = "# Be concise.\nRespond in JSON.";
    const base64 = Buffer.from(original, "utf-8").toString("base64");

    const { path: filePath, cleanup } = await materializeInstructions(base64);

    // File exists with the decoded contents.
    const written = await readFile(filePath, "utf-8");
    expect(written).toBe(original);

    // Cleanup removes it.
    await cleanup();
    await expect(stat(filePath)).rejects.toThrow();
  });

  it("cleanup is best-effort — calling it twice does not throw", async () => {
    const { cleanup } = await materializeInstructions(
      Buffer.from("hi", "utf-8").toString("base64"),
    );
    await cleanup();
    await expect(cleanup()).resolves.toBeUndefined();
  });
});

describe("adapters/claude — extractClaudeFinalResult", () => {
  it("returns null when the payload is not a usable object", () => {
    expect(extractClaudeFinalResult(null)).toBeNull();
    expect(extractClaudeFinalResult(undefined)).toBeNull();
    expect(extractClaudeFinalResult("string")).toBeNull();
    expect(extractClaudeFinalResult(42)).toBeNull();
  });

  it("captures session_id + total_cost_usd from the terminal result event", () => {
    const snap = extractClaudeFinalResult({
      type: "result",
      session_id: "sess_after",
      total_cost_usd: 0.0123,
      is_error: false,
    });
    expect(snap?.sessionId).toBe("sess_after");
    expect(snap?.costUsd).toBeCloseTo(0.0123);
    expect(snap?.raw.type).toBe("result");
  });

  it("nulls fields that are absent or wrong-typed but still snapshots raw", () => {
    const snap = extractClaudeFinalResult({
      type: "result",
      session_id: 42, // wrong type
      // total_cost_usd missing
    });
    expect(snap?.sessionId).toBeNull();
    expect(snap?.costUsd).toBeNull();
    expect((snap?.raw as Record<string, unknown>).session_id).toBe(42);
  });
});
