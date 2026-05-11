/**
 * Adapter handler contract for the multi-provider runner dispatcher.
 *
 * **S7.1.b.2 keystone redesign — council BLOCK on the prior interface
 * (2026-05-09; see `~/.gstack/projects/bajajvinamr-founderos/decisions.md`).**
 *
 * The previous shape (`AdapterSpawnHandler` with `buildArgs`/`buildEnv`/
 * `parseStreamLine`/`extractFinalResult`/synchronous `environmentChecks`)
 * was structurally subprocess-only. Both Codex and Gemini independently
 * surfaced this as a P1 architectural finding: pure-HTTP API adapters
 * (`openai_api`, `gemini_api`, future `anthropic_api`) cannot be expressed
 * as "argv + env + stream-json line parser" without forcing them into a
 * fake subprocess wrapper that would strip rate-limit headers and lose the
 * 429/529 distinction. R2 converged on the redesign in this file.
 *
 * Design summary:
 *
 *   `AdapterHandler`        — common contract every adapter implements.
 *                             The dispatcher only ever sees this shape.
 *   ↓ extends
 *   `SubprocessAdapter`     — claude_local, gemini_local, codex_local, cursor.
 *                             Owns argv shape + how the prompt reaches the child
 *                             (stdin / file / env — adapter chooses).
 *   `ApiAdapter`            — openai_api, anthropic_api, gemini_api.
 *                             `run()` owns the full HTTP cycle directly; no
 *                             argv, no `promptTransport`.
 *
 *   `AnyAdapter` = `SubprocessAdapter | ApiAdapter` is the registry value
 *   type so dispatch code can branch on `adapter.transport` once if it
 *   needs to (it usually doesn't — `run()` and `interpretFailure()` are
 *   transport-agnostic).
 *
 * Three council non-negotiables this file enforces:
 *
 *   1. **Subprocess vs API split is structural** (both-confirmed P1).
 *      A future PR cannot collapse these back into one shape without
 *      re-running council; the test seam in `__tests__/handlers/types.test.ts`
 *      compiles a mock for each of the four future families, which is
 *      precisely the proof that the split is implementable end-to-end.
 *   2. **`environmentChecks` is async + permits read-only fs probes**
 *      (Gemini P2). `gemini_local` needs to stat `~/.gemini/skills/` and
 *      probe `GEMINI_CLI_TRUST_WORKSPACE`; the prior "must be pure" rule
 *      forced that probe into a separate ad-hoc code path.
 *   3. **`interpretFailure` returns machine-readable retry semantics**
 *      (Codex P2). `retryable` is the single discriminator the dispatcher
 *      uses to decide retry vs fail; `errorCode` is for telemetry.
 *      Subprocess adapters interpret exit code + signal; API adapters
 *      interpret HTTP status + headers (rate-limit, retry-after).
 *
 * Lifecycle ownership unchanged from the prior design: the dispatcher
 * owns timeout escalation (SIGTERM → SIGKILL for subprocess; AbortController
 * for HTTP), event batching, and the cloud round-trip; each adapter owns
 * the per-provider specifics. See `.planning/TRDs/PHASE-S7-multi-provider-runtime.md`
 * §2 for the full design rationale.
 */

import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";

import type { RunnerAdapterType, RunnerEvent } from "../api.js";

// ---------------------------------------------------------------------------
// Shared inputs & outputs — used by every adapter regardless of transport.
// ---------------------------------------------------------------------------

/**
 * Auth path the dispatcher should select. `subscription` reads ambient
 * CLI-managed credentials (e.g. `~/.claude/credentials.json`); `api_key`
 * injects the company-secret value into the spawn env (subprocess) or
 * Authorization header (API). `openai_api` only supports `api_key`.
 */
export type AuthMode = "subscription" | "api_key";

/**
 * Inputs the dispatcher passes to {@link AdapterHandler.environmentChecks}.
 * Read-only — checks may probe the filesystem (`stat`, `access`) and the
 * environment, but MUST NOT spawn processes or perform network I/O.
 */
export interface EnvironmentContext {
  /** Adapter-config override of the default binary (subprocess) or endpoint (API). */
  binaryOverride?: string;
  /** Working directory the adapter will run in, if relevant for the check. */
  cwd?: string;
  /** Environment the adapter would receive — usually a snapshot of `process.env`. */
  env: NodeJS.ProcessEnv;
}

/**
 * Outcome of an adapter's pre-flight checks. The dispatcher aborts the job
 * locally (without invoking the adapter's `run()`) when `ok === false`.
 *
 * `reason` is the machine-readable diagnostic; `remediation` is the
 * human-readable fix-it instruction surfaced in the run log + UI. Examples:
 *   - `{ ok: false, reason: "GEMINI_CLI_TRUST_WORKSPACE not set",
 *        remediation: "Run \`export GEMINI_CLI_TRUST_WORKSPACE=true\`..." }`
 *   - `{ ok: false, reason: "OPENAI_API_KEY missing",
 *        remediation: "Add OPENAI_API_KEY to runner env or company secrets." }`
 *   - `{ ok: true }` is the happy path.
 */
export interface EnvironmentCheckResult {
  ok: boolean;
  reason?: string;
  remediation?: string;
}

/**
 * Inputs the dispatcher passes to {@link AdapterHandler.run}. Provider-neutral
 * shape: `prompt` is the user/agent prompt; `workdir` is the cwd the adapter
 * should treat as the project root; `env` is the env the dispatcher prepared
 * (api_key already merged in for `api_key`-mode subprocess adapters).
 *
 * Adapter-specific config (model, maxTurns, instructionsBase64, addDirs, ...)
 * lives in `adapterConfig` as an open record; each adapter narrows it
 * internally via Zod or hand-rolled type guards. Keeping it open means the
 * dispatcher does not need to know the union of every adapter's tunables —
 * it just forwards what the cloud sent.
 */
export interface RunContext {
  jobId: string;
  prompt: string;
  workdir: string;
  env: NodeJS.ProcessEnv;
  /** Subscription vs API-key billing path. See {@link AuthMode}. */
  authMode: AuthMode;
  /** Hard timeout — runner enforces SIGTERM at T, SIGKILL at 1.5T (subprocess) or AbortController (api). */
  timeoutSec: number;
  /** Adapter-specific tunables the cloud sent in `runner_jobs.runtime_config`. */
  adapterConfig: Readonly<Record<string, unknown>>;
  /** Prior session id, when the cloud is asking the adapter to resume. */
  sessionId?: string | null;
}

/**
 * Provider-neutral terminal status. Every adapter — subprocess or API —
 * resolves to one of these three.
 */
export type RunStatus = "completed" | "failed" | "cancelled";

/**
 * Result returned from `run()` after the AsyncGenerator finishes. The
 * dispatcher uses this as the source of truth for the cloud-side
 * `/complete` body — `status` plus whichever provider-neutral fields apply.
 *
 * Subprocess adapters set `exitCode` + `signal`; API adapters set
 * `httpStatus`. `costUsd` and `sessionId` are set by whichever adapter
 * could extract them.
 */
export interface RunResult {
  status: RunStatus;
  /** Wall-clock seconds from `run()` invocation to terminal status. */
  elapsedSec: number;
  /** Provider-reported cost, when known. Cloud converts to micros. */
  costUsd?: number | null;
  /** Resumable session id, when the provider supports continuation. */
  sessionId?: string | null;
  /** Provider CLI/API version snapshot — surfaced in `cliVersion` on /complete. */
  providerVersion?: string;
  /** Subprocess only: child exit code. */
  exitCode?: number;
  /** Subprocess only: signal that terminated the child, if any. */
  signal?: NodeJS.Signals | null;
  /** API only: terminal HTTP status from the provider. */
  httpStatus?: number;
  /** Human-readable error message on `status: "failed"`. Surfaced in run log + UI. */
  errorMessage?: string | null;
}

/**
 * Native failure shape passed to {@link AdapterHandler.interpretFailure}.
 * Subprocess adapters populate `exitCode` + `signal`; API adapters populate
 * `httpStatus` + `responseHeaders` + (parsed) `responseBody`. `error` is the
 * underlying JS exception when the failure is at that layer (network drop,
 * AbortError, JSON parse fail, etc.).
 *
 * Adapters MUST handle the case where multiple of these are set
 * simultaneously (e.g. an API adapter that hit a 429 AND threw a parse
 * error on the body) — pick the most specific signal and ignore the rest.
 */
export interface AdapterFailure {
  exitCode?: number;
  signal?: NodeJS.Signals | null;
  httpStatus?: number;
  responseHeaders?: Readonly<Record<string, string>>;
  responseBody?: unknown;
  error?: Error;
}

/**
 * Machine-readable retry semantics returned from `interpretFailure`. The
 * dispatcher reads `retryable` to decide retry vs fail; `errorCode` is the
 * stable string emitted to telemetry / dashboards.
 *
 * Stable error codes (extend; do not rename without a council pass):
 *   - `rate_limit`            — 429 / Anthropic 529; honor `retryAfterMs`.
 *   - `auth_failed`           — 401 / 403, missing or invalid credential.
 *   - `workspace_not_trusted` — `gemini` exit 55, missing `GEMINI_CLI_TRUST_WORKSPACE`.
 *   - `binary_missing`        — subprocess adapter could not find its binary.
 *   - `endpoint_unreachable`  — API adapter network drop / DNS failure.
 *   - `provider_overloaded`   — 503 / 529 overloaded; transient.
 *   - `timeout`               — dispatcher killed via SIGKILL or AbortController.
 *   - `cancelled`             — user-initiated cancel (not a real failure).
 *   - `bad_request`           — 4xx on a non-auth code path; usually NOT retryable.
 *   - `unknown`               — escape hatch; keep `humanMessage` informative.
 */
export interface InterpretedFailure {
  errorCode: string;
  retryable: boolean;
  /** Server-suggested retry delay (Retry-After header, parsed body, or fixed default). */
  retryAfterMs?: number;
  /** Human-readable diagnostic — surfaced as `errorMessage` on /complete. */
  humanMessage: string;
}

// ---------------------------------------------------------------------------
// Common adapter contract.
// ---------------------------------------------------------------------------

/**
 * The single contract the dispatcher consumes. Every entry in the registry
 * — subprocess CLI or pure-HTTP API — implements this shape. The dispatcher
 * does NOT branch on `transport` for the hot path: it calls
 * `environmentChecks → run → interpretFailure` and forwards the events. A
 * branch only happens at the spawn boundary (which doesn't exist for API
 * adapters) and at the `RunResult.exitCode` vs `httpStatus` assertion in
 * the completion body builder.
 */
export interface AdapterHandler {
  /**
   * The `AGENT_ADAPTER_TYPES` value this handler implements. The registry
   * is keyed on this; declaring it as the literal type (e.g.
   * `readonly type: "claude_local"`) gives compile-time exhaustiveness
   * via the registry's `satisfies` clause.
   *
   * Mirrors `AgentAdapterType` from `@founderos/shared` — kept as the
   * runner-local `RunnerAdapterType` mirror so the runner package stays
   * free of the shared deep dep (it ships to npm as a leaf). The DB CHECK
   * constraint + cloud-side Zod schema enforce validity at the boundary.
   */
  readonly type: RunnerAdapterType;

  /**
   * Pre-flight environment check. Async; permitted to perform read-only
   * fs probes (`stat`, `access`) and env lookups. MUST NOT spawn processes
   * or do network I/O — that belongs in `run()`.
   *
   * Returns `{ ok: false, reason, remediation }` to abort the job locally
   * with a structured failure (cliVersion = "unknown", errorMessage =
   * `reason`); the dispatcher does not invoke `run()` after a failed check.
   */
  environmentChecks(ctx: EnvironmentContext): Promise<EnvironmentCheckResult>;

  /**
   * Execute the job. Yields a stream of provider-neutral
   * {@link RunnerEvent}s as the adapter produces them; the dispatcher
   * forwards each event to the cloud event-batcher. The generator's
   * **return value** is the final {@link RunResult} — the dispatcher
   * MUST capture it from the generator's terminal step (e.g. by reading
   * `iter.next()`'s `value` once `done === true`, or by returning it from
   * a wrapper helper). Iterating events with a bare `for await` loop and
   * dropping the return value loses cost / sessionId / exitCode silently.
   *
   * Cancellation: the adapter MUST honor `signal.aborted` — subprocess
   * adapters by killing the child, API adapters by aborting the fetch.
   * The dispatcher fires the abort on user-cancel and on the hard timeout
   * (after the soft SIGTERM equivalent has expired, where applicable).
   */
  run(ctx: RunContext, signal: AbortSignal): AsyncGenerator<RunnerEvent, RunResult, void>;

  /**
   * Translate a native failure into machine-readable retry semantics. The
   * dispatcher calls this on any non-`completed` outcome — including when
   * `run()` throws — to decide retry vs fail and to format the human
   * message that lands in the UI run log.
   *
   * Pure — no I/O. Adapters that need provider-version-dependent logic
   * (e.g. "Gemini 2.5 used to return 503 here, 3.x returns 429") should
   * encode that in the function body; do not add a separate version param.
   */
  interpretFailure(failure: AdapterFailure): InterpretedFailure;
}

// ---------------------------------------------------------------------------
// Subprocess transport — claude_local, gemini_local, codex_local, cursor.
// ---------------------------------------------------------------------------

/**
 * Inputs the subprocess adapter receives when the dispatcher asks it to
 * compute argv. Mirrors {@link RunContext} but adds the materialized
 * instructions tempfile path (the dispatcher resolves it before calling
 * `buildArgs`, so adapters stay pure).
 */
export interface BuildArgsContext {
  prompt: string;
  sessionId?: string | null;
  authMode: AuthMode;
  workdir: string;
  /**
   * Adapter-specific tunables — same shape as `RunContext.adapterConfig`,
   * narrowed by the adapter via its own Zod schema.
   */
  adapterConfig: Readonly<Record<string, unknown>>;
  /**
   * Path to the materialized instructions tempfile, or null when the cloud
   * did not send `runtimeConfig.instructionsFileContent`. The dispatcher
   * cleans up the file after `run()` resolves; adapters MUST NOT delete it.
   */
  instructionsFilePath: string | null;
}

/**
 * Subprocess CLI adapter. Implements {@link AdapterHandler} plus the two
 * subprocess-specific seams (`buildArgs`, `promptTransport`) that the
 * adapter's `run()` typically composes internally. Exposing them on the
 * interface gives unit tests a fixture seam — pin argv per provider
 * (`claude --print -` vs `gemini --json` vs `codex exec --stream`) without
 * spawning a child.
 */
export interface SubprocessAdapter extends AdapterHandler {
  readonly transport: "subprocess";

  /**
   * Default executable name to spawn when `adapter_config.binary` is unset.
   * Examples: `claude`, `gemini`, `codex`, `cursor`. Resolved via PATH at
   * spawn time — adapters do not need to compute absolute paths.
   */
  readonly defaultBinary: string;

  /**
   * Build argv. Pure — no I/O, no spawn. The dispatcher invokes this at
   * the start of `run()` (or composes it inside `run()`), then passes the
   * argv to `child_process.spawn` along with the env from `RunContext`.
   *
   * Why exposed on the interface (not buried in `run()`): per-provider
   * unit tests pin the exact argv. Without this seam, every test would
   * have to mock `spawn` to capture the argv, which is brittle.
   */
  buildArgs(ctx: BuildArgsContext): string[];

  /**
   * Send the prompt to the spawned child. Adapter chooses the transport:
   *   - claude_local: writes to `child.stdin` and ends.
   *   - gemini_local: same (stdin); some flags use a flag-arg form.
   *   - codex_local: stdin (codex exec reads from stdin).
   *   - future adapters may use a tempfile-on-disk + an extra argv arg.
   *
   * Returns when the prompt is fully written + (optionally) stdin closed.
   * Errors from the underlying stream propagate; the dispatcher treats
   * a `promptTransport` reject as a `binary_missing` / `endpoint_unreachable`
   * equivalent and routes through `interpretFailure`.
   */
  promptTransport(child: ChildProcess, prompt: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// API transport — openai_api, anthropic_api, gemini_api.
// ---------------------------------------------------------------------------

/**
 * Pure-HTTP API adapter. Implements {@link AdapterHandler} only; there is
 * no `buildArgs` or `promptTransport` seam because there is no child
 * process — `run()` owns the entire HTTP cycle (request body assembly,
 * SSE / JSON-stream parsing, retry-after header reads, AbortController
 * wiring).
 *
 * Why no separate `buildRequest` seam (parallel to `buildArgs`): the
 * request body is intimate with the parsed event stream — adapters reuse
 * helpers (e.g. `formatMessages(prompt, sessionHistory)`) that are not
 * unit-test surfaces in their own right. Pinning the request via fetch
 * mock is sufficient.
 */
export interface ApiAdapter extends AdapterHandler {
  readonly transport: "api";

  /**
   * Default endpoint URL when `adapter_config.endpoint` is unset.
   * Examples:
   *   - openai_api:    `https://api.openai.com/v1/responses`
   *   - anthropic_api: `https://api.anthropic.com/v1/messages`
   *   - gemini_api:    `https://generativelanguage.googleapis.com/v1beta/...`
   */
  readonly defaultEndpoint: string;
}

// ---------------------------------------------------------------------------
// Registry value type.
// ---------------------------------------------------------------------------

/**
 * The registry value is the disjunction. Dispatch code that needs to
 * branch on transport does so via the discriminant `transport`:
 *
 * ```ts
 * if (handler.transport === "subprocess") {
 *   const argv = handler.buildArgs(ctx);
 *   // ...
 * }
 * ```
 *
 * Most dispatch code does NOT branch — `run()` and `interpretFailure()`
 * are transport-agnostic.
 */
export type AnyAdapter = SubprocessAdapter | ApiAdapter;

// ---------------------------------------------------------------------------
// Test seam.
// ---------------------------------------------------------------------------

/**
 * Test seam re-export so handler unit tests can spell `typeof spawn`
 * without pulling in the node:child_process types directly. Preserved
 * from the prior interface for compatibility with the existing
 * `spawn-pure.test.ts`.
 */
export type SpawnImpl = typeof nodeSpawn;
