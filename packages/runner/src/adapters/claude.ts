/**
 * Claude-specific spawn helpers — extracted from `../spawn.ts` as a pure
 * code-motion seam in S7.1.a (no behavior change). S7.1.b.2 wraps the
 * helpers in a {@link SubprocessAdapter} value (`claudeLocalAdapter`)
 * that the dispatcher can consume directly. The plain helper functions
 * are still exported for backwards compatibility — `spawn.ts` and
 * `spawn-pure.test.ts` continue to import them.
 *
 * Surfaces moved here in S7.1.a:
 *   - argv builder (`--print -`, `--output-format=stream-json`, etc.)
 *   - stream-json line → `RunnerEvent` parser (Claude's event taxonomy)
 *   - base64 instructions → tempfile materializer
 *   - final-result extraction (`session_id` + `total_cost_usd` from the
 *     terminal `result` event)
 *
 * Surfaces added here in S7.1.b.2:
 *   - {@link claudeLocalAdapter} — a `SubprocessAdapter` value composed
 *     from the helpers above plus the new `environmentChecks`, `run`, and
 *     `interpretFailure` methods required by the redesigned interface.
 *     The dispatcher (S7.1.b.3) will consume this via the registry in
 *     `./index.ts`.
 *
 * S7.1.c.1 — `run()` is now wired end-to-end. The lifecycle previously
 * living in `spawn.ts:runClaude` (process spawn, stdout/stderr line
 * buffering, SIGTERM→SIGKILL timeout escalation, instructions tempfile
 * cleanup, final-result snapshot) is ported into the AsyncGenerator
 * implementation below. `runClaude` itself is preserved unchanged so the
 * legacy direct-spawn path in `main.ts` (active when a `spawnFn` test seam
 * is supplied) keeps working bit-for-bit.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import os from "node:os";

import { makeEventId, type RunnerEvent } from "../api.js";
import type {
  AdapterFailure,
  BuildArgsContext,
  EnvironmentCheckResult,
  EnvironmentContext,
  InterpretedFailure,
  RunContext,
  RunResult,
  SubprocessAdapter,
} from "../handlers/types.js";

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

// ---------------------------------------------------------------------------
// SubprocessAdapter value — S7.1.b.2.
// ---------------------------------------------------------------------------

/**
 * `claude_local` adapter, exposed as a {@link SubprocessAdapter} value the
 * dispatcher can consume from the registry. Composes the pure helpers
 * (`buildClaudeArgs`, `parseStreamJsonLine`, `extractClaudeFinalResult`,
 * `materializeInstructions`) into the new interface methods.
 *
 * `run()` is intentionally a placeholder until S7.1.b.3 folds the spawn
 * lifecycle in (see file header). It compiles against the interface so
 * the registry exhaustiveness check in `./index.ts` is meaningful today.
 */
export const claudeLocalAdapter: SubprocessAdapter = {
  type: "claude_local",
  transport: "subprocess",
  defaultBinary: "claude",

  /**
   * Claude has no pre-flight env requirement beyond the binary being
   * resolvable on PATH (which is checked at spawn time, not here). When
   * `authMode` is `subscription`, claude reads `~/.claude/credentials.json`
   * itself; when `api_key`, the dispatcher injects `ANTHROPIC_API_KEY`
   * into the env. Neither is observable from this layer without a probe.
   */
  async environmentChecks(_ctx: EnvironmentContext): Promise<EnvironmentCheckResult> {
    return { ok: true };
  },

  buildArgs(ctx: BuildArgsContext): string[] {
    const cfg = ctx.adapterConfig;
    const model =
      typeof cfg["model"] === "string" || cfg["model"] === null ? (cfg["model"] as string | null) : null;
    const maxTurns = typeof cfg["maxTurns"] === "number" ? (cfg["maxTurns"] as number) : null;
    const addDirs = Array.isArray(cfg["addDirs"]) ? (cfg["addDirs"] as string[]) : undefined;
    return buildClaudeArgs({
      sessionId: ctx.sessionId ?? null,
      model,
      maxTurns,
      instructionsFilePath: ctx.instructionsFilePath,
      addDirs,
    });
  },

  /**
   * Claude reads the prompt from stdin (`--print -`). Write + end the
   * stream; resolve once the OS has acknowledged the write. Errors from
   * the underlying socket reject the returned promise — the dispatcher
   * routes those through `interpretFailure`.
   */
  async promptTransport(child: ChildProcess, prompt: string): Promise<void> {
    if (!child.stdin) {
      throw new Error("claude_local: child has no stdin (cannot transport prompt)");
    }
    await new Promise<void>((resolve, reject) => {
      child.stdin!.write(prompt, (err) => {
        if (err) {
          reject(err);
          return;
        }
        child.stdin!.end(() => resolve());
      });
    });
  },

  /**
   * Run claude end-to-end as an `AsyncGenerator<RunnerEvent, RunResult, void>`.
   *
   * Lifecycle ported from `spawn.ts:runClaude` (S7.1.c.1):
   *   1. Materialize the base64 instructions blob to a tempfile (when set).
   *   2. Build argv via {@link buildClaudeArgs} and spawn the binary.
   *   3. Pipe the prompt via {@link claudeLocalAdapter.promptTransport}.
   *   4. Line-buffer stdout, parse each line via {@link parseStreamJsonLine},
   *      and `yield` every produced {@link RunnerEvent} immediately. Snapshot
   *      the latest `run_complete` payload so cost + sessionId land on the
   *      terminal {@link RunResult}.
   *   5. Line-buffer stderr → emit `stderr_line` events (raw — claude's
   *      stderr is human-readable diagnostics, not stream-json).
   *   6. Honor `signal.aborted` AND the soft/hard timeout escalation
   *      (SIGTERM at `timeoutSec`, SIGKILL at 1.5x). Both routes resolve
   *      to a non-throwing terminal status — the dispatcher consumes the
   *      generator's return value, not exception state.
   *
   * Status mapping — preserved bit-for-bit from `runViaLegacy` so the V1
   * vs V2 paths produce the same `CompletionBody`:
   *   - exit 0, no abort, no timeout      → "completed"
   *   - signal.aborted (user cancel)      → "cancelled" (carries SIGTERM/SIGKILL)
   *   - timeout fired (T or 1.5T)         → "failed" with errorMessage="runner timed out"
   *   - non-zero exit                     → "failed" via `interpretFailure`
   *
   * Cleanup (instructions tempfile, line-buffer drain) runs in a `finally`
   * so a thrown error during `yield` (consumer threw, generator aborted)
   * still tears down the child + tempfile — matches `spawn.ts:188`.
   */
  async *run(ctx: RunContext, signal: AbortSignal): AsyncGenerator<RunnerEvent, RunResult, void> {
    const cfg = ctx.adapterConfig;
    const binary =
      typeof cfg["binary"] === "string" && cfg["binary"].length > 0
        ? (cfg["binary"] as string)
        : claudeLocalAdapter.defaultBinary;
    const instructionsBase64 =
      typeof cfg["instructionsFileContent"] === "string"
        ? (cfg["instructionsFileContent"] as string)
        : null;

    let cleanup: (() => Promise<void>) | null = null;
    let instructionsPath: string | null = null;
    if (instructionsBase64) {
      const m = await materializeInstructions(instructionsBase64);
      instructionsPath = m.path;
      cleanup = m.cleanup;
    }

    // Build argv via the adapter's own buildArgs seam — same shape as the
    // legacy path's `buildClaudeArgs` call but routed through the contract
    // method so unit tests can pin per-provider argv via the public API.
    const argv = claudeLocalAdapter.buildArgs({
      prompt: ctx.prompt,
      sessionId: ctx.sessionId ?? null,
      authMode: ctx.authMode,
      workdir: ctx.workdir,
      adapterConfig: ctx.adapterConfig,
      instructionsFilePath: instructionsPath,
    });

    const startedAt = performance.now();
    const child: ChildProcess = nodeSpawn(binary, argv, {
      cwd: ctx.workdir,
      stdio: ["pipe", "pipe", "pipe"],
      env: ctx.env,
    });

    let timedOut = false;
    let cancelled = false;
    let finalResult: ClaudeFinalResult | null = null;

    // Soft + hard timeout, parity with `spawn.ts:113-119`. Hard kill after
    // 1.5x if SIGTERM didn't land. The dispatcher's AbortController only
    // fires on user cancel today (S7.1.c notes); the adapter owns its own
    // timeout escalation to keep behavior identical to `runClaude`.
    const termTimer: NodeJS.Timeout = setTimeout(() => {
      timedOut = true;
      if (!child.killed) child.kill("SIGTERM");
    }, ctx.timeoutSec * 1000);
    const killTimer: NodeJS.Timeout = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, ctx.timeoutSec * 1000 * 1.5);

    // Cancellation: forward the dispatcher's AbortSignal as a SIGTERM →
    // SIGKILL escalation. Same pattern as the timeout, but the cancelled
    // flag steers the terminal status to "cancelled" rather than "failed".
    const onAbort = () => {
      cancelled = true;
      if (!child.killed) child.kill("SIGTERM");
      // Hard kill if SIGTERM is ignored. 200ms grace matches the existing
      // SIGTERM-then-SIGKILL pattern in `spawn.ts` (timer-driven there;
      // signal-driven here).
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 200).unref();
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // Outbound event queue + producer/consumer signalling. Stdout/stderr
    // listeners push parsed events; the generator body awaits a "ready"
    // promise, drains the queue, yields each event, and re-arms. This
    // preserves the streaming semantics from `runClaude` (events flushed as
    // they arrive, not buffered until exit) while staying inside the
    // AsyncGenerator contract.
    const eventQueue: RunnerEvent[] = [];
    type ExitInfo = { code: number; signal: NodeJS.Signals | null };
    // Holder so TS doesn't narrow the field to `never` based on its
    // initializer — closure callbacks below mutate `exitState.value`.
    const exitState: { value: ExitInfo | null } = { value: null };
    let resolveReady: (() => void) | null = null;
    let readyPromise = new Promise<void>((r) => {
      resolveReady = r;
    });
    const ping = () => {
      if (resolveReady) {
        const r = resolveReady;
        resolveReady = null;
        r();
      }
    };

    // stdin: write the prompt then close. Errors propagate to interpretFailure
    // via the exit handler — promptTransport rejecting before the child has
    // even produced output is rare (the OS rejects the write only on a
    // closed pipe, which means spawn already failed).
    void claudeLocalAdapter
      .promptTransport(child, ctx.prompt)
      .catch(() => {
        /* surface via exit code; stderr_line events will carry the cause. */
      });

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
        eventQueue.push(evt);
        ping();
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
        eventQueue.push({
          eventId: makeEventId(),
          kind: "stderr_line",
          ts: new Date().toISOString(),
          payload: line,
        });
        ping();
      }
    });

    child.once("exit", (code, sig) => {
      exitState.value = { code: code ?? -1, signal: sig };
      ping();
    });
    child.once("error", () => {
      exitState.value = { code: -1, signal: null };
      ping();
    });

    try {
      // Drain loop: wait → flush queue → yield each → re-arm. Exit when the
      // child has signalled exit AND the queue is empty (so no late events
      // are dropped between the exit fire and the consumer-side yield).
      while (true) {
        if (eventQueue.length === 0) {
          if (exitState.value) break;
          await readyPromise;
          // Re-arm before draining so any push between drain and re-arm
          // wakes the next iteration.
          readyPromise = new Promise<void>((r) => {
            resolveReady = r;
          });
        }
        // Drain everything currently queued before re-checking exit.
        while (eventQueue.length > 0) {
          const evt = eventQueue.shift()!;
          yield evt;
        }
      }

      // Drain trailing partial line(s) — matches `spawn.ts:173-184`.
      if (stdoutBuf.trim()) {
        const evt = parseStreamJsonLine(stdoutBuf);
        if (evt) {
          if (evt.kind === "run_complete") {
            const snap = extractClaudeFinalResult(evt.payload);
            if (snap) finalResult = snap;
          }
          yield evt;
        }
      }
      if (stderrBuf.trim()) {
        yield {
          eventId: makeEventId(),
          kind: "stderr_line",
          ts: new Date().toISOString(),
          payload: stderrBuf,
        };
      }

      const elapsedSec = (performance.now() - startedAt) / 1000;
      const exitCode = exitState.value?.code ?? -1;
      const sigName = exitState.value?.signal ?? null;

      // Status assembly — preserved verbatim from `runViaLegacy`'s mapping
      // (main.ts:336-354). Cancellation has highest priority so a user-
      // cancel mid-timeout still surfaces as "cancelled" rather than
      // "failed/timeout".
      if (cancelled) {
        return {
          status: "cancelled",
          elapsedSec,
          exitCode,
          signal: sigName,
          costUsd: finalResult?.costUsd ?? null,
          sessionId: finalResult?.sessionId ?? null,
          errorMessage: null,
        };
      }
      if (timedOut) {
        return {
          status: "failed",
          elapsedSec,
          exitCode,
          signal: sigName,
          costUsd: finalResult?.costUsd ?? null,
          sessionId: finalResult?.sessionId ?? null,
          errorMessage: "runner timed out",
        };
      }
      if (exitCode === 0) {
        return {
          status: "completed",
          elapsedSec,
          exitCode,
          signal: sigName,
          costUsd: finalResult?.costUsd ?? null,
          sessionId: finalResult?.sessionId ?? null,
          errorMessage: null,
        };
      }
      const interpreted = claudeLocalAdapter.interpretFailure({
        exitCode,
        signal: sigName,
      });
      return {
        status: "failed",
        elapsedSec,
        exitCode,
        signal: sigName,
        costUsd: finalResult?.costUsd ?? null,
        sessionId: finalResult?.sessionId ?? null,
        errorMessage: interpreted.humanMessage,
      };
    } finally {
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      // Best-effort: if the generator is closed early (consumer threw or
      // called .return), make sure the child doesn't outlive us.
      if (!exitState.value && !child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already exited; ignore */
        }
      }
      if (cleanup) {
        await cleanup().catch(() => {
          /* tempfile cleanup is best-effort */
        });
      }
    }
  },

  /**
   * Translate claude exit codes + signals to the dispatcher's machine-
   * readable retry semantics. Claude's stable codes (from the CLI README):
   *   0       — success
   *   1       — generic error (often auth or model error)
   *   124     — POSIX timeout (we usually hit our own SIGKILL first)
   *   130     — SIGINT (cancellation)
   *   137     — SIGKILL (our hard timeout)
   *   143     — SIGTERM (our soft timeout)
   *
   * 1 is intentionally classified `unknown` rather than `auth_failed` —
   * we cannot disambiguate auth-vs-model from the exit code alone, and
   * misclassifying a model-blocked-by-safety run as "auth_failed" would
   * trigger an erroneous credentials-rotation alert.
   */
  interpretFailure(failure: AdapterFailure): InterpretedFailure {
    const { exitCode, signal, error } = failure;
    if (signal === "SIGKILL" || exitCode === 137) {
      return {
        errorCode: "timeout",
        retryable: true,
        humanMessage: "claude was killed after exceeding the hard timeout (1.5x the configured timeoutSec).",
      };
    }
    if (signal === "SIGTERM" || exitCode === 143) {
      return {
        errorCode: "timeout",
        retryable: true,
        humanMessage: "claude was terminated after exceeding the soft timeout (timeoutSec).",
      };
    }
    if (signal === "SIGINT" || exitCode === 130) {
      return {
        errorCode: "cancelled",
        retryable: false,
        humanMessage: "claude run was cancelled by signal.",
      };
    }
    if (exitCode === 0) {
      // Should not be called on success, but be safe.
      return {
        errorCode: "unknown",
        retryable: false,
        humanMessage: "claude exited 0 but interpretFailure was invoked — caller should not call this on success.",
      };
    }
    if (exitCode === 1) {
      return {
        errorCode: "unknown",
        retryable: false,
        humanMessage: "claude exited 1 (generic error). Check stderr_line events for the underlying cause.",
      };
    }
    if (typeof exitCode === "number" && exitCode > 0) {
      return {
        errorCode: "unknown",
        retryable: false,
        humanMessage: `claude exited with non-zero code ${exitCode}. Check stderr_line events for the underlying cause.`,
      };
    }
    if (error) {
      return {
        errorCode: "unknown",
        retryable: true,
        humanMessage: `claude run failed before producing an exit code: ${error.message}`,
      };
    }
    return {
      errorCode: "unknown",
      retryable: false,
      humanMessage: "claude failed without a recognizable exit code or signal.",
    };
  },
};
