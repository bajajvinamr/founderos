/**
 * Main-loop dispatcher-path tests — S7.1.c.
 *
 * Verifies that when `FOUNDEROS_DISPATCHER_V2=1` AND no `spawnFn` test
 * seam is provided, `runRunnerLoop` routes claimed jobs through the
 * S7.1.b.3 `runAdapter` dispatcher rather than the legacy direct-`runClaude`
 * path. Mocks `../dispatcher.js` so the test pins the dispatcher contract
 * (events forwarded, `RunResult` captured into `CompletionBody`) without
 * exercising the real `claudeLocalAdapter.run()` placeholder.
 *
 * Coverage:
 *   (a) happy path: events flushed, RunResult fields land in CompletionBody
 *   (b) UnknownAdapterTypeError → fail job with `unknown_adapter_type`
 *       errorMessage
 *   (c) generator throws → fail with the error's message
 *   (d) generator finishes without yielding a RunResult → fail with
 *       `dispatcher_no_result` errorMessage
 *   (e) `adapterType` from the claim payload reaches the dispatcher
 *       (defaults to claude_local when payload omits the field)
 */

import { describe, it, expect, vi } from "vitest";

import type { RunnerEvent, RunnerAdapterType } from "../api.js";
import {
  ApiError,
  type CompletionBody,
  type JobDescriptor,
  type JobPayload,
} from "../api.js";
import type { RunnerConfig } from "../config.js";
import type { RunContext, RunResult } from "../handlers/types.js";

const baseConfig: RunnerConfig = {
  serverUrl: "https://founderos.fly.dev",
  token: "fos_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  claudeBin: "claude",
  defaultTimeoutSec: 600,
  logLevel: "error",
};

interface DispatcherCall {
  adapterType: RunnerAdapterType;
  ctx: RunContext;
}

const dispatcherCalls: DispatcherCall[] = [];

// Default behavior, replaced per-test by setRunAdapterImpl. Lazy `let` so
// `vi.mock` factory captures the binding rather than the snapshot value.
type GenFactory = (
  adapterType: RunnerAdapterType,
  ctx: RunContext,
  signal: AbortSignal,
) => AsyncGenerator<RunnerEvent, RunResult, void>;

let runAdapterImpl: GenFactory = async function* (): AsyncGenerator<
  RunnerEvent,
  RunResult,
  void
> {
  // eslint-disable-next-line require-yield
  return {
    status: "completed",
    elapsedSec: 0,
    exitCode: 0,
    sessionId: null,
    costUsd: null,
  };
};

function setRunAdapterImpl(impl: GenFactory): void {
  runAdapterImpl = impl;
}

// Mirror the real UnknownAdapterTypeError shape so test (b) can throw it.
class UnknownAdapterTypeError extends Error {
  constructor(public readonly adapterType: string) {
    super(`No handler registered for adapter type: ${adapterType}`);
    this.name = "UnknownAdapterTypeError";
  }
}

vi.mock("../dispatcher.js", () => ({
  runAdapter: (
    adapterType: RunnerAdapterType,
    ctx: RunContext,
    signal: AbortSignal,
  ): AsyncGenerator<RunnerEvent, RunResult, void> => {
    dispatcherCalls.push({ adapterType, ctx });
    return runAdapterImpl(adapterType, ctx, signal);
  },
  UnknownAdapterTypeError,
}));

// Import AFTER vi.mock so the runOneJob helper sees the mocked dispatcher.
const { runRunnerLoop, consoleLogger } = await import("../main.js");

// ---------------------------------------------------------------------------
// Stub API client.
// ---------------------------------------------------------------------------

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

const makeJobPayload = (overrides: Partial<JobPayload> = {}): JobPayload => ({
  jobId: "job-1",
  agentId: "agent-1",
  agentName: "Sarah",
  prompt: "do the thing",
  sessionId: null,
  runtimeConfig: { timeoutSec: 5 },
  promptHash: "h".repeat(64),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests — dispatcher path.
// ---------------------------------------------------------------------------

describe("runRunnerLoop — S7.1.c dispatcher path", () => {
  it("(a) happy path: events forwarded, RunResult mapped onto CompletionBody", async () => {
    vi.stubEnv("FOUNDEROS_DISPATCHER_V2", "1");
    dispatcherCalls.length = 0;

    setRunAdapterImpl(async function* (): AsyncGenerator<
      RunnerEvent,
      RunResult,
      void
    > {
      yield {
        eventId: "e1",
        kind: "model_message",
        ts: "2026-05-09T00:00:00.000Z",
        payload: { type: "assistant" },
      };
      yield {
        eventId: "e2",
        kind: "run_complete",
        ts: "2026-05-09T00:00:00.001Z",
        payload: { type: "result" },
      };
      return {
        status: "completed",
        elapsedSec: 1.5,
        exitCode: 0,
        sessionId: "sess_after",
        costUsd: 0.025,
        providerVersion: "claude-cli/1.2.3",
      };
    });

    const { api, completedWith, eventsAppended } = stubApi({
      getNext: [{ kind: "job", job: makeJobDescriptor() }],
      claim: [{ kind: "claimed", payload: makeJobPayload({ adapterType: "claude_local" }) }],
      appendEvents: [{ kind: "ok" }],
      complete: [{ kind: "ok" }],
    });

    const result = await runRunnerLoop({
      config: baseConfig,
      logger: consoleLogger("error"),
      maxJobs: 1,
      apiClient: api,
      // Intentionally omit spawnFn so the dispatcher path runs.
    });

    expect(result.jobsProcessed).toBe(1);
    expect(eventsAppended.flat().length).toBeGreaterThanOrEqual(2);
    expect(completedWith).toHaveLength(1);
    expect(completedWith[0].status).toBe("completed");
    expect(completedWith[0].exitCode).toBe(0);
    expect(completedWith[0].sessionId).toBe("sess_after");
    expect(completedWith[0].costMicros).toBe(25_000); // 0.025 USD * 1e6
    expect(completedWith[0].elapsedSec).toBe(1.5);
    expect(completedWith[0].cliVersion).toBe("claude-cli/1.2.3");

    // Sanity: dispatcher was actually called, with the adapterType + RunContext
    // threaded through from the claim payload.
    expect(dispatcherCalls).toHaveLength(1);
    expect(dispatcherCalls[0].adapterType).toBe("claude_local");
    expect(dispatcherCalls[0].ctx.prompt).toBe("do the thing");
    expect(dispatcherCalls[0].ctx.timeoutSec).toBe(5);
    vi.unstubAllEnvs();
  });

  it("(b) UnknownAdapterTypeError → fail job with unknown_adapter_type", async () => {
    vi.stubEnv("FOUNDEROS_DISPATCHER_V2", "1");
    dispatcherCalls.length = 0;

    setRunAdapterImpl(async function* (): AsyncGenerator<
      RunnerEvent,
      RunResult,
      void
    > {
      throw new UnknownAdapterTypeError("gemini_local");
      // eslint-disable-next-line no-unreachable
      yield undefined as never;
    });

    const { api, completedWith } = stubApi({
      getNext: [{ kind: "job", job: makeJobDescriptor() }],
      claim: [{ kind: "claimed", payload: makeJobPayload({ adapterType: "gemini_local" }) }],
      appendEvents: [],
      complete: [{ kind: "ok" }],
    });

    await runRunnerLoop({
      config: baseConfig,
      logger: consoleLogger("error"),
      maxJobs: 1,
      apiClient: api,
    });

    expect(completedWith).toHaveLength(1);
    expect(completedWith[0].status).toBe("failed");
    expect(completedWith[0].errorMessage).toContain("unknown_adapter_type");
    expect(completedWith[0].errorMessage).toContain("gemini_local");
    vi.unstubAllEnvs();
  });

  it("(c) generator throws a non-UnknownAdapterTypeError → fail with that message", async () => {
    vi.stubEnv("FOUNDEROS_DISPATCHER_V2", "1");
    dispatcherCalls.length = 0;

    setRunAdapterImpl(async function* (): AsyncGenerator<
      RunnerEvent,
      RunResult,
      void
    > {
      throw new Error("synthetic adapter explosion");
      // eslint-disable-next-line no-unreachable
      yield undefined as never;
    });

    const { api, completedWith } = stubApi({
      getNext: [{ kind: "job", job: makeJobDescriptor() }],
      claim: [{ kind: "claimed", payload: makeJobPayload({ adapterType: "claude_local" }) }],
      appendEvents: [],
      complete: [{ kind: "ok" }],
    });

    await runRunnerLoop({
      config: baseConfig,
      logger: consoleLogger("error"),
      maxJobs: 1,
      apiClient: api,
    });

    expect(completedWith).toHaveLength(1);
    expect(completedWith[0].status).toBe("failed");
    expect(completedWith[0].errorMessage).toContain("synthetic adapter explosion");
    vi.unstubAllEnvs();
  });

  it("(d) generator returns undefined RunResult → fail with dispatcher_no_result", async () => {
    vi.stubEnv("FOUNDEROS_DISPATCHER_V2", "1");
    dispatcherCalls.length = 0;

    // A misbehaving adapter that yields no events and returns undefined.
    setRunAdapterImpl(async function* (): AsyncGenerator<
      RunnerEvent,
      RunResult,
      void
    > {
      // eslint-disable-next-line require-yield
      return undefined as unknown as RunResult;
    });

    const { api, completedWith } = stubApi({
      getNext: [{ kind: "job", job: makeJobDescriptor() }],
      claim: [{ kind: "claimed", payload: makeJobPayload({ adapterType: "claude_local" }) }],
      appendEvents: [],
      complete: [{ kind: "ok" }],
    });

    await runRunnerLoop({
      config: baseConfig,
      logger: consoleLogger("error"),
      maxJobs: 1,
      apiClient: api,
    });

    expect(completedWith).toHaveLength(1);
    expect(completedWith[0].status).toBe("failed");
    expect(completedWith[0].errorMessage).toContain("dispatcher_no_result");
    vi.unstubAllEnvs();
  });

  it("(e) missing adapterType in claim payload defaults to claude_local", async () => {
    vi.stubEnv("FOUNDEROS_DISPATCHER_V2", "1");
    dispatcherCalls.length = 0;

    setRunAdapterImpl(async function* (): AsyncGenerator<
      RunnerEvent,
      RunResult,
      void
    > {
      // eslint-disable-next-line require-yield
      return {
        status: "completed",
        elapsedSec: 0.1,
        exitCode: 0,
        sessionId: null,
        costUsd: null,
      };
    });

    const { api, completedWith } = stubApi({
      getNext: [{ kind: "job", job: makeJobDescriptor() }],
      // No adapterType field on the payload — server-side compat with
      // pre-S7.0.1 builds. Default must be claude_local.
      claim: [{ kind: "claimed", payload: makeJobPayload() }],
      appendEvents: [{ kind: "ok" }],
      complete: [{ kind: "ok" }],
    });

    await runRunnerLoop({
      config: baseConfig,
      logger: consoleLogger("error"),
      maxJobs: 1,
      apiClient: api,
    });

    expect(dispatcherCalls).toHaveLength(1);
    expect(dispatcherCalls[0].adapterType).toBe("claude_local");
    expect(completedWith).toHaveLength(1);
    expect(completedWith[0].status).toBe("completed");
    vi.unstubAllEnvs();
  });
});
