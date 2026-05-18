/**
 * `codex_local` adapter — Phase-4 second-of-its-kind sibling to
 * `claude_local` and `gemini_local`. Mirrors the structural template at
 * `./gemini.ts` and implements the same {@link SubprocessAdapter} contract
 * so the dispatcher routes a `codex_local` job through the same
 * `environmentChecks → run → interpretFailure` lifecycle.
 *
 * Source of truth for the per-provider specifics is the legacy server-side
 * adapter at `packages/adapters/codex-local/src/server/execute.ts` plus the
 * argv builder at `codex-args.ts` and the parser at `parse.ts`. This file
 * ports the runner-relevant subset (argv shape, prompt transport, env
 * checks, exit-code semantics, JSONL parsing) and adapts it to the
 * SubprocessAdapter contract; it does NOT fold in the heavyweight
 * server-side bootstrap (skill symlink injection, FounderOS env note
 * rendering, instructions tempfile prefixing, session-resume retry-on-
 * unknown-session). Those belong to the server adapter and stay there.
 *
 * One production invariant from `~/.claude/rules/vinamr-invariants.md`
 * is encoded structurally in this file:
 *
 *   1. **Codex Multi-CLI optional params (`approvalPolicy`, `sandbox`)
 *      cause arg-parse failure — exits code 2 "unexpected argument '-a'".**
 *      The DEFAULT argv from `buildArgs` MUST NOT include `--approval-policy`,
 *      `-a`, or `--sandbox`. Only emit them when the operator explicitly
 *      opts in via `adapterConfig.approvalPolicy` / `adapterConfig.sandbox`
 *      — the adapter does not assume safe defaults. Exit 2 maps to
 *      `codex_arg_parse_failure` with `retryable: false` so telemetry
 *      distinguishes it from generic exit-1 failures.
 *
 * Lifecycle ownership stays the same as `gemini.ts`: the adapter owns its
 * own SIGTERM→SIGKILL timeout escalation and honors the dispatcher's
 * `AbortSignal` for user-cancel. `run()` returns one of three terminal
 * statuses (`completed` / `failed` / `cancelled`).
 *
 * Note: this adapter is dormant under V1 (`FOUNDEROS_DISPATCHER_V2` unset)
 * and goes live when the flag flips. The server-side adapter at
 * `packages/adapters/codex-local/src/server/execute.ts` is unchanged
 * and continues to power the in-process server path until then.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";

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

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

/**
 * Codex CLI exit codes. Per Invariant 1, code 2 is the canonical
 * "unexpected argument" arg-parse failure that fires when an operator
 * passes `--approval-policy` or `--sandbox` to a Codex build that does not
 * accept them. We surface this with its own `errorCode` so dashboards can
 * distinguish it from generic exit-1 failures.
 *
 * 124 / 130 / 137 / 143 are the standard POSIX timeout/cancel set.
 */
const CODEX_EXIT_ARG_PARSE_FAILURE = 2;

// ---------------------------------------------------------------------------
// Argv builder — pure.
// ---------------------------------------------------------------------------

/**
 * Build the codex CLI argv. Pure — no I/O, no spawn. Mirrors the legacy
 * server adapter's `buildCodexExecArgs` shape (subcommand `exec`, JSON
 * output via `--json`, prompt argument is `-` for stdin, optional resume
 * via `resume <session_id> -`) but routes the prompt via stdin only
 * (no tempfile dance). Per Invariant 1 the DEFAULT argv contains NO
 * `--approval-policy` or `--sandbox` flags — operators opt in explicitly.
 *
 * Why not always emit `--sandbox` or `--approval-policy`: prior council
 * R1 finding (2026-05; Codex Multi-CLI eval) — Codex builds that don't
 * accept the optional params exit 2 with "unexpected argument '-a'" and
 * the run is wasted. The default keeps the argv minimal.
 */
export function buildCodexArgs(args: {
  sessionId?: string | null;
  model?: string | null;
  modelReasoningEffort?: string | null;
  search?: boolean;
  bypass?: boolean;
  /**
   * Operator opt-in for `--approval-policy <value>`. Per Invariant 1 the
   * default argv does NOT include this flag; pass an explicit string to
   * emit it. Adapters that omit this leave the flag out entirely.
   */
  approvalPolicy?: string | null;
  /**
   * Operator opt-in for `--sandbox <value>`. Per Invariant 1 the default
   * argv does NOT include this flag; pass an explicit string to emit it.
   */
  sandbox?: string | null;
  extraArgs?: string[];
}): string[] {
  const argv: string[] = ["exec", "--json"];
  if (args.search) argv.unshift("--search");
  if (args.bypass) argv.push("--dangerously-bypass-approvals-and-sandbox");
  if (args.model && args.model.length > 0) {
    argv.push("--model", args.model);
  }
  if (args.modelReasoningEffort && args.modelReasoningEffort.length > 0) {
    argv.push("-c", `model_reasoning_effort=${JSON.stringify(args.modelReasoningEffort)}`);
  }
  // Invariant 1: emit `--approval-policy` ONLY when the operator passed
  // an explicit non-empty string. Default omits it entirely.
  if (typeof args.approvalPolicy === "string" && args.approvalPolicy.length > 0) {
    argv.push("--approval-policy", args.approvalPolicy);
  }
  // Invariant 1: emit `--sandbox` ONLY when the operator passed an explicit
  // non-empty string. Default omits it entirely.
  if (typeof args.sandbox === "string" && args.sandbox.length > 0) {
    argv.push("--sandbox", args.sandbox);
  }
  for (const a of args.extraArgs ?? []) {
    argv.push(a);
  }
  if (args.sessionId) {
    argv.push("resume", args.sessionId, "-");
  } else {
    argv.push("-");
  }
  return argv;
}

// ---------------------------------------------------------------------------
// Stream-json parser — pure.
// ---------------------------------------------------------------------------

/**
 * Snapshot of the terminal `turn.completed` / `thread.started` events
 * from codex's JSONL output. Mirrors {@link import("./gemini.js").GeminiFinalResult}
 * so the dispatcher can treat all three subprocess adapters uniformly when
 * extracting cost + sessionId.
 *
 * Note: codex does NOT emit a per-run cost in its JSONL (legacy adapter
 * sets `costUsd: null` unconditionally — see `execute.ts:586`). We keep
 * `costUsd` here for shape parity with gemini/claude but it will always
 * be `null` for codex_local.
 */
export interface CodexFinalResult {
  sessionId: string | null;
  costUsd: number | null;
  raw: Record<string, unknown>;
}

/**
 * Pull `thread_id` (codex's session id alias) out of a parsed codex
 * `thread.started` payload. Returns null if the payload isn't usable.
 *
 * Pure — no I/O. Mirrors the field-extraction logic from the legacy
 * server-side `parseCodexJsonl` (see `parse.ts:21`).
 */
export function extractCodexFinalResult(payload: unknown): CodexFinalResult | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const sessionId =
    (typeof p.thread_id === "string" && p.thread_id) ||
    (typeof p.session_id === "string" && p.session_id) ||
    (typeof p.sessionId === "string" && p.sessionId) ||
    null;
  return {
    sessionId,
    costUsd: null,
    raw: p,
  };
}

/**
 * Parse one line of codex JSONL into a RunnerEvent. The mapping follows
 * the same neutral taxonomy as `parseGeminiStreamJsonLine` and
 * `parseStreamJsonLine`:
 *   - `thread.started`     → run_complete-shaped session-id event,
 *                            but kind=stdout_line (we surface session via
 *                            the snapshot path; the runner-internal kind
 *                            stays neutral). We map `thread.started` to
 *                            `model_message` so the consumer sees a
 *                            structured event.
 *   - `item.completed` (agent_message) → model_message
 *   - `turn.completed`     → run_complete (final stats)
 *   - `turn.failed`        → stderr_line equivalent (kept as stdout_line
 *                            with the structured body)
 *   - `error`              → stdout_line (raw — error message lives on body)
 *   - anything else        → stdout_line
 *
 * Why we treat `turn.completed` as the run_complete signal (not
 * `thread.started`): codex emits `thread.started` mid-stream as the session
 * is established, then `turn.completed` only on the final turn before exit.
 * The cloud event-batcher uses run_complete to anchor the cost/session-id
 * snapshot; turn.completed is the right anchor for that.
 */
export function parseCodexStreamJsonLine(line: string): RunnerEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

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

  if (type === "turn.completed") {
    return {
      eventId: makeEventId(),
      kind: "run_complete",
      ts: new Date().toISOString(),
      payload: obj,
    };
  }
  if (type === "thread.started") {
    // Surfaces the session id via a model_message-shaped event; the
    // adapter snapshots `thread_id` separately for the RunResult.
    return {
      eventId: makeEventId(),
      kind: "model_message",
      ts: new Date().toISOString(),
      payload: obj,
    };
  }
  if (type === "item.completed") {
    const item = obj.item;
    const itemType =
      typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).type === "string"
        ? ((item as Record<string, unknown>).type as string)
        : "";
    if (itemType === "agent_message") {
      return {
        eventId: makeEventId(),
        kind: "model_message",
        ts: new Date().toISOString(),
        payload: obj,
      };
    }
    // Tool calls / results land under `item.completed` with item.type
    // discriminator. Map known values; default to stdout_line.
    if (itemType === "tool_use" || itemType === "function_call" || itemType === "tool_call") {
      return {
        eventId: makeEventId(),
        kind: "tool_call",
        ts: new Date().toISOString(),
        payload: obj,
      };
    }
    if (itemType === "tool_result" || itemType === "function_call_output") {
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
  return {
    eventId: makeEventId(),
    kind: "stdout_line",
    ts: new Date().toISOString(),
    payload: obj,
  };
}

// ---------------------------------------------------------------------------
// SubprocessAdapter value.
// ---------------------------------------------------------------------------

/**
 * `codex_local` adapter — implements {@link SubprocessAdapter}. Mirrors
 * `geminiLocalAdapter` structurally; differences are concentrated in
 * `buildArgs` (Invariant 1: no default optional flags), `interpretFailure`
 * (exit 2 → `codex_arg_parse_failure`), and `parseCodexStreamJsonLine`
 * (codex's JSONL shape).
 */
export const codexLocalAdapter: SubprocessAdapter = {
  type: "codex_local",
  transport: "subprocess",
  defaultBinary: "codex",

  /**
   * Pre-flight: codex CLI has no required env var (auth is via either
   * `OPENAI_API_KEY` for API-key billing or local login/session for
   * subscription billing — the legacy adapter at
   * `execute.ts:resolveCodexBillingType` infers this at runtime). Both
   * paths can be valid, so we don't fail the pre-flight on a missing
   * `OPENAI_API_KEY` — the adapter trusts the dispatcher's auth-mode
   * resolution. Returns `ok: true` unconditionally; real auth failures
   * surface at exit 1 inside `interpretFailure`.
   */
  async environmentChecks(_ctx: EnvironmentContext): Promise<EnvironmentCheckResult> {
    return { ok: true };
  },

  buildArgs(ctx: BuildArgsContext): string[] {
    const cfg = ctx.adapterConfig;
    const model =
      typeof cfg["model"] === "string" && (cfg["model"] as string).length > 0
        ? (cfg["model"] as string)
        : null;
    const modelReasoningEffort =
      typeof cfg["modelReasoningEffort"] === "string"
        ? (cfg["modelReasoningEffort"] as string)
        : typeof cfg["reasoningEffort"] === "string"
          ? (cfg["reasoningEffort"] as string)
          : null;
    const search = typeof cfg["search"] === "boolean" ? (cfg["search"] as boolean) : false;
    const bypass =
      typeof cfg["dangerouslyBypassApprovalsAndSandbox"] === "boolean"
        ? (cfg["dangerouslyBypassApprovalsAndSandbox"] as boolean)
        : typeof cfg["dangerouslyBypassSandbox"] === "boolean"
          ? (cfg["dangerouslyBypassSandbox"] as boolean)
          : false;
    // Invariant 1: only emit `--approval-policy` / `--sandbox` when the
    // operator provided an explicit non-empty string in adapterConfig.
    const approvalPolicy =
      typeof cfg["approvalPolicy"] === "string" && (cfg["approvalPolicy"] as string).length > 0
        ? (cfg["approvalPolicy"] as string)
        : null;
    const sandbox =
      typeof cfg["sandbox"] === "string" && (cfg["sandbox"] as string).length > 0
        ? (cfg["sandbox"] as string)
        : null;
    const extraArgs = Array.isArray(cfg["extraArgs"])
      ? (cfg["extraArgs"] as unknown[]).filter((v): v is string => typeof v === "string")
      : undefined;
    return buildCodexArgs({
      sessionId: ctx.sessionId ?? null,
      model,
      modelReasoningEffort,
      search,
      bypass,
      approvalPolicy,
      sandbox,
      extraArgs,
    });
  },

  /**
   * Codex reads the prompt from stdin in headless `exec --json` mode (the
   * argv ends with `-` to enable stdin reads — see `buildCodexArgs`).
   * Write + end the stream; resolve once the OS has acknowledged the
   * write. Errors propagate; the dispatcher routes those through
   * `interpretFailure`.
   */
  async promptTransport(child: ChildProcess, prompt: string): Promise<void> {
    if (!child.stdin) {
      throw new Error("codex_local: child has no stdin (cannot transport prompt)");
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
   * Run codex end-to-end as an `AsyncGenerator<RunnerEvent, RunResult, void>`.
   *
   * Lifecycle mirrors {@link geminiLocalAdapter.run}:
   *   1. Build argv via {@link codexLocalAdapter.buildArgs} and spawn.
   *   2. Pipe the prompt via {@link codexLocalAdapter.promptTransport}.
   *   3. Line-buffer stdout, parse each line via
   *      {@link parseCodexStreamJsonLine}, and `yield` every produced
   *      {@link RunnerEvent} immediately. Snapshot the latest
   *      `thread.started` payload so sessionId lands on the terminal
   *      {@link RunResult}.
   *   4. Line-buffer stderr → emit `stderr_line` events (raw — codex's
   *      stderr is human-readable diagnostics).
   *   5. Honor `signal.aborted` AND the soft/hard timeout escalation
   *      (SIGTERM at `timeoutSec`, SIGKILL at 1.5x).
   *
   * Cleanup runs in `finally` so a thrown error during `yield` (consumer
   * threw, generator aborted) still tears down the child.
   */
  async *run(ctx: RunContext, signal: AbortSignal): AsyncGenerator<RunnerEvent, RunResult, void> {
    const cfg = ctx.adapterConfig;
    const binary =
      typeof cfg["binary"] === "string" && (cfg["binary"] as string).length > 0
        ? (cfg["binary"] as string)
        : codexLocalAdapter.defaultBinary;

    const argv = codexLocalAdapter.buildArgs({
      prompt: ctx.prompt,
      sessionId: ctx.sessionId ?? null,
      authMode: ctx.authMode,
      workdir: ctx.workdir,
      adapterConfig: ctx.adapterConfig,
      // Codex does not consume an instructions tempfile via argv flag;
      // the legacy server adapter prepends instruction text to the prompt
      // itself. The runner side keeps that as a future server-resolved
      // concern.
      instructionsFilePath: null,
    });

    const startedAt = performance.now();
    const child: ChildProcess = nodeSpawn(binary, argv, {
      cwd: ctx.workdir,
      stdio: ["pipe", "pipe", "pipe"],
      env: ctx.env,
    });

    let timedOut = false;
    let cancelled = false;
    let finalResult: CodexFinalResult | null = null;
    let stdoutAccum = "";
    let stderrAccum = "";

    // Gate kill calls on `exitState.value` (set by the exit/error handlers
    // below) not `child.killed`. The latter flips true on kill() invocation,
    // so a trapped-SIGTERM child would skip the SIGKILL backstop and hang
    // for its natural runtime. Same fix pattern across spawn.ts + adapters.
    const termTimer: NodeJS.Timeout = setTimeout(() => {
      timedOut = true;
      if (!exitState.value) child.kill("SIGTERM");
    }, ctx.timeoutSec * 1000);
    const killTimer: NodeJS.Timeout = setTimeout(
      () => {
        if (!exitState.value) child.kill("SIGKILL");
      },
      ctx.timeoutSec * 1000 * 1.5,
    );

    const onAbort = () => {
      cancelled = true;
      if (!exitState.value) child.kill("SIGTERM");
      setTimeout(() => {
        if (!exitState.value) child.kill("SIGKILL");
      }, 200).unref();
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const eventQueue: RunnerEvent[] = [];
    type ExitInfo = { code: number; signal: NodeJS.Signals | null };
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

    void codexLocalAdapter.promptTransport(child, ctx.prompt).catch(() => {
      /* surface via exit code; stderr_line events will carry the cause */
    });

    let stdoutBuf = "";
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutAccum += chunk;
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        const evt = parseCodexStreamJsonLine(line);
        if (!evt) continue;
        // Snapshot thread.started → sessionId. This is codex's
        // session-establishment event, distinct from the run_complete
        // anchor (which is `turn.completed`).
        if (evt.kind === "model_message" && typeof evt.payload === "object" && evt.payload !== null) {
          const p = evt.payload as Record<string, unknown>;
          if (p.type === "thread.started") {
            const snap = extractCodexFinalResult(p);
            if (snap) finalResult = snap;
          }
        }
        eventQueue.push(evt);
        ping();
      }
    });

    let stderrBuf = "";
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      stderrAccum += chunk;
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
      while (true) {
        if (eventQueue.length === 0) {
          if (exitState.value) break;
          await readyPromise;
          readyPromise = new Promise<void>((r) => {
            resolveReady = r;
          });
        }
        while (eventQueue.length > 0) {
          const evt = eventQueue.shift()!;
          yield evt;
        }
      }

      if (stdoutBuf.trim()) {
        const evt = parseCodexStreamJsonLine(stdoutBuf);
        if (evt) {
          if (evt.kind === "model_message" && typeof evt.payload === "object" && evt.payload !== null) {
            const p = evt.payload as Record<string, unknown>;
            if (p.type === "thread.started") {
              const snap = extractCodexFinalResult(p);
              if (snap) finalResult = snap;
            }
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
      const interpreted = codexLocalAdapter.interpretFailure({
        exitCode,
        signal: sigName,
        responseBody: stdoutAccum + "\n" + stderrAccum,
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
      if (!exitState.value) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already exited; ignore */
        }
      }
    }
  },

  /**
   * Translate codex exit codes + signals to machine-readable retry
   * semantics. Codex-specific codes:
   *   0       — success
   *   1       — generic error (auth, model error, etc — kept `unknown` for
   *             the same disambiguation reason as gemini.ts:1)
   *   2       — arg-parse failure (Invariant 1: `--approval-policy` /
   *             `--sandbox` rejected with "unexpected argument '-a'").
   *             Maps to `codex_arg_parse_failure`, retryable=false (the
   *             argv shape is wrong; retrying with the same shape will
   *             fail again — operator must fix adapterConfig).
   *   124     — POSIX timeout (we usually hit our own SIGKILL first)
   *   130     — SIGINT (cancellation)
   *   137     — SIGKILL (our hard timeout)
   *   143     — SIGTERM (our soft timeout)
   */
  interpretFailure(failure: AdapterFailure): InterpretedFailure {
    const { exitCode, signal, error } = failure;
    if (signal === "SIGKILL" || exitCode === 137) {
      return {
        errorCode: "timeout",
        retryable: true,
        humanMessage:
          "codex was killed after exceeding the hard timeout (1.5x the configured timeoutSec).",
      };
    }
    if (signal === "SIGTERM" || exitCode === 143) {
      return {
        errorCode: "timeout",
        retryable: true,
        humanMessage: "codex was terminated after exceeding the soft timeout (timeoutSec).",
      };
    }
    if (signal === "SIGINT" || exitCode === 130) {
      return {
        errorCode: "cancelled",
        retryable: false,
        humanMessage: "codex run was cancelled by signal.",
      };
    }
    if (exitCode === 0) {
      return {
        errorCode: "unknown",
        retryable: false,
        humanMessage:
          "codex exited 0 but interpretFailure was invoked — caller should not call this on success.",
      };
    }
    if (exitCode === CODEX_EXIT_ARG_PARSE_FAILURE) {
      return {
        errorCode: "codex_arg_parse_failure",
        retryable: false,
        humanMessage:
          "codex exited 2 (arg-parse failure: \"unexpected argument\"). Per ~/.claude/rules/vinamr-invariants.md, the codex CLI does NOT accept --approval-policy / --sandbox unless explicitly built for it. Remove approvalPolicy and sandbox from adapterConfig and retry, or upgrade the codex binary.",
      };
    }
    if (exitCode === 1) {
      return {
        errorCode: "unknown",
        retryable: false,
        humanMessage:
          "codex exited 1 (generic error). Check stderr_line events for the underlying cause.",
      };
    }
    if (typeof exitCode === "number" && exitCode > 0) {
      return {
        errorCode: "unknown",
        retryable: false,
        humanMessage: `codex exited with non-zero code ${exitCode}. Check stderr_line events for the underlying cause.`,
      };
    }
    if (error) {
      return {
        errorCode: "unknown",
        retryable: true,
        humanMessage: `codex run failed before producing an exit code: ${error.message}`,
      };
    }
    return {
      errorCode: "unknown",
      retryable: false,
      humanMessage: "codex failed without a recognizable exit code or signal.",
    };
  },
};
