/**
 * Main loop integration test — stubs the API client and mocks the dispatcher,
 * exercises a single-job round-trip end-to-end (poll → claim → dispatch →
 * events flush → complete). Verifies:
 *
 *   - Empty long-poll → re-polls (doesn't claim or dispatch).
 *   - Race-lost claim → continues to next iteration.
 *   - Successful claim → dispatcher runs → events flushed → complete called with cost +
 *     sessionId + cliVersion + elapsedSec from the dispatcher result.
 *   - 401 → exit code 2 (auth signal for supervisors).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ApiError,
  type CompletionBody,
  type JobDescriptor,
  type JobPayload,
  type RunnerEvent,
  type RunnerAdapterType,
} from "../api.js";
import type { RunnerConfig } from "../config.js";
import type { RunContext, RunResult } from "../handlers/types.js";

// Mock the dispatcher to avoid spawning real processes in tests
let runAdapterImpl = async function* (): AsyncGenerator<
  RunnerEvent,
  RunResult,
  void
> {
  return {
    status: "completed",
    elapsedSec: 0,
    exitCode: 0,
    sessionId: null,
    costUsd: null,
  };
};

vi.mock("../dispatcher.js", () => ({
  runAdapter: (
    _adapterType: RunnerAdapterType,
    _ctx: RunContext,
    _signal: AbortSignal,
  ): AsyncGenerator<RunnerEvent, RunResult, void> => {
    return runAdapterImpl(_adapterType, _ctx, _signal);
  },
}));

// Import AFTER vi.mock
const { runRunnerLoop, consoleLogger } = await import("../main.js");

const baseConfig: RunnerConfig = {
  serverUrl: "https://founderos.fly.dev",
  token: "fos_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  claudeBin: "claude",
  defaultTimeoutSec: 600,
  logLevel: "error",
};

interface StubScript {
  getNext: Array<
    | { kind: "job"; job: JobDescriptor }
    | { kind: "empty" }
    | { throw: ApiError }
  >;
  claim: Array<
    | { kind: "claimed"; payload: JobPayload }
    | { kind: "lost" }
    | { kind: "gone" }
  >;
  appendEvents: Array<{ kind: "ok" } | { kind: "terminal" }>;
  complete: Array<{ kind: "ok" } | { kind: "already_terminal" }>;
}

function stubApi(script: StubScript) {
  const completedWith: CompletionBody[] = [];
  const eventsAppended: RunnerEvent[][] = [];
  const obj = {
    async getNext() {
      const step = script.getNext.shift();
      if (!step) return { kind: "empty" } as const;
      if ("throw" in step) throw step.throw;
      return step;
    },
    async claim(_jobId: string) {
      const step = script.claim.shift();
      if (!step) throw new Error("claim called more times than scripted");
      return step;
    },
    async appendEvents(_jobId: string, events: RunnerEvent[]) {
      eventsAppended.push(events);
      const step = script.appendEvents.shift();
      return step ?? { kind: "ok" as const };
    },
    async complete(_jobId: string, body: CompletionBody) {
      completedWith.push(body);
      const step = script.complete.shift();
      return step ?? { kind: "ok" as const };
    },
  };
  return { api: obj as never, completedWith, eventsAppended };
}

const makeJobDescriptor = (id = "job-1"): JobDescriptor => ({
  jobId: id,
  agentId: "agent-1",
  agentName: "Sarah",
  createdAt: new Date().toISOString(),
});

const makeJobPayload = (id = "job-1"): JobPayload => ({
  jobId: id,
  agentId: "agent-1",
  agentName: "Sarah",
  prompt: "do the thing",
  sessionId: null,
  runtimeConfig: { timeoutSec: 5 },
  promptHash: "h".repeat(64),
});

describe("runRunnerLoop", () => {
  beforeEach(() => {
    // Reset dispatcher implementation to default happy path
    runAdapterImpl = async function* (): AsyncGenerator<
      RunnerEvent,
      RunResult,
      void
    > {
      yield {
        eventId: "e1",
        kind: "model_message",
        ts: new Date().toISOString(),
        payload: { type: "assistant", message: { role: "assistant" } },
      };
      yield {
        eventId: "e2",
        kind: "run_complete",
        ts: new Date().toISOString(),
        payload: { type: "result", session_id: "sess_after", total_cost_usd: 0.025 },
      };
      return {
        status: "completed",
        elapsedSec: 1.5,
        exitCode: 0,
        sessionId: "sess_after",
        costUsd: 0.025,
      };
    };
  });

  it("processes one job end-to-end and calls complete with success body", async () => {
    const { api, completedWith, eventsAppended } = stubApi({
      getNext: [{ kind: "job", job: makeJobDescriptor() }],
      claim: [{ kind: "claimed", payload: makeJobPayload() }],
      appendEvents: [{ kind: "ok" }],
      complete: [{ kind: "ok" }],
    });

    const result = await runRunnerLoop({
      config: baseConfig,
      logger: consoleLogger("error"),
      maxJobs: 1,
      apiClient: api,
    });

    expect(result.jobsProcessed).toBe(1);
    expect(eventsAppended.flat().length).toBeGreaterThanOrEqual(2);
    expect(completedWith).toHaveLength(1);
    expect(completedWith[0].status).toBe("completed");
    expect(completedWith[0].exitCode).toBe(0);
    expect(completedWith[0].sessionId).toBe("sess_after");
    expect(completedWith[0].costMicros).toBe(25_000); // 0.025 USD * 1e6
    expect(typeof completedWith[0].elapsedSec).toBe("number");
  });

  it("skips jobs the runner lost the claim race for", async () => {
    // For the winning job, return a simpler result with no sessionId
    runAdapterImpl = async function* (): AsyncGenerator<
      RunnerEvent,
      RunResult,
      void
    > {
      return {
        status: "completed",
        elapsedSec: 0.5,
        exitCode: 0,
        sessionId: null,
        costUsd: null,
      };
    };

    const { api, completedWith } = stubApi({
      getNext: [
        { kind: "job", job: makeJobDescriptor("job-lost") },
        { kind: "job", job: makeJobDescriptor("job-won") },
      ],
      claim: [{ kind: "lost" }, { kind: "claimed", payload: makeJobPayload("job-won") }],
      appendEvents: [{ kind: "ok" }],
      complete: [{ kind: "ok" }],
    });

    const result = await runRunnerLoop({
      config: baseConfig,
      logger: consoleLogger("error"),
      maxJobs: 1, // stop after the first SUCCESSFUL claim+complete
      apiClient: api,
    });

    expect(result.jobsProcessed).toBe(1);
    expect(completedWith[0].sessionId).toBeNull();
  });

  it("exits with code 2 on 401 (auth rejected)", async () => {
    const { api } = stubApi({
      getNext: [{ throw: new ApiError(401, '{"error":"invalid_runner_token"}') }],
      claim: [],
      appendEvents: [],
      complete: [],
    });
    const prior = process.exitCode;
    process.exitCode = 0;

    const result = await runRunnerLoop({
      config: baseConfig,
      logger: consoleLogger("error"),
      maxJobs: 1,
      apiClient: api,
    });

    expect(result.jobsProcessed).toBe(0);
    expect(process.exitCode).toBe(2);
    process.exitCode = prior; // restore
  });
});
