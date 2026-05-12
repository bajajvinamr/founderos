/**
 * Main poll loop. Coordinates: long-poll → claim → spawn → events → complete.
 *
 * Concurrency: v0.1 is single-threaded. One job at a time per runner. A
 * founder running multiple agents in parallel can run multiple `founderos-runner`
 * processes against the same token (lastSeenAt is debounced server-side) or
 * issue one token per machine. v0.2 may add intra-process concurrency.
 *
 * Backoff:
 *   - On API errors during the long-poll, exponential backoff (1s → 30s cap)
 *     so a 500-erroring server doesn't get hammered.
 *   - On 401 (token revoked / invalid), we exit non-zero so a supervisor
 *     (systemd, launchd) can surface the auth failure to the operator.
 */

import { setTimeout as sleep } from "node:timers/promises";

import {
  ApiError,
  RunnerApiClient,
  makeEventId,
  type CompletionBody,
  type RunnerAdapterType,
  type RunnerEvent,
} from "./api.js";
import { type RunnerConfig } from "./config.js";
import { runAdapter, UnknownAdapterTypeError } from "./dispatcher.js";
import type { RunContext, RunResult } from "./handlers/types.js";
import { RUNNER_VERSION } from "./version.js";
import { runClaude } from "./spawn.js";

export interface RunnerLogger {
  debug: (msg: string, extra?: Record<string, unknown>) => void;
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
}

export function consoleLogger(level: RunnerConfig["logLevel"]): RunnerLogger {
  const order: Record<RunnerConfig["logLevel"], number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const min = order[level];
  const fmt = (m: string, e?: Record<string, unknown>) =>
    e && Object.keys(e).length > 0 ? `${m} ${JSON.stringify(e)}` : m;
  return {
    debug: (m, e) => order.debug >= min && console.log(`[debug] ${fmt(m, e)}`),
    info:  (m, e) => order.info  >= min && console.log(`[info ] ${fmt(m, e)}`),
    warn:  (m, e) => order.warn  >= min && console.warn(`[warn ] ${fmt(m, e)}`),
    error: (m, e) => order.error >= min && console.error(`[error] ${fmt(m, e)}`),
  };
}

export interface RunnerLoopOptions {
  config: RunnerConfig;
  logger?: RunnerLogger;
  /** Stop after N jobs (test seam). 0 / undefined = run forever. */
  maxJobs?: number;
  /** Test seam: substitute the API client. */
  apiClient?: RunnerApiClient;
  /** Test seam: substitute the spawner. Receives the same args as runClaude. */
  spawnFn?: typeof runClaude;
}

/**
 * Run the polling loop. Returns when stopped (signal or maxJobs reached).
 */
export async function runRunnerLoop(opts: RunnerLoopOptions): Promise<{ jobsProcessed: number }> {
  const { config, maxJobs } = opts;
  const logger = opts.logger ?? consoleLogger(config.logLevel);
  const api = opts.apiClient ?? new RunnerApiClient(config);

  // The multi-adapter dispatcher (S7.1.b.3 `runAdapter`) is the canonical
  // execution path: claude_local / gemini_local / codex_local / openai_api /
  // ... all share one code path. Test seam: when `opts.spawnFn` is set, the
  // legacy direct-`runClaude` path runs instead so existing main-loop
  // integration tests can pin the SpawnArgs → SpawnResult surface without
  // exercising the dispatcher.
  const spawnImpl = opts.spawnFn ?? runClaude;
  const useDispatcher = !opts.spawnFn;

  let jobsProcessed = 0;
  let backoffMs = 0;
  const maxBackoffMs = 30_000;

  // Ctrl-C / SIGTERM gracefully stops at the next loop boundary.
  let stopping = false;
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    logger.info("received stop signal — finishing current job then exiting");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  logger.info(`founderos-runner v${RUNNER_VERSION} starting`, {
    serverUrl: config.serverUrl,
    claudeBin: config.claudeBin,
  });

  try {
    while (!stopping && (!maxJobs || jobsProcessed < maxJobs)) {
      if (backoffMs > 0) await sleep(backoffMs);

      let next: Awaited<ReturnType<RunnerApiClient["getNext"]>>;
      try {
        next = await api.getNext();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          logger.error("auth rejected — token revoked or invalid", { status: err.status });
          process.exitCode = 2;
          return { jobsProcessed };
        }
        backoffMs = Math.min(maxBackoffMs, backoffMs > 0 ? backoffMs * 2 : 1_000);
        logger.warn("getNext failed; backing off", { err: String(err), backoffMs });
        continue;
      }
      backoffMs = 0;

      if (next.kind === "empty") {
        // 30s timeout from server; immediate re-poll.
        continue;
      }

      const { jobId, agentName } = next.job;
      logger.info("got job", { jobId, agent: agentName });

      let claim: Awaited<ReturnType<RunnerApiClient["claim"]>>;
      try {
        claim = await api.claim(jobId);
      } catch (err) {
        logger.warn("claim failed; will re-poll", { jobId, err: String(err) });
        continue;
      }
      if (claim.kind === "lost") {
        logger.info("claim race lost; re-polling", { jobId });
        continue;
      }
      if (claim.kind === "gone") {
        logger.info("job gone before claim", { jobId });
        continue;
      }

      jobsProcessed += 1;
      await runOneJob({ payload: claim.payload, api, config, logger, spawnImpl, useDispatcher });
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  logger.info("runner stopped", { jobsProcessed });
  return { jobsProcessed };
}

interface RunOneJobInput {
  payload: Awaited<ReturnType<RunnerApiClient["claim"]>> extends infer R
    ? R extends { kind: "claimed"; payload: infer P }
      ? P
      : never
    : never;
  api: RunnerApiClient;
  config: RunnerConfig;
  logger: RunnerLogger;
  spawnImpl: typeof runClaude;
  /**
   * When true, route the job through `runAdapter()` (S7.1.b.3 dispatcher)
   * instead of the legacy direct-`runClaude` path. Dispatcher-mediated
   * runs read `payload.adapterType` and forward events / capture the
   * terminal `RunResult` from the AsyncGenerator.
   */
  useDispatcher: boolean;
}

async function runOneJob(input: RunOneJobInput): Promise<void> {
  const { payload, api, config, logger, spawnImpl, useDispatcher } = input;
  const jobId = payload.jobId;

  // Buffered event shipper. Drains every 50ms or when the buffer hits 32 events.
  const queue: RunnerEvent[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let terminalReachedOnServer = false;

  const flush = async () => {
    if (queue.length === 0) return;
    const batch = queue.splice(0, queue.length);
    try {
      const res = await api.appendEvents(jobId, batch);
      if (res.kind === "terminal") {
        terminalReachedOnServer = true;
        logger.warn("server reports job already terminal; stopping event ship", { jobId });
      }
    } catch (err) {
      logger.warn("appendEvents failed; dropping batch", { jobId, batchSize: batch.length, err: String(err) });
    }
  };

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, 50);
  };

  const onEvent = async (evt: RunnerEvent) => {
    if (terminalReachedOnServer) return;
    queue.push(evt);
    if (queue.length >= 32) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      await flush();
    } else {
      scheduleFlush();
    }
  };

  // Pull instructions out of the runtime config. Server may have base64-encoded
  // an agent system-prompt file; runClaude materializes it to a tempfile.
  const rt = payload.runtimeConfig ?? {};
  const instructionsBase64 =
    typeof rt.instructionsFileContent === "string" ? rt.instructionsFileContent : null;

  const timeoutSec =
    typeof rt.timeoutSec === "number" && rt.timeoutSec > 0
      ? rt.timeoutSec
      : config.defaultTimeoutSec;

  // Drain pending events + read claude --version regardless of which path
  // produced the run; both legacy and dispatcher paths funnel through the
  // shared completion-body construction below.
  let body: CompletionBody | null = null;

  if (useDispatcher) {
    body = await runViaDispatcher({
      payload,
      timeoutSec,
      logger,
      onEvent,
    });
  } else {
    body = await runViaLegacy({
      payload,
      timeoutSec,
      instructionsBase64,
      config,
      logger,
      spawnImpl,
      onEvent,
    });
  }

  // Drain any pending events before completing.
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flush();

  // CLI version is a best-effort tag on the completion body. Both paths
  // leave it empty by default; we resolve it here via `claude --version`
  // so the legacy path keeps its prior behavior verbatim. The dispatcher
  // path's RunResult.providerVersion takes precedence when set — Phase 4
  // adapters (gemini_local, codex_local, openai_api) populate that field
  // directly so non-claude jobs don't shell out to `claude --version`.
  if (!body.cliVersion) {
    body.cliVersion = await readClaudeVersion(config).catch(() => "unknown");
  }

  try {
    const completeRes = await api.complete(jobId, body);
    if (completeRes.kind === "already_terminal") {
      logger.warn("complete returned 409 already_terminal; the cloud beat us to it", { jobId });
    } else {
      logger.info("job completed", { jobId, status: body.status, exitCode: body.exitCode });
    }
  } catch (err) {
    logger.error("complete failed", { jobId, err: String(err) });
  }
}

/** The `payload` shape carried out of a successful claim. Mirrors the
 *  inline conditional type on `RunOneJobInput.payload` so the helper
 *  signatures stay readable. */
type ClaimedPayload = RunOneJobInput["payload"];

/**
 * Legacy direct-`runClaude` execution path. Preserves existing behavior bit
 * for bit — same SpawnArgs, same SpawnResult → CompletionBody mapping. This
 * runs whenever a `spawnFn` test seam is provided (so the existing main-loop
 * integration tests keep pinning the same surface).
 */
async function runViaLegacy(args: {
  payload: ClaimedPayload;
  timeoutSec: number;
  instructionsBase64: string | null;
  config: RunnerConfig;
  logger: RunnerLogger;
  spawnImpl: typeof runClaude;
  onEvent: (evt: RunnerEvent) => Promise<void>;
}): Promise<CompletionBody> {
  const { payload, timeoutSec, instructionsBase64, config, logger, spawnImpl, onEvent } = args;
  const jobId = payload.jobId;
  const rt = payload.runtimeConfig ?? {};

  let result: Awaited<ReturnType<typeof runClaude>> | null = null;
  let errorMessage: string | null = null;
  try {
    result = await spawnImpl(
      {
        binary: config.claudeBin,
        prompt: payload.prompt,
        sessionId: payload.sessionId ?? null,
        model: typeof rt.model === "string" ? rt.model : null,
        maxTurns: typeof rt.maxTurns === "number" ? rt.maxTurns : null,
        instructionsBase64,
        timeoutSec,
        addDirs: payload.addDirs,
      },
      { onEvent },
    );
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.error("spawn failed", { jobId, err: errorMessage });
  }

  if (result) {
    const status: CompletionBody["status"] = result.timedOut
      ? "failed"
      : result.exitCode === 0
        ? "completed"
        : "failed";
    return {
      status,
      exitCode: result.exitCode,
      signal: result.signal,
      elapsedSec: result.elapsedSec,
      costMicros:
        typeof result.finalResult?.costUsd === "number"
          ? Math.round(result.finalResult.costUsd * 1_000_000)
          : 0,
      sessionId: result.finalResult?.sessionId ?? null,
      cliVersion: "",
      errorMessage: result.timedOut ? "runner timed out" : null,
    };
  }
  return {
    status: "failed",
    exitCode: -1,
    signal: null,
    elapsedSec: 0,
    costMicros: 0,
    sessionId: null,
    cliVersion: "",
    errorMessage: errorMessage ?? "spawn failed",
  };
}

/**
 * Multi-adapter dispatcher execution path (S7.1.c).
 *
 * Reads `payload.adapterType` (defaulting to `"claude_local"` for pre-S7
 * server builds — see `JobPayload.adapterType` doc) and routes the run
 * through {@link runAdapter}. The dispatcher is an
 * `AsyncGenerator<RunnerEvent, RunResult, void>`; we drive `iter.next()`
 * manually so the terminal `RunResult` is captured (a bare `for await`
 * loop drops it — verified by `dispatcher.test.ts` test (e)).
 *
 * Failure modes:
 *   - {@link UnknownAdapterTypeError} → fail the job with errorCode
 *     `unknown_adapter_type` (the cloud's run log surfaces this verbatim).
 *   - Any other thrown error from the adapter → fail with the error message.
 *   - Generator returns `undefined` (contract violation by an adapter) →
 *     fail with a clear "no result" diagnostic so the regression is
 *     loud rather than silent.
 *
 * Phase 4 work — folding gemini_local, codex_local, openai_api adapter
 * implementations behind this same dispatcher path — slots in by adding
 * registry entries in `adapters/index.ts`; this function does not change.
 */
async function runViaDispatcher(args: {
  payload: ClaimedPayload;
  timeoutSec: number;
  logger: RunnerLogger;
  onEvent: (evt: RunnerEvent) => Promise<void>;
}): Promise<CompletionBody> {
  const { payload, timeoutSec, logger, onEvent } = args;
  const jobId = payload.jobId;
  const adapterType: RunnerAdapterType = payload.adapterType ?? "claude_local";

  // Build the provider-neutral RunContext from the cloud-provided payload.
  // adapterConfig is the open-shape forward of `runtimeConfig` minus the
  // fields RunContext already carries explicitly — adapters narrow it
  // internally via Zod / type guards.
  const ctx: RunContext = {
    jobId,
    prompt: payload.prompt,
    workdir: process.cwd(),
    env: process.env,
    // S7.1.c does not yet route subscription-vs-api-key intent from the
    // cloud claim — default to "subscription" (the legacy claude_local
    // shape, where the CLI reads ambient ~/.claude/credentials.json).
    // Phase-4 PRs add this field to the claim payload.
    authMode: "subscription",
    timeoutSec,
    adapterConfig: payload.runtimeConfig ?? {},
    sessionId: payload.sessionId ?? null,
  };

  // The dispatcher does not yet enforce timeout escalation here (S7.1.c
  // follow-up). For now we wire the AbortSignal so adapters that already
  // honor it (API adapters, future subprocess adapters) get the cancel
  // wired end-to-end; the legacy claude_local path enforces timeout via
  // setTimeout inside `runClaude` and will move to AbortController-based
  // escalation when its `run()` is folded in.
  const ctrl = new AbortController();

  let result: RunResult | undefined;
  try {
    const iter = runAdapter(adapterType, ctx, ctrl.signal);
    while (true) {
      const step = await iter.next();
      if (step.done) {
        result = step.value;
        break;
      }
      await onEvent(step.value);
    }
  } catch (err) {
    if (err instanceof UnknownAdapterTypeError) {
      logger.error("unknown adapter type — failing job", { jobId, adapterType: err.adapterType });
      return {
        status: "failed",
        exitCode: -1,
        signal: null,
        elapsedSec: 0,
        costMicros: 0,
        sessionId: null,
        cliVersion: "",
        errorMessage: `unknown_adapter_type: no handler registered for adapterType="${err.adapterType}"`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error("dispatcher run failed", { jobId, adapterType, err: message });
    return {
      status: "failed",
      exitCode: -1,
      signal: null,
      elapsedSec: 0,
      costMicros: 0,
      sessionId: null,
      cliVersion: "",
      errorMessage: message,
    };
  }

  if (!result) {
    // AsyncGenerator contract: `step.done = true` MUST carry a RunResult
    // in `step.value`. An adapter that returns undefined is a bug worth
    // surfacing loudly rather than silently coercing to a 0-cost success.
    logger.error("dispatcher returned without a result", { jobId, adapterType });
    return {
      status: "failed",
      exitCode: -1,
      signal: null,
      elapsedSec: 0,
      costMicros: 0,
      sessionId: null,
      cliVersion: "",
      errorMessage: `dispatcher_no_result: adapter "${adapterType}" finished without yielding a RunResult`,
    };
  }

  return {
    status: result.status === "cancelled" ? "cancelled" : result.status,
    exitCode: typeof result.exitCode === "number" ? result.exitCode : 0,
    signal: result.signal ?? null,
    elapsedSec: result.elapsedSec,
    costMicros:
      typeof result.costUsd === "number" ? Math.round(result.costUsd * 1_000_000) : 0,
    sessionId: result.sessionId ?? null,
    cliVersion: result.providerVersion ?? "",
    errorMessage: result.errorMessage ?? null,
  };
}

async function readClaudeVersion(config: RunnerConfig): Promise<string> {
  // Best-effort. Use child_process synchronously to avoid extra plumbing on
  // the hot path; the runner only reads this once per job.
  const { spawnSync } = await import("node:child_process");
  const out = spawnSync(config.claudeBin, ["--version"], { encoding: "utf-8" });
  return (out.stdout ?? out.stderr ?? "").trim() || "unknown";
}

export { makeEventId };
