/**
 * Lifecycle + invariant tests for `codexLocalAdapter` — S7.B.codex's
 * second Phase-4 SubprocessAdapter sibling to `claude_local` and
 * `gemini_local`. Mirrors the structural template at
 * `gemini-adapter-run.test.ts` (mocked `node:child_process`,
 * EventEmitter-based fake child, real short timeouts not fake-timers per
 * the cross-test-pollution issue documented in S7.1.c.1).
 *
 * Coverage:
 *   (a) Happy path: JSONL output → yield events → status="completed"
 *   (b) Failure path: exit 1 → status="failed", errorCode="unknown"
 *   (c) Cancellation: AbortSignal → SIGTERM → status="cancelled"
 *   (d) Stream parsing: 2 JSON objects in one chunk → 2 events in order
 *   (e) Invariant: exit 2 → errorCode="codex_arg_parse_failure" (Invariant 1
 *       from ~/.claude/rules/vinamr-invariants.md)
 *   (f) Invariant: buildArgs DOES NOT include --approval-policy by default
 *   (g) Invariant: buildArgs DOES NOT include --sandbox by default
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

import type { RunContext, RunResult } from "../handlers/types.js";
import type { RunnerEvent } from "../api.js";

// ---------------------------------------------------------------------------
// Fake child-process scaffolding — same as gemini-adapter-run.test.ts.
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
const { codexLocalAdapter } = await import("../adapters/codex.js");

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

function nextTick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  childRefs.length = 0;
});

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("codexLocalAdapter.run() — S7.B.codex lifecycle", () => {
  it("(a) happy path: JSONL events → status=completed", async () => {
    const gen = codexLocalAdapter.run(
      makeCtx({ prompt: "hello" }),
      new AbortController().signal,
    );

    const drained = drain(gen);
    await nextTick();
    expect(childRefs).toHaveLength(1);
    const child = childRefs[0];
    expect(child.spawnArgs.cmd).toBe("codex");

    child.stdout.emit(
      "data",
      `${JSON.stringify({ type: "thread.started", thread_id: "thr_codex_1" })}\n`,
    );
    child.stdout.emit(
      "data",
      `${JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "hi" },
      })}\n`,
    );
    child.stdout.emit(
      "data",
      `${JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      })}\n`,
    );
    await nextTick();
    child.emit("exit", 0, null);

    const { events, result } = await drained;
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("thr_codex_1");
    // Codex does not emit a per-run cost; legacy adapter sets null.
    expect(result.costUsd).toBeNull();
    expect(events.map((e) => e.kind)).toEqual([
      "model_message",
      "model_message",
      "run_complete",
    ]);
  });

  it("(b) non-zero exit (1) → status=failed with errorCode unknown", async () => {
    const gen = codexLocalAdapter.run(makeCtx(), new AbortController().signal);
    const drained = drain(gen);
    await nextTick();
    const child = childRefs[0];
    child.emit("exit", 1, null);

    const { result } = await drained;
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("codex exited 1");

    // interpretFailure mirror — surfaces the same code via the public API.
    const interp = codexLocalAdapter.interpretFailure({ exitCode: 1, signal: null });
    expect(interp.errorCode).toBe("unknown");
    expect(interp.retryable).toBe(false);
  });

  it("(c) cancellation via AbortSignal → SIGTERM → status=cancelled", async () => {
    const ctrl = new AbortController();
    const gen = codexLocalAdapter.run(makeCtx(), ctrl.signal);
    const drained = drain(gen);
    await nextTick();
    const child = childRefs[0];

    ctrl.abort();
    expect(child.receivedSignals).toContain("SIGTERM");

    child.emit("exit", null, "SIGTERM");

    const { result } = await drained;
    expect(result.status).toBe("cancelled");
    expect(result.signal).toBe("SIGTERM");
  });

  it("(d) stream parsing: 2 JSON objects in one chunk → 2 events in order", async () => {
    const gen = codexLocalAdapter.run(makeCtx(), new AbortController().signal);
    const drained = drain(gen);
    await nextTick();
    const child = childRefs[0];

    const chunk = `${JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "hi" },
    })}\n${JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1, output_tokens: 1 },
    })}\n`;
    child.stdout.emit("data", chunk);
    await nextTick();
    child.emit("exit", 0, null);

    const { events } = await drained;
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("model_message");
    expect(events[1].kind).toBe("run_complete");
  });

  it("(e) Invariant: exit 2 → errorCode=codex_arg_parse_failure", async () => {
    const gen = codexLocalAdapter.run(makeCtx(), new AbortController().signal);
    const drained = drain(gen);
    await nextTick();
    const child = childRefs[0];
    child.stderr.emit("data", "error: unexpected argument '-a' found\n");
    await nextTick();
    child.emit("exit", 2, null);

    const { result } = await drained;
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(2);
    expect(result.errorMessage).toContain("arg-parse failure");
    expect(result.errorMessage).toContain("approval-policy");
    expect(result.errorMessage).toContain("sandbox");

    // Public API: interpretFailure is the canonical surface.
    const interp = codexLocalAdapter.interpretFailure({ exitCode: 2, signal: null });
    expect(interp.errorCode).toBe("codex_arg_parse_failure");
    expect(interp.retryable).toBe(false);
    expect(interp.humanMessage).toContain("vinamr-invariants");
  });

  it("(f) Invariant: buildArgs DOES NOT include --approval-policy by default", () => {
    const argv = codexLocalAdapter.buildArgs({
      prompt: "x",
      sessionId: null,
      authMode: "subscription",
      workdir: "/tmp",
      adapterConfig: {},
      instructionsFilePath: null,
    });
    // Default argv must omit --approval-policy entirely (Invariant 1).
    expect(argv).not.toContain("--approval-policy");
    expect(argv).not.toContain("-a");
    // Sanity: the canonical argv shape is still present.
    expect(argv).toContain("exec");
    expect(argv).toContain("--json");
    // Trailing `-` enables stdin reads.
    expect(argv[argv.length - 1]).toBe("-");

    // Operator opt-in: explicit string lands in argv.
    const argv2 = codexLocalAdapter.buildArgs({
      prompt: "x",
      sessionId: null,
      authMode: "subscription",
      workdir: "/tmp",
      adapterConfig: { approvalPolicy: "untrusted" },
      instructionsFilePath: null,
    });
    expect(argv2).toContain("--approval-policy");
    expect(argv2).toContain("untrusted");
  });

  it("(g) Invariant: buildArgs DOES NOT include --sandbox by default", () => {
    const argv = codexLocalAdapter.buildArgs({
      prompt: "x",
      sessionId: null,
      authMode: "subscription",
      workdir: "/tmp",
      adapterConfig: {},
      instructionsFilePath: null,
    });
    // Default argv must omit --sandbox entirely (Invariant 1).
    expect(argv).not.toContain("--sandbox");

    // Operator opt-in: explicit string lands in argv.
    const argv2 = codexLocalAdapter.buildArgs({
      prompt: "x",
      sessionId: null,
      authMode: "subscription",
      workdir: "/tmp",
      adapterConfig: { sandbox: "read-only" },
      instructionsFilePath: null,
    });
    expect(argv2).toContain("--sandbox");
    expect(argv2).toContain("read-only");
  });
});
