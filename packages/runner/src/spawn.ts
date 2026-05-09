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
 * Result extraction: the LAST `run_complete` event (Claude wire-format
 * `result` type) carries the cost + sessionId. We snapshot it so the
 * caller can read it after the child exits. Kind name is provider-neutral
 * as of S7.1.b.1 — same payload shape, agnostic identifier.
 *
 * S7.1.a refactor (pure code-motion): Claude-specific helpers
 * (`buildClaudeArgs`, `parseStreamJsonLine`, `materializeInstructions`,
 * `extractClaudeFinalResult`) live in `./adapters/claude.ts`. This file
 * keeps the adapter-agnostic orchestration: process spawn, timeout
 * escalation (SIGTERM → SIGKILL), stdout/stderr line buffering, drain on
 * exit, instructions-tempfile cleanup. The dispatcher + handler interface
 * land in S7.1.b under `/council` review — out of scope for this ticket.
 * The public surface (`runClaude`, `buildClaudeArgs`, `parseStreamJsonLine`,
 * `SpawnArgs`, `SpawnResult`) is preserved unchanged.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { performance } from "node:perf_hooks";

import { makeEventId, type RunnerEvent } from "./api.js";
import {
  buildClaudeArgs,
  extractClaudeFinalResult,
  materializeInstructions,
  parseStreamJsonLine,
} from "./adapters/claude.js";

// Re-export the Claude-specific helpers from their new home so the
// long-standing public API in `index.ts` and `spawn-pure.test.ts` keeps
// resolving via `./spawn.js`. Pure code-motion: zero behavior change.
export { buildClaudeArgs, parseStreamJsonLine } from "./adapters/claude.js";

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
      if (evt.kind === "run_complete") {
        const snap = extractClaudeFinalResult(evt.payload);
        if (snap) finalResult = snap;
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
