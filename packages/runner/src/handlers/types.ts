/**
 * Adapter handler contract for the multi-provider runner dispatcher.
 *
 * One handler per `AGENT_ADAPTER_TYPES` value (claude_local, codex_local,
 * openai_api, gemini_local, opencode_local, ...). The dispatcher in
 * `dispatch.ts` (S7.A.5) owns the spawn lifecycle (timeouts, SIGTERM →
 * SIGKILL escalation, drain, exit grace); each handler owns the per-CLI
 * specifics: argv shape, env mutations, stream-json parsing, and
 * pre-flight environment checks.
 *
 * Why split lifecycle vs handler:
 *   The lifecycle code in `spawn.ts:191-317` is 80 lines of subtle correctness
 *   (term/kill timers, partial-line drain, post-exit grace, stderr buffering).
 *   Duplicating it across 5+ adapters would inevitably drift. Adapters expose
 *   pure functions (`buildArgs`, `buildEnv`, `parseStreamLine`, ...) which are
 *   trivially fixture-testable; lifecycle is integration-tested ONCE in the
 *   dispatcher.
 *
 * See `.planning/TRDs/PHASE-S7-multi-provider-runtime.md` §2 for the full
 * design rationale and the rejected `adapter.run(args, hooks)` alternative.
 */

import type { spawn as nodeSpawn } from "node:child_process";

import type { RunnerEvent } from "../api.js";

/**
 * Auth path the dispatcher should select. `subscription` reads ambient
 * CLI-managed credentials (e.g. `~/.claude/credentials.json`); `api_key`
 * injects the company-secret value into the spawn env (e.g.
 * `ANTHROPIC_API_KEY`). `openai_api` only supports `api_key` — there is no
 * subscription path for the direct OpenAI API.
 */
export type AuthMode = "subscription" | "api_key";

/**
 * Inputs the dispatcher passes to handler methods. Mirrors `SpawnArgs` from
 * `spawn.ts` minus `binary` (each handler exposes its own `binary` field)
 * plus `authMode`. The dispatcher materializes `instructionsBase64` to a
 * tempfile before invoking `buildArgs`, and passes the resolved
 * `instructionsFilePath` separately to keep `buildArgs` pure (no I/O).
 */
export interface DispatchArgs {
  prompt: string;
  sessionId?: string | null;
  model?: string | null;
  maxTurns?: number | null;
  /**
   * Base64 contents of the agent's append-system-prompt file. The dispatcher
   * materializes this to a tempfile before invoking `buildArgs`, which
   * receives the resolved path via its `instructionsFilePath` parameter.
   */
  instructionsBase64?: string | null;
  /** Hard timeout — runner enforces SIGTERM at T, SIGKILL at 1.5T. */
  timeoutSec: number;
  /** Working directory for the spawned child. Defaults to runner cwd. */
  cwd?: string;
  /** Optional --add-dir entries the cloud suggested. */
  addDirs?: string[];
  /** Subscription vs API-key billing path. See {@link AuthMode}. */
  authMode: AuthMode;
}

/**
 * Pre-flight environment-check result. The dispatcher runs
 * {@link AdapterSpawnHandler.environmentChecks} BEFORE invoking spawn —
 * any `severity: "error"` aborts the job locally with a structured failure
 * (cliVersion = "unknown", errorMessage = check.message) so ops aren't
 * left grepping CLI exit codes.
 */
export interface EnvCheck {
  ok: boolean;
  /**
   * Stable machine-readable code. Examples: `binary_missing`, `auth_missing`,
   * `trust_required`. Keep stable across releases — ops dashboards filter on
   * this value.
   */
  code: string;
  /** Human-readable diagnostic. Surfaced as the run's errorMessage on abort. */
  message: string;
  /**
   * `error` blocks dispatch and aborts the job; `warn` is forwarded as a
   * `stderr_line` event but does not block.
   */
  severity: "error" | "warn";
}

/**
 * Final terminal result extracted from the captured event stream. The
 * dispatcher snapshots the LATEST instance produced by
 * {@link AdapterSpawnHandler.extractFinalResult} as new events arrive, then
 * surfaces it through the spawn return value.
 */
export interface FinalResult {
  sessionId?: string | null;
  costUsd?: number | null;
  raw: Record<string, unknown>;
}

/**
 * Per-adapter contract. Implementations live under
 * `packages/runner/src/handlers/<adapter>.ts` (claude-local.ts in S7.A.5;
 * codex-local.ts, gemini-local.ts, openai-api.ts in S7.B.*).
 */
export interface AdapterSpawnHandler {
  /**
   * The `AGENT_ADAPTER_TYPES` value this handler implements. Examples:
   * `claude_local`, `codex_local`, `openai_api`, `gemini_local`.
   */
  readonly type: string;

  /**
   * Default executable name to spawn when the agent's adapter_config does
   * not override it. For HTTP-wrapped providers (e.g. `openai_api`), this
   * is the path to a thin spawn wrapper script that emits a stream-json
   * shaped transcript on stdout — see TRD §9 "OpenAI direct API" for the
   * `bin/openai-api-runner.mjs` design.
   */
  readonly defaultBinary: string;

  /**
   * Build argv. Pure — no I/O, no process spawn. Allows fixture-based unit
   * tests that pin the exact CLI invocation per provider (see TRD §11
   * "Test contract per adapter").
   */
  buildArgs(args: DispatchArgs & { instructionsFilePath: string | null }): string[];

  /**
   * Compute env vars to layer on top of `process.env` for the spawn. Returns
   * the FULL env (not a delta) — clearer to test, and matches today's
   * `env: process.env` pattern at `spawn.ts:219`. Per-CLI footgun defenses
   * (e.g. `GEMINI_CLI_TRUST_WORKSPACE=true` for gemini_local) live here.
   */
  buildEnv(args: DispatchArgs, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv;

  /**
   * Parse one line of stdout into a typed RunnerEvent. Returns null to
   * suppress (e.g. blank lines). Failure to parse JSON should NOT throw —
   * yield a `stdout_line` raw event (current `parseStreamJsonLine` behavior
   * at `spawn.ts:101-108`).
   *
   * @param line - Raw stdout line, no trailing newline.
   * @param makeEventId - Caller-supplied id factory; injected so tests can
   *   make event ids deterministic.
   */
  parseStreamLine(line: string, makeEventId: () => string): RunnerEvent | null;

  /**
   * Pull final cost / sessionId out of accumulated events. Snapshot-style;
   * the dispatcher iterates events as they arrive and stores the latest
   * terminal result. Same job runClaude does today at `spawn.ts:252-258`.
   * Returns null when no terminal result event has been observed yet.
   */
  extractFinalResult(events: ReadonlyArray<RunnerEvent>): FinalResult | null;

  /**
   * Pre-flight checks the dispatcher runs BEFORE invoking spawn. Catches
   * trust-workspace violations, missing API keys, missing binaries, etc.
   * An `error`-severity result aborts the job locally with a structured
   * failure instead of letting the CLI exit with an opaque code (e.g.
   * Gemini's exit-55 trust violation).
   *
   * Implementations MUST be pure — no spawn, no fs writes; only readonly
   * inspections of `args` and `env`. Side-effecting probes (e.g. `which`)
   * belong in a separate "deep test" code path, not here.
   */
  environmentChecks(args: DispatchArgs, env: NodeJS.ProcessEnv): EnvCheck[];
}

/**
 * Test seam re-export so handler unit tests can spell `typeof spawn` without
 * pulling in the node:child_process types directly.
 */
export type SpawnImpl = typeof nodeSpawn;
