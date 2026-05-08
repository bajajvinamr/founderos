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

import { ApiError, RunnerApiClient, makeEventId, type CompletionBody, type RunnerEvent } from "./api.js";
import { isDispatcherV2Enabled, type RunnerConfig } from "./config.js";
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

  // PHASE-S7 dispatcher gate. Absence = legacy runClaude (safe default).
  // When truthy, downstream tickets (S7.A.1..S7.D.6) will replace this
  // branch with a real multi-adapter dispatch. Until then we warn and
  // fall through to runClaude so the flag is wireable end-to-end without
  // needing the v2 module to exist yet.
  // TODO(S7.A.5): replace with dispatch() once handlers land.
  const v2 = isDispatcherV2Enabled();
  if (v2) {
    console.info("[dispatcher] v2 (multi-adapter)");
    if (!opts.spawnFn) {
      console.warn(
        "[dispatcher] v2 path requested but not yet implemented; falling back to v1",
      );
    }
  } else {
    console.info("[dispatcher] v1 (legacy runClaude)");
  }
  const spawnImpl = opts.spawnFn ?? runClaude;

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
      await runOneJob({ payload: claim.payload, api, config, logger, spawnImpl });
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
}

async function runOneJob(input: RunOneJobInput): Promise<void> {
  const { payload, api, config, logger, spawnImpl } = input;
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

  // Drain any pending events before completing.
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flush();

  const cliVersion = await readClaudeVersion(config).catch(() => "unknown");

  let body: CompletionBody;
  if (result) {
    const status: CompletionBody["status"] = result.timedOut
      ? "failed"
      : result.exitCode === 0
        ? "completed"
        : "failed";
    body = {
      status,
      exitCode: result.exitCode,
      signal: result.signal,
      elapsedSec: result.elapsedSec,
      costMicros:
        typeof result.finalResult?.costUsd === "number"
          ? Math.round(result.finalResult.costUsd * 1_000_000)
          : 0,
      sessionId: result.finalResult?.sessionId ?? null,
      cliVersion,
      errorMessage: result.timedOut ? "runner timed out" : null,
    };
  } else {
    body = {
      status: "failed",
      exitCode: -1,
      signal: null,
      elapsedSec: 0,
      costMicros: 0,
      sessionId: null,
      cliVersion,
      errorMessage: errorMessage ?? "spawn failed",
    };
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

async function readClaudeVersion(config: RunnerConfig): Promise<string> {
  // Best-effort. Use child_process synchronously to avoid extra plumbing on
  // the hot path; the runner only reads this once per job.
  const { spawnSync } = await import("node:child_process");
  const out = spawnSync(config.claudeBin, ["--version"], { encoding: "utf-8" });
  return (out.stdout ?? out.stderr ?? "").trim() || "unknown";
}

export { makeEventId };
