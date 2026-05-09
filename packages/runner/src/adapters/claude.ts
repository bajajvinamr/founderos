/**
 * Claude-specific spawn helpers — extracted from `../spawn.ts` as a pure
 * code-motion seam for S7.1 (the multi-adapter dispatcher). This module
 * intentionally exports plain functions, NOT an `AdapterSpawnHandler`
 * implementation: the dispatcher + interface land in S7.1.b under
 * `/council` review. Today's job is just isolating the Claude-shaped
 * surfaces so the rest of `spawn.ts` is adapter-agnostic.
 *
 * Surfaces moved here:
 *   - argv builder (`--print -`, `--output-format=stream-json`, etc.)
 *   - stream-json line → `RunnerEvent` parser (Claude's event taxonomy)
 *   - base64 instructions → tempfile materializer
 *   - final-result extraction (`session_id` + `total_cost_usd` from the
 *     terminal `result` event)
 *
 * Behavior is identical to the prior inline implementation in `spawn.ts`;
 * the existing `spawn-pure.test.ts` continues to exercise the public
 * re-exports without modification.
 */

import { writeFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { makeEventId, type RunnerEvent } from "../api.js";

/**
 * Build the claude CLI argv. Kept pure so it's unit-testable without
 * actually spawning a child.
 */
export function buildClaudeArgs(args: {
  sessionId?: string | null;
  model?: string | null;
  maxTurns?: number | null;
  instructionsFilePath?: string | null;
  addDirs?: string[];
}): string[] {
  const argv = ["--print", "-", "--output-format", "stream-json", "--verbose"];
  if (args.sessionId) {
    argv.push("--resume", args.sessionId);
  }
  if (args.model) {
    argv.push("--model", args.model);
  }
  if (typeof args.maxTurns === "number" && args.maxTurns > 0) {
    argv.push("--max-turns", String(args.maxTurns));
  }
  if (args.instructionsFilePath) {
    argv.push("--append-system-prompt-file", args.instructionsFilePath);
  }
  for (const dir of args.addDirs ?? []) {
    argv.push("--add-dir", dir);
  }
  return argv;
}

/**
 * Parse one line of claude stream-json into a RunnerEvent. The mapping
 * follows ADR-011 § "Event taxonomy", neutralized in S7.1.b.1:
 *   - `assistant` / `user` / `system` messages → model_message
 *   - `tool_use` blocks → tool_call
 *   - `tool_result` blocks → tool_result
 *   - `result` (final stats) → run_complete
 *   - anything else → stdout_line (raw)
 *
 * The Claude wire-format `type` strings stay Claude-shaped (the CLI emits
 * Claude-shaped JSON) — only the emitted runner-internal `kind` is neutral.
 */
export function parseStreamJsonLine(line: string): RunnerEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Try strict JSON first.
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      eventId: makeEventId(),
      kind: "stdout_line",
      ts: new Date().toISOString(),
      payload: trimmed,
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      eventId: makeEventId(),
      kind: "stdout_line",
      ts: new Date().toISOString(),
      payload: trimmed,
    };
  }

  const obj = parsed as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "";

  if (type === "result") {
    return {
      eventId: makeEventId(),
      kind: "run_complete",
      ts: new Date().toISOString(),
      payload: obj,
    };
  }
  if (type === "assistant" || type === "user" || type === "system") {
    return {
      eventId: makeEventId(),
      kind: "model_message",
      ts: new Date().toISOString(),
      payload: obj,
    };
  }
  if (type === "tool_use") {
    return {
      eventId: makeEventId(),
      kind: "tool_call",
      ts: new Date().toISOString(),
      payload: obj,
    };
  }
  if (type === "tool_result") {
    return {
      eventId: makeEventId(),
      kind: "tool_result",
      ts: new Date().toISOString(),
      payload: obj,
    };
  }
  return {
    eventId: makeEventId(),
    kind: "stdout_line",
    ts: new Date().toISOString(),
    payload: obj,
  };
}

/**
 * Materialize the base64 instructions blob to a tempfile so claude can
 * `--append-system-prompt-file` it. Returns the path; caller is responsible
 * for cleanup (we surface the cleanup function to keep this composable).
 */
export async function materializeInstructions(
  base64: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "founderos-runner-"));
  const filePath = path.join(dir, "instructions.md");
  const buf = Buffer.from(base64, "base64");
  await writeFile(filePath, buf);
  return {
    path: filePath,
    cleanup: async () => {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * Snapshot of the terminal `result` event. The dispatcher's stdout reader
 * calls this on every run_complete event so the LATEST value wins (matches
 * the prior inline behavior at the previous spawn.ts:252-258).
 */
export interface ClaudeFinalResult {
  sessionId: string | null;
  costUsd: number | null;
  raw: Record<string, unknown>;
}

/**
 * Pull `session_id` + `total_cost_usd` out of a parsed `run_complete`
 * event payload (Claude wire-format `result` type). Returns null if the
 * payload isn't a usable object.
 *
 * Pure — no I/O. Mirrors the field-extraction logic that previously lived
 * inline in `runClaude`'s stdout handler.
 */
export function extractClaudeFinalResult(
  payload: unknown,
): ClaudeFinalResult | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  return {
    sessionId: typeof p.session_id === "string" ? p.session_id : null,
    costUsd: typeof p.total_cost_usd === "number" ? p.total_cost_usd : null,
    raw: p,
  };
}
