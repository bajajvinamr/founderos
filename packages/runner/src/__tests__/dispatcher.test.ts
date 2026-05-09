/**
 * Dispatcher behavior tests — S7.1.b.3.
 *
 * Mocks the registry via `vi.mock("../adapters/index.js", ...)` so we can
 * pin handler routing without spawning any real subprocesses or hitting
 * any network. The mock pretends to register two adapter types
 * (`claude_local`, `openai_api`); a third (`gemini_local`) is intentionally
 * absent so the unknown-type branch can be tested.
 *
 * Coverage:
 *   (a) routes by adapterType to the correct handler
 *   (b) captures RunResult from the AsyncGenerator's return value (the
 *       invariant the dispatcher must not drop)
 *   (c) propagates AbortSignal cancellation through to the handler
 *   (d) throws UnknownAdapterTypeError for unregistered adapterType
 *
 * Plus three guard tests:
 *   (e) the bare-`for await` loop pattern WOULD lose RunResult — verifies
 *       this by exercising the dispatcher's manual `iter.next()` capture.
 *   (f) `lookupHandler()` resolves to the registered adapter for known
 *       types and throws for unknown ones (exposed for pre-flight use).
 *   (g) handler errors propagate unchanged (dispatcher does not interpret).
 */

import { describe, it, expect, vi } from "vitest";

import type { RunnerEvent } from "../api.js";
import type { AnyAdapter, RunContext, RunResult } from "../handlers/types.js";

// ---------------------------------------------------------------------------
// Mock the registry. Two adapters are registered (subprocess + api families
// represented); gemini_local is absent to exercise the unknown-type path.
// ---------------------------------------------------------------------------

const claudeRunCalls: Array<{ ctx: RunContext; signalAborted: boolean }> = [];
const openaiRunCalls: Array<{ ctx: RunContext; signalAborted: boolean }> = [];

const mockClaude: AnyAdapter = {
  type: "claude_local",
  transport: "subprocess",
  defaultBinary: "claude",
  async environmentChecks() {
    return { ok: true };
  },
  buildArgs() {
    return [];
  },
  async promptTransport() {},
  async *run(ctx: RunContext, signal: AbortSignal): AsyncGenerator<RunnerEvent, RunResult, void> {
    claudeRunCalls.push({ ctx, signalAborted: signal.aborted });
    yield {
      eventId: "evt-claude-1",
      kind: "model_message",
      ts: "2026-05-09T00:00:00.000Z",
      payload: { type: "assistant" },
    };
    yield {
      eventId: "evt-claude-2",
      kind: "run_complete",
      ts: "2026-05-09T00:00:00.001Z",
      payload: { type: "result" },
    };
    return {
      status: "completed",
      elapsedSec: 1.5,
      exitCode: 0,
      sessionId: "claude-sess-1",
      costUsd: 0.04,
    };
  },
  interpretFailure() {
    return { errorCode: "unknown", retryable: false, humanMessage: "n/a" };
  },
};

const mockOpenai: AnyAdapter = {
  type: "openai_api",
  transport: "api",
  defaultEndpoint: "https://api.openai.com/v1/responses",
  async environmentChecks() {
    return { ok: true };
  },
  async *run(ctx: RunContext, signal: AbortSignal): AsyncGenerator<RunnerEvent, RunResult, void> {
    openaiRunCalls.push({ ctx, signalAborted: signal.aborted });
    yield {
      eventId: "evt-openai-1",
      kind: "model_message",
      ts: "2026-05-09T00:00:00.000Z",
      payload: { role: "assistant" },
    };
    return {
      status: "completed",
      elapsedSec: 0.8,
      httpStatus: 200,
      costUsd: 0.01,
    };
  },
  interpretFailure() {
    return { errorCode: "unknown", retryable: false, humanMessage: "n/a" };
  },
};

vi.mock("../adapters/index.js", () => ({
  ADAPTER_HANDLERS: {
    claude_local: mockClaude,
    openai_api: mockOpenai,
  },
}));

// Import AFTER vi.mock so the module under test sees the mocked registry.
const { runAdapter, lookupHandler, UnknownAdapterTypeError } = await import("../dispatcher.js");

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    jobId: "job-1",
    prompt: "hello",
    workdir: "/tmp/wd",
    env: {},
    authMode: "subscription",
    timeoutSec: 60,
    adapterConfig: {},
    sessionId: null,
    ...overrides,
  };
}

async function drain(
  gen: AsyncGenerator<RunnerEvent, RunResult, void>,
): Promise<{ events: RunnerEvent[]; result: RunResult }> {
  const events: RunnerEvent[] = [];
  while (true) {
    const step = await gen.next();
    if (step.done) {
      return { events, result: step.value };
    }
    events.push(step.value);
  }
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("runAdapter — S7.1.b.3 dispatcher", () => {
  it("(a) routes by adapterType to the correct handler", async () => {
    claudeRunCalls.length = 0;
    openaiRunCalls.length = 0;
    const signal = new AbortController().signal;

    const claudeRun = await drain(runAdapter("claude_local", makeCtx({ jobId: "j-claude" }), signal));
    const openaiRun = await drain(runAdapter("openai_api", makeCtx({ jobId: "j-openai" }), signal));

    expect(claudeRunCalls).toHaveLength(1);
    expect(openaiRunCalls).toHaveLength(1);
    expect(claudeRunCalls[0].ctx.jobId).toBe("j-claude");
    expect(openaiRunCalls[0].ctx.jobId).toBe("j-openai");

    // Events should come from the matching handler.
    expect(claudeRun.events.map((e) => e.eventId)).toEqual(["evt-claude-1", "evt-claude-2"]);
    expect(openaiRun.events.map((e) => e.eventId)).toEqual(["evt-openai-1"]);
  });

  it("(b) captures RunResult from the AsyncGenerator's return value", async () => {
    const signal = new AbortController().signal;

    const { result: claudeResult } = await drain(runAdapter("claude_local", makeCtx(), signal));
    expect(claudeResult).toEqual({
      status: "completed",
      elapsedSec: 1.5,
      exitCode: 0,
      sessionId: "claude-sess-1",
      costUsd: 0.04,
    });

    const { result: openaiResult } = await drain(runAdapter("openai_api", makeCtx(), signal));
    expect(openaiResult).toEqual({
      status: "completed",
      elapsedSec: 0.8,
      httpStatus: 200,
      costUsd: 0.01,
    });
  });

  it("(c) propagates AbortSignal cancellation to the handler", async () => {
    claudeRunCalls.length = 0;
    const ctrl = new AbortController();
    ctrl.abort();
    const gen = runAdapter("claude_local", makeCtx(), ctrl.signal);
    await drain(gen);

    expect(claudeRunCalls).toHaveLength(1);
    // Handler must receive the SAME signal instance — verify by checking
    // that the handler observed the aborted state.
    expect(claudeRunCalls[0].signalAborted).toBe(true);
  });

  it("(d) throws UnknownAdapterTypeError for unregistered adapterType", async () => {
    const signal = new AbortController().signal;

    // The error fires when the generator is driven (lazy semantics for
    // async generators). Once the first `.next()` throws, the generator
    // transitions to a closed state — subsequent `.next()` calls return
    // `{done:true, value:undefined}` rather than re-throwing. So use a
    // fresh generator for each shape assertion.
    const gen1 = runAdapter("gemini_local", makeCtx(), signal);
    await expect(gen1.next()).rejects.toBeInstanceOf(UnknownAdapterTypeError);

    const gen2 = runAdapter("gemini_local", makeCtx(), signal);
    await expect(gen2.next()).rejects.toMatchObject({
      adapterType: "gemini_local",
      message: expect.stringContaining("gemini_local"),
    });
  });

  it("(e) bare `for await` would drop RunResult — manual `next()` is required", async () => {
    // This test is the inverted proof of the invariant: if you iterate
    // with `for await` you DON'T get RunResult — the variable bound by
    // the loop is the per-event yield, never the terminal return.
    const signal = new AbortController().signal;
    const gen = runAdapter("claude_local", makeCtx(), signal);

    let lastLoopValue: RunnerEvent | undefined;
    let loopCount = 0;
    for await (const evt of gen) {
      lastLoopValue = evt;
      loopCount++;
    }
    // The loop saw both events, but lastLoopValue is the LAST event yielded,
    // NOT the RunResult. The dispatcher's `runAdapter` works only because
    // it manually drives `next()` and reads `step.value` on `done`.
    expect(loopCount).toBe(2);
    expect(lastLoopValue?.kind).toBe("run_complete");
    // No way to reach RunResult.status from the loop binding.
    expect((lastLoopValue as unknown as { status?: string }).status).toBeUndefined();
  });

  it("(f) lookupHandler resolves known and throws on unknown", () => {
    expect(lookupHandler("claude_local")).toBe(mockClaude);
    expect(lookupHandler("openai_api")).toBe(mockOpenai);
    expect(() => lookupHandler("gemini_local")).toThrow(UnknownAdapterTypeError);
  });

  it("(g) handler errors propagate unchanged (no interpret in dispatcher)", async () => {
    const boom: AnyAdapter = {
      type: "claude_local",
      transport: "subprocess",
      defaultBinary: "x",
      async environmentChecks() {
        return { ok: true };
      },
      buildArgs() {
        return [];
      },
      async promptTransport() {},
      // eslint-disable-next-line require-yield
      async *run(): AsyncGenerator<RunnerEvent, RunResult, void> {
        throw new Error("handler boom");
      },
      interpretFailure() {
        return { errorCode: "unknown", retryable: false, humanMessage: "n/a" };
      },
    };

    // Re-mock for this test only by stubbing the registry shape.
    vi.doMock("../adapters/index.js", () => ({
      ADAPTER_HANDLERS: { claude_local: boom },
    }));
    // Re-import a fresh copy of the module under test against the new mock.
    vi.resetModules();
    const reloaded = await import("../dispatcher.js");
    const signal = new AbortController().signal;
    const gen = reloaded.runAdapter("claude_local", makeCtx(), signal);
    await expect(gen.next()).rejects.toThrow(/handler boom/);

    // Restore the original mock for any later tests in the file (defensive
    // — vitest runs describe blocks in order, and the assertions above
    // are the last in this file).
    vi.doUnmock("../adapters/index.js");
  });
});
