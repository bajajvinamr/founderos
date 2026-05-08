/**
 * PHASE-S7 dispatcher flag (`FOUNDEROS_DISPATCHER_V2`) — S7.A.0 acceptance.
 *
 * Two layers of coverage:
 *
 *   1. Pure unit: `isDispatcherV2Enabled()` parses the truthy set
 *      ("1" | "true" | "yes", case-insensitive) and treats absence /
 *      "0" / "false" / arbitrary values as falsy. This is the contract
 *      every downstream ticket (S7.A.1..S7.D.6) depends on; if it drifts,
 *      the rollback escape hatch documented in the runbook breaks.
 *
 *   2. Integration: `runRunnerLoop()` chooses the spawner path based on
 *      the env var and logs `[dispatcher] v1 (legacy runClaude)` or
 *      `[dispatcher] v2 (multi-adapter)` on startup. This is what the
 *      24h soak in docs/runbooks/dispatcher-v2-rollout.md greps for —
 *      losing this log line means the soak loses its primary signal.
 *
 * NOTE: until S7.A.5 lands, the v2 branch falls through to `runClaude`
 * with a `console.warn` ("v2 path requested but not yet implemented;
 * falling back to v1"). The test asserts the LOG (the observable
 * decision), not the dispatch difference, because the dispatch isn't
 * different yet.
 */

import { afterEach, describe, it, expect, vi } from "vitest";

import { isDispatcherV2Enabled, type RunnerConfig } from "../config.js";
import { runRunnerLoop, consoleLogger } from "../main.js";
import {
  ApiError,
  type CompletionBody,
  type JobDescriptor,
  type JobPayload,
  type RunnerEvent,
} from "../api.js";

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
    async appendEvents(_jobId: string, _events: RunnerEvent[]) {
      const step = script.appendEvents.shift();
      return step ?? { kind: "ok" as const };
    },
    async complete(_jobId: string, body: CompletionBody) {
      completedWith.push(body);
      const step = script.complete.shift();
      return step ?? { kind: "ok" as const };
    },
  };
  return { api: obj as never, completedWith };
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

describe("isDispatcherV2Enabled (pure parse)", () => {
  it("treats unset env as falsy (safe default)", () => {
    expect(isDispatcherV2Enabled({})).toBe(false);
  });

  it("treats empty / whitespace / 0 / false / arbitrary as falsy", () => {
    expect(isDispatcherV2Enabled({ FOUNDEROS_DISPATCHER_V2: "" })).toBe(false);
    expect(isDispatcherV2Enabled({ FOUNDEROS_DISPATCHER_V2: "   " })).toBe(false);
    expect(isDispatcherV2Enabled({ FOUNDEROS_DISPATCHER_V2: "0" })).toBe(false);
    expect(isDispatcherV2Enabled({ FOUNDEROS_DISPATCHER_V2: "false" })).toBe(false);
    expect(isDispatcherV2Enabled({ FOUNDEROS_DISPATCHER_V2: "no" })).toBe(false);
    expect(isDispatcherV2Enabled({ FOUNDEROS_DISPATCHER_V2: "maybe" })).toBe(false);
  });

  it("accepts 1 / true / yes (case-insensitive, trimmed)", () => {
    expect(isDispatcherV2Enabled({ FOUNDEROS_DISPATCHER_V2: "1" })).toBe(true);
    expect(isDispatcherV2Enabled({ FOUNDEROS_DISPATCHER_V2: "true" })).toBe(true);
    expect(isDispatcherV2Enabled({ FOUNDEROS_DISPATCHER_V2: "TRUE" })).toBe(true);
    expect(isDispatcherV2Enabled({ FOUNDEROS_DISPATCHER_V2: "True" })).toBe(true);
    expect(isDispatcherV2Enabled({ FOUNDEROS_DISPATCHER_V2: "yes" })).toBe(true);
    expect(isDispatcherV2Enabled({ FOUNDEROS_DISPATCHER_V2: "YES" })).toBe(true);
    expect(isDispatcherV2Enabled({ FOUNDEROS_DISPATCHER_V2: "  1  " })).toBe(true);
  });
});

describe("runRunnerLoop dispatcher path selection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("logs v1 path when FOUNDEROS_DISPATCHER_V2 is unset (safe default)", async () => {
    vi.stubEnv("FOUNDEROS_DISPATCHER_V2", "");

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Throw 401 on the first poll so the loop terminates deterministically
    // without us needing to drive a full job through it. The startup
    // `[dispatcher] v1` info log fires BEFORE the first getNext, so it's
    // captured even though jobsProcessed stays 0.
    const { api } = stubApi({
      getNext: [{ throw: new ApiError(401, '{"error":"test_terminate"}') }],
      claim: [],
      appendEvents: [],
      complete: [],
    });
    const priorExit = process.exitCode;
    process.exitCode = 0;

    await runRunnerLoop({
      config: baseConfig,
      logger: consoleLogger("error"),
      maxJobs: 1,
      apiClient: api,
      // Spawner must not be called — the loop bails on auth failure first.
      spawnFn: (() => {
        throw new Error("should not spawn after 401");
      }) as never,
    });
    process.exitCode = priorExit; // restore after the 401 path sets it to 2

    const infoCalls = infoSpy.mock.calls.map((c) => c.join(" "));
    expect(infoCalls).toContain("[dispatcher] v1 (legacy runClaude)");
    expect(infoCalls).not.toContain("[dispatcher] v2 (multi-adapter)");
    // No "v2 path requested" warn when the flag is unset.
    const warnCalls = warnSpy.mock.calls.map((c) => c.join(" "));
    expect(warnCalls.some((m) => m.includes("v2 path requested"))).toBe(false);
  });

  it("logs v2 path when FOUNDEROS_DISPATCHER_V2=1 (and warns about fallback pre-S7.A.5)", async () => {
    vi.stubEnv("FOUNDEROS_DISPATCHER_V2", "1");

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { api, completedWith } = stubApi({
      getNext: [{ kind: "job", job: makeJobDescriptor() }],
      claim: [{ kind: "claimed", payload: makeJobPayload() }],
      appendEvents: [{ kind: "ok" }],
      complete: [{ kind: "ok" }],
    });

    // We DO pass an explicit spawnFn here — that suppresses the
    // "falling back to v1" warn (test seam means the test owns the
    // dispatch). The v2 INFO log is still emitted.
    const spawnFn = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      elapsedSec: 0.1,
      timedOut: false,
      finalResult: null,
    }));

    await runRunnerLoop({
      config: baseConfig,
      logger: consoleLogger("error"),
      maxJobs: 1,
      apiClient: api,
      spawnFn: spawnFn as never,
    });

    const infoCalls = infoSpy.mock.calls.map((c) => c.join(" "));
    expect(infoCalls).toContain("[dispatcher] v2 (multi-adapter)");
    expect(infoCalls).not.toContain("[dispatcher] v1 (legacy runClaude)");

    // The fallback warn fires only when no explicit spawnFn was provided.
    // Here we passed one, so the warn must NOT fire — the test verifies
    // the warn is gated to the production path, not unconditionally noisy.
    const warnCalls = warnSpy.mock.calls.map((c) => c.join(" "));
    expect(warnCalls.some((m) => m.includes("v2 path requested but not yet implemented"))).toBe(
      false,
    );

    // Sanity: the loop actually ran the job through the supplied spawner.
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(completedWith).toHaveLength(1);
  });

  it("emits the pre-S7.A.5 fallback warn when v2 is requested without an override spawnFn", async () => {
    vi.stubEnv("FOUNDEROS_DISPATCHER_V2", "true");

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Same termination shape as the v1 test — 401 bails the loop after the
    // startup info/warn fires.
    const { api } = stubApi({
      getNext: [{ throw: new ApiError(401, '{"error":"test_terminate"}') }],
      claim: [],
      appendEvents: [],
      complete: [],
    });
    const priorExit = process.exitCode;
    process.exitCode = 0;

    await runRunnerLoop({
      config: baseConfig,
      logger: consoleLogger("error"),
      maxJobs: 1,
      apiClient: api,
      // Intentionally omit spawnFn so the production fallback path runs.
    });
    process.exitCode = priorExit;

    const infoCalls = infoSpy.mock.calls.map((c) => c.join(" "));
    expect(infoCalls).toContain("[dispatcher] v2 (multi-adapter)");

    const warnCalls = warnSpy.mock.calls.map((c) => c.join(" "));
    expect(
      warnCalls.some((m) => m.includes("v2 path requested but not yet implemented")),
    ).toBe(true);
  });
});
