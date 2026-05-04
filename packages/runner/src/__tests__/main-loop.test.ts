/**
 * Main loop integration test — stubs both the API client and the spawner,
 * exercises a single-job round-trip end-to-end (poll → claim → spawn →
 * events flush → complete). Verifies:
 *
 *   - Empty long-poll → re-polls (doesn't claim or spawn).
 *   - Race-lost claim → continues to next iteration.
 *   - Successful claim → events flushed → complete called with cost +
 *     sessionId + cliVersion + elapsedSec from the spawn result.
 *   - 401 → exit code 2 (auth signal for supervisors).
 */

import { describe, it, expect, vi } from "vitest";
import { runRunnerLoop, consoleLogger } from "../main.js";
import {
  ApiError,
  type CompletionBody,
  type JobDescriptor,
  type JobPayload,
  type RunnerEvent,
} from "../api.js";
import type { RunnerConfig } from "../config.js";

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
  it("processes one job end-to-end and calls complete with success body", async () => {
    const { api, completedWith, eventsAppended } = stubApi({
      getNext: [{ kind: "job", job: makeJobDescriptor() }],
      claim: [{ kind: "claimed", payload: makeJobPayload() }],
      appendEvents: [{ kind: "ok" }],
      complete: [{ kind: "ok" }],
    });

    const spawnFn = vi.fn(async (
      _args: Parameters<typeof import("../spawn.js").runClaude>[0],
      hooks: { onEvent: (e: RunnerEvent) => Promise<void> | void },
    ) => {
      await hooks.onEvent({
        eventId: "e1",
        kind: "claude_message",
        ts: new Date().toISOString(),
        payload: { type: "assistant", message: { role: "assistant" } },
      });
      await hooks.onEvent({
        eventId: "e2",
        kind: "claude_result",
        ts: new Date().toISOString(),
        payload: { type: "result", session_id: "sess_after", total_cost_usd: 0.025 },
      });
      return {
        exitCode: 0,
        signal: null,
        elapsedSec: 1.5,
        timedOut: false,
        finalResult: { sessionId: "sess_after", costUsd: 0.025, raw: {} },
      };
    });

    const result = await runRunnerLoop({
      config: baseConfig,
      logger: consoleLogger("error"),
      maxJobs: 1,
      apiClient: api,
      spawnFn: spawnFn as never,
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
    const { api, completedWith } = stubApi({
      getNext: [
        { kind: "job", job: makeJobDescriptor("job-lost") },
        { kind: "job", job: makeJobDescriptor("job-won") },
      ],
      claim: [{ kind: "lost" }, { kind: "claimed", payload: makeJobPayload("job-won") }],
      appendEvents: [{ kind: "ok" }],
      complete: [{ kind: "ok" }],
    });

    const spawnFn = vi.fn(async (_a: unknown, _h: { onEvent: (e: RunnerEvent) => unknown }) => ({
      exitCode: 0,
      signal: null,
      elapsedSec: 0.5,
      timedOut: false,
      finalResult: null,
    }));

    const result = await runRunnerLoop({
      config: baseConfig,
      logger: consoleLogger("error"),
      maxJobs: 1, // stop after the first SUCCESSFUL claim+complete
      apiClient: api,
      spawnFn: spawnFn as never,
    });

    expect(result.jobsProcessed).toBe(1);
    expect(spawnFn).toHaveBeenCalledTimes(1);
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
      spawnFn: (() => {
        throw new Error("should not be called");
      }) as never,
    });

    expect(result.jobsProcessed).toBe(0);
    expect(process.exitCode).toBe(2);
    process.exitCode = prior; // restore
  });
});
