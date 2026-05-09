/**
 * Lifecycle tests for `claudeLocalAdapter.run()` — the AsyncGenerator that
 * S7.1.c.1 ports out of `spawn.ts:runClaude`. Mocks `node:child_process`
 * with a synthetic `EventEmitter`-based child so the generator runs without
 * an actual claude binary.
 *
 * Coverage:
 *   (a) happy path: stdout JSON lines → yield events; exit 0 → status="completed"
 *   (b) failure path: non-zero exit → status="failed" with errorMessage from interpretFailure
 *   (c) cancellation: signal abort → SIGTERM → SIGKILL → status="cancelled"
 *   (d) stream parsing: two JSON objects in one chunk → yields exactly two RunnerEvents in order
 *   (e) cost + sessionId snapshot: latest run_complete payload lands on RunResult
 *   (f) timeout: soft timer fires → SIGTERM → status="failed" with errorMessage="runner timed out"
 *
 * Mock pattern mirrors `dispatcher.test.ts` — `vi.mock` wraps the import so
 * the adapter's `nodeSpawn` resolves to our fake.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

import type { RunContext, RunResult } from "../handlers/types.js";
import type { RunnerEvent } from "../api.js";

// ---------------------------------------------------------------------------
// Fake child-process scaffolding. Each spawn call returns an EventEmitter
// with `.stdout`, `.stderr`, `.stdin` (also EventEmitters — they only need
// `.setEncoding()` + `.on('data')`/`.write()`/`.end()` from the adapter's
// perspective). Tests drive the lifecycle by `.emit('data', chunk)`-ing on
// stdout/stderr and `.emit('exit', code, signal)`-ing on the child. Direct
// emit avoids PassThrough's async backpressure timing — every event lands
// on the next microtask, which keeps tests deterministic without sleeps.
// ---------------------------------------------------------------------------

interface FakeStream extends EventEmitter {
  setEncoding: (enc: string) => FakeStream;
  write: (chunk: string, cb?: (err?: Error) => void) => boolean;
  end: (cb?: () => void) => void;
}

interface FakeChild extends EventEmitter {
  stdout: FakeStream;
  stderr: FakeStream;
  stdin: FakeStream;
  killed: boolean;
  kill: (sig?: NodeJS.Signals) => boolean;
  receivedSignals: NodeJS.Signals[];
  spawnArgs: { cmd: string; argv: readonly string[]; opts: unknown };
}

const childRefs: FakeChild[] = [];

function makeFakeStream(): FakeStream {
  const s = new EventEmitter() as FakeStream;
  s.setEncoding = () => s;
  s.write = (_chunk: string, cb?: (err?: Error) => void) => {
    if (cb) cb();
    return true;
  };
  s.end = (cb?: () => void) => {
    if (cb) cb();
  };
  return s;
}

function makeFakeChild(cmd: string, argv: readonly string[], opts: unknown): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.stdout = makeFakeStream();
  ee.stderr = makeFakeStream();
  ee.stdin = makeFakeStream();
  ee.killed = false;
  ee.receivedSignals = [];
  ee.spawnArgs = { cmd, argv, opts };
  ee.kill = (sig?: NodeJS.Signals): boolean => {
    const s = sig ?? "SIGTERM";
    ee.receivedSignals.push(s);
    if (s === "SIGKILL" || s === "SIGTERM") {
      ee.killed = true;
    }
    return true;
  };
  return ee;
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (cmd: string, argv: readonly string[], opts: unknown) => {
      const c = makeFakeChild(cmd, argv, opts);
      childRefs.push(c);
      return c;
    },
  };
});

// Import AFTER vi.mock so the adapter binds to the fake `spawn`.
const { claudeLocalAdapter } = await import("../adapters/claude.js");

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    jobId: "job-1",
    prompt: "hi",
    workdir: "/tmp/wd",
    env: {},
    authMode: "subscription",
    timeoutSec: 60,
    adapterConfig: {},
    sessionId: null,
    ...overrides,
  };
}

/**
 * Drive an AsyncGenerator manually: collect events while non-done, return
 * the terminal RunResult. Mirrors the dispatcher's `runAdapter` loop.
 */
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

/** Wait for the next macrotask so the spawn handler can attach listeners. */
function nextTick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  childRefs.length = 0;
});

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("claudeLocalAdapter.run() — S7.1.c.1 lifecycle", () => {
  it("(a) happy path: stdout events stream, exit 0 → status=completed", async () => {
    const gen = claudeLocalAdapter.run(
      makeCtx({ prompt: "hello world" }),
      new AbortController().signal,
    );

    const drained = drain(gen);
    await nextTick();
    expect(childRefs).toHaveLength(1);
    const child = childRefs[0];
    expect(child.spawnArgs.cmd).toBe("claude");

    // Two JSON lines: an assistant message, then the run_complete result.
    child.stdout.emit("data",
      `${JSON.stringify({ type: "assistant", message: { content: "hi" } })}\n`,
    );
    child.stdout.emit("data",
      `${JSON.stringify({
        type: "result",
        session_id: "sess_after",
        total_cost_usd: 0.0125,
      })}\n`,
    );
    await nextTick();
    child.emit("exit", 0, null);

    const { events, result } = await drained;
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("sess_after");
    expect(result.costUsd).toBeCloseTo(0.0125);
    expect(events.map((e) => e.kind)).toEqual(["model_message", "run_complete"]);
  });

  it("(b) non-zero exit → status=failed with interpretFailure-derived errorMessage", async () => {
    const gen = claudeLocalAdapter.run(
      makeCtx(),
      new AbortController().signal,
    );

    const drained = drain(gen);
    await nextTick();
    const child = childRefs[0];
    child.emit("exit", 1, null);

    const { result } = await drained;
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("claude exited 1");
  });

  it("(c) cancellation via AbortSignal → SIGTERM → status=cancelled", async () => {
    const ctrl = new AbortController();
    const gen = claudeLocalAdapter.run(makeCtx(), ctrl.signal);
    const drained = drain(gen);
    await nextTick();
    const child = childRefs[0];

    // User cancel mid-run. Adapter must SIGTERM synchronously.
    ctrl.abort();
    expect(child.receivedSignals).toContain("SIGTERM");

    // Simulate the OS reaping the child after SIGTERM lands.
    child.emit("exit", null, "SIGTERM");

    const { result } = await drained;
    expect(result.status).toBe("cancelled");
    expect(result.signal).toBe("SIGTERM");
  });

  it("(c2) abort that ignores SIGTERM → SIGKILL grace timer → status=cancelled", async () => {
    // Same shape as (c), but the test asserts the SIGKILL escalation timer
    // fires when SIGTERM doesn't actually reap the child within 200ms.
    // Override the mock's `kill()` to NOT flip `killed`-on-SIGTERM, mirroring
    // real-world behavior of a child that ignores the term signal — only
    // then does the adapter's `if (!child.killed) child.kill("SIGKILL")`
    // path actually run.
    const ctrl = new AbortController();
    const gen = claudeLocalAdapter.run(makeCtx(), ctrl.signal);
    const drained = drain(gen);
    await nextTick();
    const child = childRefs[0];
    // Make SIGTERM a no-op — child stays alive until SIGKILL.
    const originalKill = child.kill;
    child.kill = (sig?: NodeJS.Signals): boolean => {
      const s = sig ?? "SIGTERM";
      child.receivedSignals.push(s);
      if (s === "SIGKILL") child.killed = true;
      return true;
    };

    ctrl.abort();
    expect(child.receivedSignals).toContain("SIGTERM");
    // Wait past the 200ms SIGKILL grace.
    await new Promise((r) => setTimeout(r, 250));
    expect(child.receivedSignals).toContain("SIGKILL");

    child.kill = originalKill;
    child.emit("exit", null, "SIGKILL");
    const { result } = await drained;
    expect(result.status).toBe("cancelled");
  });

  it("(d) stream parsing: two JSON objects in one chunk → yields two events in order", async () => {
    const gen = claudeLocalAdapter.run(makeCtx(), new AbortController().signal);
    const drained = drain(gen);
    await nextTick();
    const child = childRefs[0];

    // Single chunk containing two newline-terminated JSON objects.
    const chunk = `${JSON.stringify({ type: "assistant", content: "hi" })}\n${JSON.stringify({ type: "result", session_id: "s", total_cost_usd: 0 })}\n`;
    child.stdout.emit("data", chunk);
    await nextTick();
    child.emit("exit", 0, null);

    const { events } = await drained;
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("model_message");
    expect(events[1].kind).toBe("run_complete");
  });

  it("(e) latest run_complete wins for cost + sessionId snapshot", async () => {
    const gen = claudeLocalAdapter.run(makeCtx(), new AbortController().signal);
    const drained = drain(gen);
    await nextTick();
    const child = childRefs[0];

    // Two run_complete events — the latter must win.
    child.stdout.emit("data",
      `${JSON.stringify({ type: "result", session_id: "sess_first", total_cost_usd: 0.001 })}\n`,
    );
    child.stdout.emit("data",
      `${JSON.stringify({ type: "result", session_id: "sess_second", total_cost_usd: 0.042 })}\n`,
    );
    await nextTick();
    child.emit("exit", 0, null);

    const { result } = await drained;
    expect(result.sessionId).toBe("sess_second");
    expect(result.costUsd).toBeCloseTo(0.042);
  });

  it("(f) timeout: soft timer fires → SIGTERM → status=failed with 'runner timed out'", async () => {
    // timeoutSec is in seconds; adapter multiplies by 1000 for setTimeout.
    // Pass a small fractional value (0.05s = 50ms) so the soft timeout
    // fires well within the test's 5s budget without fake timers.
    const gen = claudeLocalAdapter.run(
      makeCtx({ timeoutSec: 0.05 }),
      new AbortController().signal,
    );
    const drained = drain(gen);
    await nextTick();
    const child = childRefs[0];

    // Wait past the 50ms soft timeout — the adapter MUST issue SIGTERM
    // automatically (parity with `spawn.ts:113-116`).
    await new Promise((r) => setTimeout(r, 100));
    expect(child.receivedSignals).toContain("SIGTERM");

    // Simulate the kernel reaping the child once SIGTERM lands.
    child.emit("exit", null, "SIGTERM");

    const { result } = await drained;
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("runner timed out");
  });

  it("forwards binary override + cwd + env to spawn", async () => {
    const env = { CLAUDE_DEBUG: "1" };
    const gen = claudeLocalAdapter.run(
      makeCtx({
        workdir: "/work",
        env,
        adapterConfig: { binary: "/usr/local/bin/claude-custom", model: "claude-opus-4-7" },
      }),
      new AbortController().signal,
    );
    const drained = drain(gen);
    await nextTick();
    const child = childRefs[0];
    expect(child.spawnArgs.cmd).toBe("/usr/local/bin/claude-custom");
    const spawnOpts = child.spawnArgs.opts as { cwd?: string; env?: Record<string, string> };
    expect(spawnOpts.cwd).toBe("/work");
    expect(spawnOpts.env).toBe(env);
    expect(child.spawnArgs.argv).toContain("--model");
    expect(child.spawnArgs.argv).toContain("claude-opus-4-7");

    child.emit("exit", 0, null);
    await drained;
  });
});
