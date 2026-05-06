/**
 * Tests for `runCronTick` (PR-5, council 2026-05-07 P1-5).
 *
 * The helper is the wrapper that 7 business-logic cron schedulers should
 * use to (a) attach a requestId/traceId/actor to every log + Sentry event
 * emitted inside the tick body, and (b) catch + capture any uncaught
 * throw so the failure is observable instead of being swallowed by the
 * setInterval rejection.
 *
 * What we're asserting:
 *
 *   1. Inside the callback, `getRequestContext()` returns a context
 *      whose `requestId` starts with `cron:<taskName>:` and whose
 *      `actor.type === "system"`. (Without this, pino logs from
 *      cron tick bodies emit empty mixin fields.)
 *
 *   2. When the callback throws, the helper:
 *      - returns `undefined` (no rethrow → no UnhandledPromiseRejection)
 *      - calls `captureServerError(err, { taskName, durationMs })`
 *
 *   3. When the callback succeeds, the helper returns the awaited value.
 *
 *   4. The callback receives the time it ran inside the duration log
 *      (we can't assert pino output cheaply here, but we CAN assert
 *      that the captureServerError extras include a `durationMs` >= 0
 *      on the failure path).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `captureServerError` is the Sentry passthrough we want to spy on. We
// mock it BEFORE importing `runCronTick` so the helper picks up the
// stubbed module.
vi.mock("../observability/sentry.js", () => ({
  captureServerError: vi.fn(),
  // `initServerSentry` is unused in this test path but other code under
  // test may transitively import the module — keep the surface stable.
  initServerSentry: vi.fn(async () => false),
}));

import { runCronTick } from "../lib/cron-tick.js";
import { getRequestContext } from "../lib/request-context.js";
import { captureServerError } from "../observability/sentry.js";

describe("runCronTick — request context propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets up a cron-flavored request context for the callback body", async () => {
    let capturedContext: ReturnType<typeof getRequestContext> = undefined;
    await runCronTick("daily-digest", () => {
      capturedContext = getRequestContext();
    });

    expect(capturedContext).toBeDefined();
    expect(capturedContext?.requestId).toMatch(/^cron:daily-digest:[\w-]+$/);
    // requestId === traceId for cron-originated work (no upstream W3C trace).
    expect(capturedContext?.traceId).toBe(capturedContext?.requestId);
    expect(capturedContext?.actor?.type).toBe("system");
    expect(capturedContext?.actor?.source).toBe("cron:daily-digest");
    expect(capturedContext?.routePath).toBe("cron/daily-digest");
  });

  it("each tick gets its own request id (deterministic uniqueness per invocation)", async () => {
    const ids: string[] = [];
    await runCronTick("slack-sync", () => {
      ids.push(getRequestContext()?.requestId ?? "");
    });
    await runCronTick("slack-sync", () => {
      ids.push(getRequestContext()?.requestId ?? "");
    });

    expect(ids[0]).not.toBe(ids[1]); // different UUIDs
    expect(ids[0]).toMatch(/^cron:slack-sync:/);
    expect(ids[1]).toMatch(/^cron:slack-sync:/);
  });
});

describe("runCronTick — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the awaited callback value when it succeeds", async () => {
    const result = await runCronTick("hubspot-sync", async () => {
      return { eligible: 3, sent: 3, skipped: 0 };
    });
    expect(result).toEqual({ eligible: 3, sent: 3, skipped: 0 });
  });

  it("does not call captureServerError on success", async () => {
    await runCronTick("notion-sync", async () => "ok");
    expect(captureServerError).not.toHaveBeenCalled();
  });

  it("supports a synchronous callback (returns the raw value, not a promise)", async () => {
    // Some cron tick bodies are async, but `runCronTick` should also
    // accept a sync `() => T` and resolve to T. This keeps the helper
    // ergonomic for trivial 1-line ticks.
    const result = await runCronTick("decision-followup", () => "sync-result");
    expect(result).toBe("sync-result");
  });
});

describe("runCronTick — error path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns undefined when the callback throws — does not propagate the throw", async () => {
    // The setInterval call site at the cron's start() function is
    // `void runCronTick(...)` — the helper MUST swallow throws or
    // we get unhandled promise rejections that crash the process
    // under Node 24's default unhandledRejection behavior.
    const result = await runCronTick("linkedin-sync", async () => {
      throw new Error("downstream API rate-limited");
    });
    expect(result).toBeUndefined();
  });

  it("calls captureServerError with { taskName, durationMs } on throw", async () => {
    await runCronTick("weekly-wrap-delivery", async () => {
      throw new Error("EHOSTUNREACH");
    });

    expect(captureServerError).toHaveBeenCalledTimes(1);
    const [errArg, contextArg] = (captureServerError as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(errArg).toBeInstanceOf(Error);
    expect((errArg as Error).message).toBe("EHOSTUNREACH");
    expect(contextArg).toMatchObject({
      taskName: "weekly-wrap-delivery",
    });
    expect(typeof (contextArg as { durationMs: number }).durationMs).toBe("number");
    expect((contextArg as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
  });

  it("captures non-Error throws (e.g. string, plain object) without crashing", async () => {
    await runCronTick("daily-digest", async () => {
      throw "plain string error"; // eslint-disable-line @typescript-eslint/only-throw-error
    });

    expect(captureServerError).toHaveBeenCalledTimes(1);
    const [errArg] = (captureServerError as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    // The helper hands the raw throw to Sentry — Sentry's own normalizer
    // handles non-Error values. We're asserting the helper doesn't
    // wrap-and-rethrow or transform the value.
    expect(errArg).toBe("plain string error");
  });

  it("the request context is still active when captureServerError fires", async () => {
    // Important: Sentry's scope enricher reads getRequestContext() at
    // capture time — if the helper threw BEFORE re-raising the cron
    // context (or AFTER it had been popped), Sentry would lose the
    // requestId/traceId tag and the error would land in Sentry without
    // any cron correlation. We assert the context is live by checking
    // it from inside the captureServerError stub.
    let contextAtCapture: ReturnType<typeof getRequestContext> = undefined;
    (captureServerError as unknown as { mockImplementation: (fn: unknown) => void }).mockImplementation(() => {
      contextAtCapture = getRequestContext();
    });

    await runCronTick("hubspot-sync", async () => {
      throw new Error("force-capture");
    });

    expect(contextAtCapture).toBeDefined();
    expect(contextAtCapture?.requestId).toMatch(/^cron:hubspot-sync:/);
    expect(contextAtCapture?.actor?.type).toBe("system");
  });
});

describe("runCronTick — duration measurement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("measures elapsed time from helper entry to callback resolution", async () => {
    // Use a real-clock smoke test rather than fake timers — Date.now()
    // before/after a small async wait is enough to prove the field is
    // a real elapsed duration, not a constant.
    const SLEEP_MS = 30;
    await runCronTick("slow-task", async () => {
      throw new Error("slow fail");
    });

    expect(captureServerError).toHaveBeenCalledTimes(1);
    const [, contextArg] = (captureServerError as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const durationMs = (contextArg as { durationMs: number }).durationMs;
    expect(durationMs).toBeGreaterThanOrEqual(0);
    // Sanity ceiling: a no-op throw shouldn't take longer than a
    // generous 1s in a unit test.
    expect(durationMs).toBeLessThan(1000);

    // Now actually sleep before throwing and verify duration reflects it.
    vi.clearAllMocks();
    await runCronTick("slow-task-2", async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, SLEEP_MS));
      throw new Error("slow-fail-2");
    });
    const [, contextArg2] = (captureServerError as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect((contextArg2 as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(SLEEP_MS - 5);
  });
});
