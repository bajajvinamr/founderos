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
 * Note: `run()` is NOT yet wired to spawn the child — that lives in
 * `spawn.ts` (`runClaude`) and will be folded in by S7.1.b.3 when the
 * dispatcher replaces `runClaude`. For now `run()` is a placeholder that
 * compiles against the interface but throws if invoked. This is
 * intentional: the council BLOCK was on the *interface*, not on the
 * subprocess lifecycle code in `spawn.ts:101-199`. Folding spawn into
 * `run()` is a separate diff so the lifecycle plumbing review doesn't
 * conflate with the interface review.
 */

import type { ChildProcess } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
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
 * Snapshot of the terminal `result` event. The dispatcher's stdout reader
 * calls this on every claude_result event so the LATEST value wins (matches
 * the prior inline behavior at the previous spawn.ts:252-258).
 */
export interface ClaudeFinalResult {
  sessionId: string | null;
  costUsd: number | null;
  raw: Record<string, unknown>;
}

/**
 * Pull `session_id` + `total_cost_usd` out of a parsed `claude_result`
 * event payload. Returns null if the payload isn't a usable object.
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
   * S7.1.b.3 will fold the lifecycle from `spawn.ts:runClaude` into this
   * method. The interface is what ships in this PR; the implementation is
   * deliberately stubbed so the council review focuses on the contract,
   * not on the lifecycle plumbing rewrite. Calling it before S7.1.b.3
   * lands throws — the legacy code path in `main.ts` continues to use
   * `runClaude` directly until the dispatcher replaces it.
   */
  // eslint-disable-next-line require-yield
  async *run(_ctx: RunContext, _signal: AbortSignal): AsyncGenerator<RunnerEvent, RunResult, void> {
    throw new Error(
      "claudeLocalAdapter.run() is not yet wired — see S7.1.b.3 (dispatcher). " +
        "Until then the legacy `runClaude` in spawn.ts handles execution.",
    );
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
