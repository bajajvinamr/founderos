/**
 * Tests for AsyncLocalStorage propagation through `runWithRequestContext`
 * (`server/src/lib/request-context.ts`).
 *
 * Why this exists — pinned vinamr-invariant (project CLAUDE.md):
 *
 *   > `server/src/lib/request-context.ts` runs ALL request-scoped code
 *   > under `runWithRequestContext`. Any background task spawned from a
 *   > request handler (queue jobs, fire-and-forget promises, setTimeout
 *   > callbacks) inherits the ALS context automatically — but a background
 *   > task scheduled at boot (cron schedulers, plugin coordinator) runs
 *   > OUTSIDE any request context. If you `getRequestContext()` from a
 *   > cron tick, it returns `undefined`. Inject explicit
 *   > `actor: { type: 'system' }` for background-originated work or the
 *   > Sentry scope tags will be empty.
 *
 * This is a STRUCTURAL test, not a behavioral one — it pins Node.js's
 * AsyncLocalStorage propagation guarantees that the entire pino-mixin +
 * Sentry-scope enrichment chain depends on. The two failure modes it
 * defends against:
 *
 *   1. A future refactor swaps `AsyncLocalStorage` for a synchronous shim
 *      that doesn't propagate through scheduler boundaries → Sentry tags
 *      silently miss requestId on background work spawned from handlers.
 *   2. Someone calls `getRequestContext()` from code that was NOT entered
 *      via `runWithRequestContext` (e.g. a cron tick or boot-time
 *      coordinator) and expects a real context → gets `undefined`.
 *
 * Scheduler boundaries covered:
 *   - immediate (synchronous) read
 *   - setTimeout (macrotask)
 *   - queueMicrotask (microtask)
 *   - Promise.resolve().then(...) (microtask via Promise continuation)
 *   - outside any context (must be undefined)
 *   - two concurrent runWithRequestContext calls with interleaved
 *     setTimeouts must NOT contaminate each other (parallel-request safety)
 */

import { describe, expect, it } from "vitest";
import {
  getRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../request-context.js";

const baseCtx = (requestId: string): RequestContext => ({
  requestId,
  traceId: requestId,
  actor: { type: "user", userId: "u-test" },
  routePath: "/api/test",
  method: "GET",
  url: "/api/test",
});

describe("request-context ALS propagation", () => {
  it("immediate getRequestContext() inside the wrapper sees the context", () => {
    let observed: RequestContext | undefined;
    runWithRequestContext(baseCtx("r1"), () => {
      observed = getRequestContext();
    });

    expect(observed).toBeDefined();
    expect(observed?.requestId).toBe("r1");
    expect(observed?.traceId).toBe("r1");
  });

  it("propagates through setTimeout (macrotask boundary)", async () => {
    const observedId = await new Promise<string | undefined>((resolve) => {
      runWithRequestContext(baseCtx("r-setTimeout"), () => {
        setTimeout(() => {
          resolve(getRequestContext()?.requestId);
        }, 10);
      });
    });

    expect(observedId).toBe("r-setTimeout");
  });

  it("propagates through queueMicrotask (microtask boundary)", async () => {
    const observedId = await new Promise<string | undefined>((resolve) => {
      runWithRequestContext(baseCtx("r-microtask"), () => {
        queueMicrotask(() => {
          resolve(getRequestContext()?.requestId);
        });
      });
    });

    expect(observedId).toBe("r-microtask");
  });

  it("propagates through Promise.resolve().then(...) continuations", async () => {
    const observedId = await new Promise<string | undefined>((resolve) => {
      runWithRequestContext(baseCtx("r-promise"), () => {
        Promise.resolve().then(() => {
          resolve(getRequestContext()?.requestId);
        });
      });
    });

    expect(observedId).toBe("r-promise");
  });

  it("propagates through an awaited async chain inside the wrapper", async () => {
    // Belt-and-braces: a real handler awaits multiple async boundaries
    // (DB call, fetch, etc). ALS must hold across all of them.
    async function deepChain(): Promise<string | undefined> {
      await Promise.resolve();
      await new Promise<void>((r) => setTimeout(r, 5));
      await Promise.resolve();
      return getRequestContext()?.requestId;
    }

    const observedId = await new Promise<string | undefined>((resolve) => {
      runWithRequestContext(baseCtx("r-deep-chain"), () => {
        deepChain().then(resolve);
      });
    });

    expect(observedId).toBe("r-deep-chain");
  });

  it("getRequestContext() OUTSIDE any wrapper returns undefined", () => {
    // This is the explicit pin against the cron-tick / boot-coordinator
    // failure mode. If anything ever changes the API so that an "ambient"
    // context leaks across the boundary, this test catches it.
    expect(getRequestContext()).toBeUndefined();
  });

  it("getRequestContext() AFTER the wrapper returns undefined (no bleed)", () => {
    runWithRequestContext(baseCtx("r-scope"), () => {
      expect(getRequestContext()?.requestId).toBe("r-scope");
    });
    // Same tick, after the wrapper synchronously returned.
    expect(getRequestContext()).toBeUndefined();
  });

  it("getRequestContext() inside a setTimeout scheduled OUTSIDE the wrapper is undefined", async () => {
    // Boot-time scheduled tasks (cron, plugin coordinator) install their
    // timers before any request context exists. They MUST observe
    // `undefined` here — otherwise the invariant would have nothing to
    // defend.
    const observed = await new Promise<RequestContext | undefined>((resolve) => {
      setTimeout(() => {
        resolve(getRequestContext());
      }, 10);
    });

    expect(observed).toBeUndefined();
  });

  it("two concurrent runWithRequestContext calls with interleaved setTimeouts do NOT contaminate each other", async () => {
    // The load-bearing parallel-safety assertion. If ALS were ever swapped
    // for a module-level mutable variable (the classic broken shim), the
    // two timers would race and one would observe the other's requestId.
    // AsyncLocalStorage's contract is that each `run()` invocation gets
    // its own logical store, propagated through async hooks.
    const results: Array<{ expected: string; observed: string | undefined }> = [];

    await new Promise<void>((resolve) => {
      let remaining = 2;
      const done = () => {
        remaining -= 1;
        if (remaining === 0) resolve();
      };

      runWithRequestContext(baseCtx("r1"), () => {
        // Schedule LATER so the r2 timer is registered first and would
        // win a race if the impl were mutable-global.
        setTimeout(() => {
          results.push({
            expected: "r1",
            observed: getRequestContext()?.requestId,
          });
          done();
        }, 30);
      });

      runWithRequestContext(baseCtx("r2"), () => {
        setTimeout(() => {
          results.push({
            expected: "r2",
            observed: getRequestContext()?.requestId,
          });
          done();
        }, 10);
      });
    });

    // Order-independent: each timer must see ONLY its own requestId.
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.observed).toBe(r.expected);
    }
    // And neither leaked the other's id.
    const ids = results.map((r) => r.observed);
    expect(ids).toContain("r1");
    expect(ids).toContain("r2");
  });

  it("nested runWithRequestContext shadows the outer context and restores it on return", () => {
    // Express middleware → background job inheritance pattern: the
    // background job sometimes opens its OWN context (e.g. for an
    // explicit `actor: { type: 'system' }` override per the invariant
    // doc). The inner context must shadow the outer for the duration
    // and the outer must come back when the inner returns.
    const observations: Array<string | undefined> = [];

    runWithRequestContext(baseCtx("outer"), () => {
      observations.push(getRequestContext()?.requestId);
      runWithRequestContext(baseCtx("inner"), () => {
        observations.push(getRequestContext()?.requestId);
      });
      observations.push(getRequestContext()?.requestId);
    });

    expect(observations).toEqual(["outer", "inner", "outer"]);
  });
});
