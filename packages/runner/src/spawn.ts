/**
 * Spawn `claude` CLI for a claimed runner job. Streams stream-json from
 * stdout, parses each line into a typed event, and emits events via the
 * caller's `onEvent` callback. The caller is responsible for batching and
 * shipping events back to the cloud (see api.ts appendEvents).
 *
 * Why we don't use `claude --output-format=stream-json` for everything:
 *   `claude --print -` accepts the prompt on stdin and writes mixed stdout —
 *   stream-json events when `--output-format=stream-json` is set, plain text
 *   otherwise. We always set stream-json so parsing is uniform. Lines that
 *   fail JSON.parse are surfaced as `stdout_line` raw text events (so noisy
 *   stderr output from claude's setup phase is still visible to ops).
 *
 * Result extraction: the LAST `claude_result` event (kind `result` in
 * stream-json terms) carries the cost + sessionId. We snapshot it so the
 * caller can read it after the child exits.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";

import { makeEventId, type RunnerEvent } from "./api.js";

export interface SpawnArgs {
  binary: string;
  prompt: string;
  sessionId?: string | null;
  model?: string | null;
  maxTurns?: number | null;
  /** Base64 contents of the agent's append-system-prompt file. */
  instructionsBase64?: string | null;
  /** Hard timeout — if claude doesn't exit by then, we SIGTERM then SIGKILL. */
  timeoutSec: number;
  /** Working directory for the spawned claude. Defaults to cwd. */
  cwd?: string;
  /** Optional --add-dir entries the cloud suggested. */
  addDirs?: string[];
}

export interface SpawnResult {
  exitCode: number;
  signal: string | null;
  elapsedSec: number;
  /** True iff we killed the process due to the timeout. */
  timedOut: boolean;
  /** Captured `result` event from stream-json — null if claude never emitted one. */
  finalResult: { sessionId?: string | null; costUsd?: number | null; raw: Record<string, unknown> } | null;
}

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
 * follows ADR-011 § "Event taxonomy":
 *   - `assistant` / `user` messages → claude_message
 *   - `tool_use` blocks → claude_tool_use
 *   - `tool_result` blocks → claude_tool_result
 *   - `result` (final stats) → claude_result
 *   - anything else → stdout_line (raw)
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
      kind: "claude_result",
      ts: new Date().toISOString(),
      payload: obj,
    };
  }
  if (type === "assistant" || type === "user" || type === "system") {
    return {
      eventId: makeEventId(),
      kind: "claude_message",
      ts: new Date().toISOString(),
      payload: obj,
    };
  }
  if (type === "tool_use") {
    return {
      eventId: makeEventId(),
      kind: "claude_tool_use",
      ts: new Date().toISOString(),
      payload: obj,
    };
  }
  if (type === "tool_result") {
    return {
      eventId: makeEventId(),
      kind: "claude_tool_result",
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
 * Run claude end-to-end. Streams events, enforces timeout, returns the
 * captured final result. Tests can substitute `spawnImpl` to run a mock
 * binary that prints scripted stream-json.
 */
export async function runClaude(
  args: SpawnArgs,
  hooks: {
    onEvent: (evt: RunnerEvent) => void | Promise<void>;
  },
  spawnImpl: typeof spawn = spawn,
): Promise<SpawnResult> {
  let cleanup: (() => Promise<void>) | null = null;
  let instructionsPath: string | null = null;

  if (args.instructionsBase64) {
    const m = await materializeInstructions(args.instructionsBase64);
    instructionsPath = m.path;
    cleanup = m.cleanup;
  }

  const argv = buildClaudeArgs({
    sessionId: args.sessionId,
    model: args.model,
    maxTurns: args.maxTurns,
    instructionsFilePath: instructionsPath,
    addDirs: args.addDirs,
  });

  const startedAt = performance.now();
  const child: ChildProcess = spawnImpl(args.binary, argv, {
    cwd: args.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  let timedOut = false;
  let finalResult: SpawnResult["finalResult"] = null;

  // Hard kill after 1.5x timeout if SIGTERM didn't land.
  const termTimer = setTimeout(() => {
    timedOut = true;
    if (!child.killed) child.kill("SIGTERM");
  }, args.timeoutSec * 1000);
  const killTimer = setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
  }, args.timeoutSec * 1000 * 1.5);

  // stdin: write the prompt then close.
  if (child.stdin) {
    child.stdin.write(args.prompt);
    child.stdin.end();
  }

  // Line-buffer stdout. claude emits one JSON object per line in
  // stream-json mode; partial lines accumulate until the next \n.
  let stdoutBuf = "";
  child.stdout?.setEncoding("utf-8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      const evt = parseStreamJsonLine(line);
      if (!evt) continue;
      if (evt.kind === "claude_result" && typeof evt.payload === "object" && evt.payload) {
        const p = evt.payload as Record<string, unknown>;
        finalResult = {
          sessionId: typeof p.session_id === "string" ? p.session_id : null,
          costUsd: typeof p.total_cost_usd === "number" ? p.total_cost_usd : null,
          raw: p,
        };
      }
      void hooks.onEvent(evt);
    }
  });

  // stderr: surface as raw stderr_line events. Don't try to parse —
  // claude's stderr is human-readable diagnostics, not stream-json.
  let stderrBuf = "";
  child.stderr?.setEncoding("utf-8");
  child.stderr?.on("data", (chunk: string) => {
    stderrBuf += chunk;
    let nl: number;
    while ((nl = stderrBuf.indexOf("\n")) >= 0) {
      const line = stderrBuf.slice(0, nl);
      stderrBuf = stderrBuf.slice(nl + 1);
      if (!line.trim()) continue;
      void hooks.onEvent({
        eventId: makeEventId(),
        kind: "stderr_line",
        ts: new Date().toISOString(),
        payload: line,
      });
    }
  });

  const exit = await new Promise<{ code: number; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code: code ?? -1, signal }));
    child.once("error", () => resolve({ code: -1, signal: null }));
  });

  // Drain any trailing partial line.
  if (stdoutBuf.trim()) {
    const evt = parseStreamJsonLine(stdoutBuf);
    if (evt) await hooks.onEvent(evt);
  }
  if (stderrBuf.trim()) {
    await hooks.onEvent({
      eventId: makeEventId(),
      kind: "stderr_line",
      ts: new Date().toISOString(),
      payload: stderrBuf,
    });
  }

  clearTimeout(termTimer);
  clearTimeout(killTimer);
  if (cleanup) await cleanup();

  // Tiny sleep to let any straggler stream events flush through onEvent.
  await sleep(10);

  return {
    exitCode: exit.code,
    signal: exit.signal,
    elapsedSec: (performance.now() - startedAt) / 1000,
    timedOut,
    finalResult,
  };
}
