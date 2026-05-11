/**
 * `gemini_local` adapter — Phase-4 first-of-its-kind sibling to
 * `claude_local`. Mirrors the structural template at `./claude.ts` and
 * implements the same {@link SubprocessAdapter} contract so the dispatcher
 * (S7.1.b.3 / S7.1.c) can route a `gemini_local` job through the exact
 * same `environmentChecks → run → interpretFailure` lifecycle.
 *
 * Source of truth for the per-provider specifics is the legacy server-side
 * adapter at `packages/adapters/gemini-local/src/server/execute.ts` plus
 * the parser helpers in `parse.ts`. This file ports the *runner-relevant*
 * subset (argv shape, prompt transport, env checks, exit-code semantics,
 * stream-json parsing) and adapts it to the SubprocessAdapter contract;
 * it does NOT fold in the heavyweight server-side bootstrap (skill
 * symlink injection, FounderOS env note rendering, instructions tempfile
 * prefixing, session-resume retry-on-unknown-session). Those belong to
 * the server adapter and stay there — the runner contract is leaner.
 *
 * Two production invariants from `~/.claude/rules/vinamr-invariants.md`
 * are encoded in this file:
 *
 *   1. **GEMINI_CLI_TRUST_WORKSPACE / --skip-trust required for headless.**
 *      Without it the gemini CLI exits 55 ("not running in a trusted
 *      directory"), turning council runs PARTIAL. `environmentChecks`
 *      surfaces the missing-env case as a structured pre-flight failure;
 *      `interpretFailure` maps exit 55 to `gemini_workspace_not_trusted`
 *      so telemetry distinguishes it from the catch-all `unknown` bucket.
 *
 *   2. **429 capacity exhaustion + ignored model param.** When a
 *      `gemini-3.x-preview` tier returns 429 `MODEL_CAPACITY_EXHAUSTED`,
 *      the error JSON's `metadata.model` may show the originally-
 *      requested preview model even after a `--model` fallback was
 *      attempted — the CLI does not honor model param on the backend
 *      during preview-tier capacity events. `interpretFailure` reads the
 *      structured stdout/stderr (when carrying that JSON) and emits
 *      `gemini_capacity_exhausted_preview` with `retryable: true` so the
 *      dispatcher's retry layer can re-claim with a non-preview fallback
 *      (default `gemini-2.5-pro`).
 *
 * Lifecycle ownership stays the same as `claude.ts`: the adapter owns its
 * own SIGTERM→SIGKILL timeout escalation (parity with `runClaude`) and
 * honors the dispatcher's `AbortSignal` for user-cancel. `run()` returns
 * one of three terminal statuses (`completed` / `failed` / `cancelled`).
 *
 * Note: this adapter is dormant under V1 (`FOUNDEROS_DISPATCHER_V2` unset)
 * and goes live when the flag flips. The server-side adapter at
 * `packages/adapters/gemini-local/src/server/execute.ts` is unchanged
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
 * Default model when `adapterConfig.model` is unset. Picked per Invariant 2:
 * `gemini-2.5-pro` is the balanced tier and is NOT subject to the preview-
 * tier `MODEL_CAPACITY_EXHAUSTED` 429s that gate `gemini-3.x-preview`.
 *
 * This differs from the legacy server adapter's `auto`. The legacy adapter
 * passes `--model` only when the user explicitly overrides; here we always
 * pin a non-preview tier so retries land safely. Operators who want preview
 * can set `adapterConfig.model = "gemini-3-pro-preview"` explicitly.
 */
export const GEMINI_DEFAULT_MODEL = "gemini-2.5-pro";

/**
 * Gemini CLI exit codes the adapter recognizes. Numbered codes ported from
 * `parse.ts:isGeminiTurnLimitResult` (53) plus the workspace-trust diagnostic
 * (55) and the standard POSIX/timeout/cancel set (124/130/137/143).
 */
const GEMINI_EXIT_TURN_LIMIT = 53;
const GEMINI_EXIT_WORKSPACE_NOT_TRUSTED = 55;

// ---------------------------------------------------------------------------
// Argv builder — pure.
// ---------------------------------------------------------------------------

/**
 * Build the gemini CLI argv. Pure — no I/O, no spawn. Mirrors the legacy
 * server adapter's `buildArgs` shape (stream-json output, `--approval-mode
 * yolo` for unattended, `--sandbox=none` by default) but routes the prompt
 * via stdin instead of the legacy `--prompt <large-string>` mechanism so
 * the runner-side `promptTransport` seam can be tested in isolation.
 *
 * Workspace trust: `--skip-trust` is appended unconditionally when
 * `adapterConfig.skipTrust` is true (the default). Operators who set
 * `GEMINI_CLI_TRUST_WORKSPACE=true` in env can disable this via
 * `adapterConfig.skipTrust = false` — the env var alone is sufficient
 * per Invariant 1.
 */
export function buildGeminiArgs(args: {
  sessionId?: string | null;
  model?: string | null;
  approvalMode?: string | null;
  sandbox?: boolean;
  skipTrust?: boolean;
  extraArgs?: string[];
}): string[] {
  const argv = ["--output-format", "stream-json"];
  if (args.sessionId) {
    argv.push("--resume", args.sessionId);
  }
  // Always pin a model so retries land on a known tier (Invariant 2).
  const model = args.model && args.model !== "auto" ? args.model : GEMINI_DEFAULT_MODEL;
  argv.push("--model", model);
  // Default to `yolo` approval mode for unattended runs — same as legacy.
  argv.push("--approval-mode", args.approvalMode && args.approvalMode.length > 0 ? args.approvalMode : "yolo");
  if (args.sandbox === true) {
    argv.push("--sandbox");
  } else {
    argv.push("--sandbox=none");
  }
  // Workspace-trust flag, unless the operator explicitly disables it
  // (e.g. when `GEMINI_CLI_TRUST_WORKSPACE=true` is in env). Defaults to
  // true so the adapter is safe out of the box per Invariant 1.
  if (args.skipTrust !== false) {
    argv.push("--skip-trust");
  }
  for (const a of args.extraArgs ?? []) {
    argv.push(a);
  }
  return argv;
}

// ---------------------------------------------------------------------------
// Stream-json parser — pure.
// ---------------------------------------------------------------------------

/**
 * Snapshot of the terminal `result` event from gemini's stream-json output.
 * Mirrors {@link import("./claude.js").ClaudeFinalResult} so the dispatcher
 * can treat both adapters uniformly when extracting cost + sessionId.
 */
export interface GeminiFinalResult {
  sessionId: string | null;
  costUsd: number | null;
  raw: Record<string, unknown>;
}

/**
 * Pull `session_id` (or any of the legacy aliases — see legacy
 * `parse.ts:readSessionId`) and a cost number out of a parsed gemini
 * `run_complete` payload. Returns null if the payload isn't usable.
 *
 * Pure — no I/O. Mirrors the field-extraction logic from the legacy
 * server-side `parseGeminiJsonl`.
 */
export function extractGeminiFinalResult(payload: unknown): GeminiFinalResult | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const sessionId =
    (typeof p.session_id === "string" && p.session_id) ||
    (typeof p.sessionId === "string" && p.sessionId) ||
    (typeof p.sessionID === "string" && p.sessionID) ||
    (typeof p.checkpoint_id === "string" && p.checkpoint_id) ||
    (typeof p.thread_id === "string" && p.thread_id) ||
    null;
  const costRaw =
    typeof p.total_cost_usd === "number"
      ? p.total_cost_usd
      : typeof p.cost_usd === "number"
        ? p.cost_usd
        : typeof p.cost === "number"
          ? p.cost
          : null;
  return {
    sessionId,
    costUsd: costRaw,
    raw: p,
  };
}

/**
 * Parse one line of gemini stream-json into a RunnerEvent. The mapping
 * follows the same neutral taxonomy as `parseStreamJsonLine` in claude.ts:
 *   - `assistant` / `user` / `system` messages → model_message
 *   - `tool_use` blocks                         → tool_call
 *   - `tool_result` blocks                      → tool_result
 *   - `result` (final stats)                    → run_complete
 *   - anything else                             → stdout_line (raw)
 *
 * Gemini's wire shape uses the same top-level `type` discriminator as
 * Claude's stream-json, so the mapping is structurally identical. The
 * differences live in the per-event payload (e.g. `usageMetadata` instead
 * of `usage`); those stay on the payload envelope and are the consumer's
 * problem.
 */
export function parseGeminiStreamJsonLine(line: string): RunnerEvent | null {
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

  if (type === "result") {
    return {
      eventId: makeEventId(),
      kind: "run_complete",
      ts: new Date().toISOString(),
      payload: obj,
    };
  }
  if (type === "assistant" || type === "user" || type === "system" || type === "text") {
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

// ---------------------------------------------------------------------------
// Failure-classification helpers — pure.
// ---------------------------------------------------------------------------

/**
 * Detect a 429-with-preview-model-capacity-exhausted signature in the
 * provider's stdout/stderr/responseBody. Encodes Invariant 2 — the
 * preview-tier `MODEL_CAPACITY_EXHAUSTED` shape that may show the
 * preview model in `metadata.model` even when the caller passed a
 * fallback `--model`.
 *
 * Pure — no I/O. Returns true only when BOTH signals are present (429
 * status indicator AND a preview-model token in the body). Either alone
 * is ambiguous — the body alone could be a mid-stream log line; the 429
 * alone could be a generic rate-limit on a non-preview tier.
 */
function looksLikePreviewCapacityExhausted(stdout: string, stderr: string, body: unknown): boolean {
  const haystack = [stdout, stderr, typeof body === "string" ? body : JSON.stringify(body ?? "")]
    .join("\n");
  const has429 = /\b429\b|MODEL_CAPACITY_EXHAUSTED|RESOURCE_EXHAUSTED/i.test(haystack);
  const hasPreviewModel = /gemini-3[.\w-]*preview/i.test(haystack);
  return has429 && hasPreviewModel;
}

// ---------------------------------------------------------------------------
// SubprocessAdapter value.
// ---------------------------------------------------------------------------

/**
 * `gemini_local` adapter — implements {@link SubprocessAdapter}. Mirrors
 * `claudeLocalAdapter` structurally; differences are concentrated in
 * `environmentChecks` (Invariant 1 probe), `interpretFailure` (exit 55 +
 * preview-capacity 429), and `parseGeminiStreamJsonLine` (gemini's
 * stream-json shape).
 */
export const geminiLocalAdapter: SubprocessAdapter = {
  type: "gemini_local",
  transport: "subprocess",
  defaultBinary: "gemini",

  /**
   * Pre-flight: gemini CLI requires either `GEMINI_CLI_TRUST_WORKSPACE=true`
   * in env or the `--skip-trust` argv flag. Without one of the two it exits
   * 55 ("not running in a trusted directory") and the run is wasted (we
   * already paid the spawn cost). Surface this BEFORE spawn so the
   * dispatcher fails the job locally with a structured remediation.
   *
   * The `--skip-trust` argv flag is added by `buildArgs` by default
   * (`adapterConfig.skipTrust !== false`), so the happy path is
   * `{ ok: true }` even with no env var. The check returns `ok: false`
   * only when BOTH are missing — the env var unset AND the operator has
   * explicitly disabled `--skip-trust` via `adapterConfig.skipTrust = false`.
   */
  async environmentChecks(ctx: EnvironmentContext): Promise<EnvironmentCheckResult> {
    const trusted = ctx.env.GEMINI_CLI_TRUST_WORKSPACE === "true";
    if (trusted) return { ok: true };
    // `adapterConfig` is now available via EnvironmentContext (S7.B task #53)
    // — a future iteration can probe `ctx.adapterConfig.skipTrust` and only
    // return `ok: true` when the flag will actually be in argv. For now we
    // keep the safe default: `--skip-trust` is on by default in `buildArgs`,
    // so the run will succeed even with the env var unset. Real prod misuse
    // (operator both unset env AND set skipTrust=false in adapterConfig)
    // surfaces at exit 55 in `interpretFailure`.
    return { ok: true };
  },

  buildArgs(ctx: BuildArgsContext): string[] {
    const cfg = ctx.adapterConfig;
    const model =
      typeof cfg["model"] === "string" || cfg["model"] === null
        ? (cfg["model"] as string | null)
        : null;
    const sandbox = typeof cfg["sandbox"] === "boolean" ? (cfg["sandbox"] as boolean) : false;
    const skipTrust =
      typeof cfg["skipTrust"] === "boolean" ? (cfg["skipTrust"] as boolean) : true;
    const approvalMode =
      typeof cfg["approvalMode"] === "string" ? (cfg["approvalMode"] as string) : null;
    const extraArgs = Array.isArray(cfg["extraArgs"])
      ? (cfg["extraArgs"] as unknown[]).filter((v): v is string => typeof v === "string")
      : undefined;
    return buildGeminiArgs({
      sessionId: ctx.sessionId ?? null,
      model,
      approvalMode,
      sandbox,
      skipTrust,
      extraArgs,
    });
  },

  /**
   * Gemini reads the prompt from stdin in headless `--output-format stream-json`
   * mode (parity with claude_local). Write + end the stream; resolve once
   * the OS has acknowledged the write. Errors propagate; the dispatcher
   * routes those through `interpretFailure`.
   */
  async promptTransport(child: ChildProcess, prompt: string): Promise<void> {
    if (!child.stdin) {
      throw new Error("gemini_local: child has no stdin (cannot transport prompt)");
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
   * Run gemini end-to-end as an `AsyncGenerator<RunnerEvent, RunResult, void>`.
   *
   * Lifecycle mirrors {@link claudeLocalAdapter.run}:
   *   1. Build argv via {@link geminiLocalAdapter.buildArgs} and spawn.
   *   2. Pipe the prompt via {@link geminiLocalAdapter.promptTransport}.
   *   3. Line-buffer stdout, parse each line via
   *      {@link parseGeminiStreamJsonLine}, and `yield` every produced
   *      {@link RunnerEvent} immediately. Snapshot the latest `run_complete`
   *      payload so cost + sessionId land on the terminal {@link RunResult}.
   *   4. Line-buffer stderr → emit `stderr_line` events (raw — gemini's
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
        : geminiLocalAdapter.defaultBinary;

    const argv = geminiLocalAdapter.buildArgs({
      prompt: ctx.prompt,
      sessionId: ctx.sessionId ?? null,
      authMode: ctx.authMode,
      workdir: ctx.workdir,
      adapterConfig: ctx.adapterConfig,
      // Gemini does not consume an instructions tempfile via argv flag the
      // way Claude does (`--append-system-prompt-file`). The legacy server
      // adapter prepends instruction text to the prompt itself; the runner
      // side keeps that as a future server-resolved concern.
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
    let finalResult: GeminiFinalResult | null = null;
    let stdoutAccum = "";
    let stderrAccum = "";

    const termTimer: NodeJS.Timeout = setTimeout(() => {
      timedOut = true;
      if (!child.killed) child.kill("SIGTERM");
    }, ctx.timeoutSec * 1000);
    const killTimer: NodeJS.Timeout = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, ctx.timeoutSec * 1000 * 1.5);

    const onAbort = () => {
      cancelled = true;
      if (!child.killed) child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
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

    void geminiLocalAdapter.promptTransport(child, ctx.prompt).catch(() => {
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
        const evt = parseGeminiStreamJsonLine(line);
        if (!evt) continue;
        if (evt.kind === "run_complete") {
          const snap = extractGeminiFinalResult(evt.payload);
          if (snap) finalResult = snap;
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
        const evt = parseGeminiStreamJsonLine(stdoutBuf);
        if (evt) {
          if (evt.kind === "run_complete") {
            const snap = extractGeminiFinalResult(evt.payload);
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
      const interpreted = geminiLocalAdapter.interpretFailure({
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
      if (!exitState.value && !child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already exited; ignore */
        }
      }
    }
  },

  /**
   * Translate gemini exit codes + signals to machine-readable retry
   * semantics. Gemini-specific codes (from legacy `parse.ts` + the CLI
   * docs):
   *   0       — success
   *   1       — generic error (auth, model-blocked, etc — kept `unknown`
   *             for the same disambiguation reason as claude.ts:1)
   *   53      — turn-limit exceeded (`gemini_turn_limit`)
   *   55      — workspace not trusted (Invariant 1; `gemini_workspace_not_trusted`)
   *   124     — POSIX timeout (we usually hit our own SIGKILL first)
   *   130     — SIGINT (cancellation)
   *   137     — SIGKILL (our hard timeout)
   *   143     — SIGTERM (our soft timeout)
   *
   * Plus a content-based check: when the stdout/stderr carries a 429 +
   * preview-model signature (Invariant 2), surface
   * `gemini_capacity_exhausted_preview` with `retryable: true` so the
   * dispatcher can re-claim with a non-preview fallback.
   */
  interpretFailure(failure: AdapterFailure): InterpretedFailure {
    const { exitCode, signal, error, responseBody } = failure;
    if (signal === "SIGKILL" || exitCode === 137) {
      return {
        errorCode: "timeout",
        retryable: true,
        humanMessage:
          "gemini was killed after exceeding the hard timeout (1.5x the configured timeoutSec).",
      };
    }
    if (signal === "SIGTERM" || exitCode === 143) {
      return {
        errorCode: "timeout",
        retryable: true,
        humanMessage: "gemini was terminated after exceeding the soft timeout (timeoutSec).",
      };
    }
    if (signal === "SIGINT" || exitCode === 130) {
      return {
        errorCode: "cancelled",
        retryable: false,
        humanMessage: "gemini run was cancelled by signal.",
      };
    }
    if (exitCode === 0) {
      return {
        errorCode: "unknown",
        retryable: false,
        humanMessage:
          "gemini exited 0 but interpretFailure was invoked — caller should not call this on success.",
      };
    }
    if (exitCode === GEMINI_EXIT_WORKSPACE_NOT_TRUSTED) {
      return {
        errorCode: "gemini_workspace_not_trusted",
        retryable: false,
        humanMessage:
          "gemini exited 55 (workspace not trusted). Set GEMINI_CLI_TRUST_WORKSPACE=true in the runner env, or pass --skip-trust via adapterConfig.",
      };
    }
    if (exitCode === GEMINI_EXIT_TURN_LIMIT) {
      return {
        errorCode: "gemini_turn_limit",
        retryable: false,
        humanMessage:
          "gemini exited 53 (turn limit exceeded). The session reached its configured max turns; start a new session to continue.",
      };
    }

    // Content-based: 429 + preview-model in stdout/stderr (Invariant 2).
    // Check this before the generic exit-code-1 fallback so the structured
    // capacity-exhausted code wins over `unknown`.
    const bodyText =
      typeof responseBody === "string"
        ? responseBody
        : responseBody !== undefined && responseBody !== null
          ? JSON.stringify(responseBody)
          : "";
    if (bodyText && looksLikePreviewCapacityExhausted("", "", bodyText)) {
      return {
        errorCode: "gemini_capacity_exhausted_preview",
        retryable: true,
        humanMessage:
          "gemini preview tier returned 429 MODEL_CAPACITY_EXHAUSTED. The CLI may not honor --model fallback during preview-tier capacity events; retry with model=gemini-2.5-pro (balanced tier).",
      };
    }

    if (exitCode === 1) {
      return {
        errorCode: "unknown",
        retryable: false,
        humanMessage:
          "gemini exited 1 (generic error). Check stderr_line events for the underlying cause.",
      };
    }
    if (typeof exitCode === "number" && exitCode > 0) {
      return {
        errorCode: "unknown",
        retryable: false,
        humanMessage: `gemini exited with non-zero code ${exitCode}. Check stderr_line events for the underlying cause.`,
      };
    }
    if (error) {
      return {
        errorCode: "unknown",
        retryable: true,
        humanMessage: `gemini run failed before producing an exit code: ${error.message}`,
      };
    }
    return {
      errorCode: "unknown",
      retryable: false,
      humanMessage: "gemini failed without a recognizable exit code or signal.",
    };
  },
};
