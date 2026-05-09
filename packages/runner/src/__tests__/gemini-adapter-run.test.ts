/**
 * Lifecycle + invariant tests for `geminiLocalAdapter` — S7.B.gemini's first
 * Phase-4 SubprocessAdapter sibling to `claude_local`. Mirrors the structural
 * template at `claude-adapter-run.test.ts` (mocked `node:child_process`,
 * EventEmitter-based fake child, real short timeouts not fake-timers per
 * the cross-test-pollution issue documented in S7.1.c.1).
 *
 * Coverage:
 *   (a) Happy path: stream-json output → yield events → status="completed"
 *   (b) Failure path: exit 1 → status="failed", errorCode="unknown"
 *   (c) Cancellation: AbortSignal → SIGTERM → status="cancelled"
 *   (d) Stream parsing: 2 JSON objects in one chunk → 2 events in order
 *   (e) Invariant 1: GEMINI_CLI_TRUST_WORKSPACE missing → environmentChecks ok
 *       (positive evidence: argv carries `--skip-trust` by default; check
 *       intentionally returns ok because that's the safe default)
 *   (f) Invariant 1 (sharp end): exit 55 → errorCode="gemini_workspace_not_trusted"
 *   (g) Invariant 2: 429 + preview-model body → errorCode="gemini_capacity_exhausted_preview"
 *       with retryable=true
 *   (h) Default model: buildArgs includes `--model gemini-2.5-pro` when unset
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

import type { RunContext, RunResult } from "../handlers/types.js";
import type { RunnerEvent } from "../api.js";

// ---------------------------------------------------------------------------
// Fake child-process scaffolding — same as claude-adapter-run.test.ts.
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
const { geminiLocalAdapter } = await import("../adapters/gemini.js");

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

describe("geminiLocalAdapter.run() — S7.B.gemini lifecycle", () => {
  it("(a) happy path: stream-json events → status=completed", async () => {
    const gen = geminiLocalAdapter.run(
      makeCtx({ prompt: "hello" }),
      new AbortController().signal,
    );

    const drained = drain(gen);
    await nextTick();
    expect(childRefs).toHaveLength(1);
    const child = childRefs[0];
    expect(child.spawnArgs.cmd).toBe("gemini");

    child.stdout.emit(
      "data",
      `${JSON.stringify({ type: "assistant", message: { content: "hi" } })}\n`,
    );
    child.stdout.emit(
      "data",
      `${JSON.stringify({
        type: "result",
        session_id: "gem_after",
        total_cost_usd: 0.0042,
      })}\n`,
    );
    await nextTick();
    child.emit("exit", 0, null);

    const { events, result } = await drained;
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("gem_after");
    expect(result.costUsd).toBeCloseTo(0.0042);
    expect(events.map((e) => e.kind)).toEqual(["model_message", "run_complete"]);
  });

  it("(b) non-zero exit (1) → status=failed with errorCode unknown", async () => {
    const gen = geminiLocalAdapter.run(makeCtx(), new AbortController().signal);
    const drained = drain(gen);
    await nextTick();
    const child = childRefs[0];
    child.emit("exit", 1, null);

    const { result } = await drained;
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("gemini exited 1");

    // interpretFailure mirror — surfaces the same code via the public API.
    const interp = geminiLocalAdapter.interpretFailure({ exitCode: 1, signal: null });
    expect(interp.errorCode).toBe("unknown");
    expect(interp.retryable).toBe(false);
  });

  it("(c) cancellation via AbortSignal → SIGTERM → status=cancelled", async () => {
    const ctrl = new AbortController();
    const gen = geminiLocalAdapter.run(makeCtx(), ctrl.signal);
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
    const gen = geminiLocalAdapter.run(makeCtx(), new AbortController().signal);
    const drained = drain(gen);
    await nextTick();
    const child = childRefs[0];

    const chunk = `${JSON.stringify({ type: "assistant", content: "hi" })}\n${JSON.stringify({
      type: "result",
      session_id: "g",
      total_cost_usd: 0,
    })}\n`;
    child.stdout.emit("data", chunk);
    await nextTick();
    child.emit("exit", 0, null);

    const { events } = await drained;
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("model_message");
    expect(events[1].kind).toBe("run_complete");
  });

  it("(e) Invariant 1: GEMINI_CLI_TRUST_WORKSPACE unset → environmentChecks remains ok (default --skip-trust)", async () => {
    // Default `adapterConfig.skipTrust` is true, so the adapter's argv
    // carries `--skip-trust`. environmentChecks therefore returns ok even
    // when the env var is absent — the safe default is in the argv.
    const result = await geminiLocalAdapter.environmentChecks({
      env: {} as NodeJS.ProcessEnv,
      adapterConfig: {},
    });
    expect(result.ok).toBe(true);

    // Positive evidence in argv: --skip-trust appears by default.
    const argv = geminiLocalAdapter.buildArgs({
      prompt: "x",
      sessionId: null,
      authMode: "subscription",
      workdir: "/tmp",
      adapterConfig: {},
      instructionsFilePath: null,
    });
    expect(argv).toContain("--skip-trust");

    // And when env is set, the adapter still returns ok.
    const result2 = await geminiLocalAdapter.environmentChecks({
      env: { GEMINI_CLI_TRUST_WORKSPACE: "true" } as NodeJS.ProcessEnv,
      adapterConfig: {},
    });
    expect(result2.ok).toBe(true);
  });

  it("(f) Invariant 1 (sharp end): exit 55 → errorCode=gemini_workspace_not_trusted", async () => {
    const gen = geminiLocalAdapter.run(makeCtx(), new AbortController().signal);
    const drained = drain(gen);
    await nextTick();
    const child = childRefs[0];
    child.emit("exit", 55, null);

    const { result } = await drained;
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(55);
    expect(result.errorMessage).toContain("workspace not trusted");
    expect(result.errorMessage).toContain("GEMINI_CLI_TRUST_WORKSPACE");

    // Public API: interpretFailure is the canonical surface.
    const interp = geminiLocalAdapter.interpretFailure({ exitCode: 55, signal: null });
    expect(interp.errorCode).toBe("gemini_workspace_not_trusted");
    expect(interp.retryable).toBe(false);
    expect(interp.humanMessage).toContain("GEMINI_CLI_TRUST_WORKSPACE");
  });

  it("(g) Invariant 2: 429 + preview-model body → errorCode=gemini_capacity_exhausted_preview, retryable=true", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "MODEL_CAPACITY_EXHAUSTED",
        metadata: { model: "gemini-3-pro-preview" },
      },
    });
    const interp = geminiLocalAdapter.interpretFailure({
      exitCode: 1,
      signal: null,
      responseBody: body,
    });
    expect(interp.errorCode).toBe("gemini_capacity_exhausted_preview");
    expect(interp.retryable).toBe(true);
    expect(interp.humanMessage).toContain("gemini-2.5-pro");

    // Sanity: a generic exit-1 with no preview signature falls back to
    // "unknown" so we know this didn't accidentally swallow normal errors.
    const generic = geminiLocalAdapter.interpretFailure({
      exitCode: 1,
      signal: null,
      responseBody: "boring stderr line\n",
    });
    expect(generic.errorCode).toBe("unknown");

    // 429 alone (no preview-model token) is also not the preview-capacity
    // case — that's a generic rate-limit on a non-preview tier.
    const onlyRate = geminiLocalAdapter.interpretFailure({
      exitCode: 1,
      signal: null,
      responseBody: '{"error":"429 too many requests"}',
    });
    expect(onlyRate.errorCode).toBe("unknown");
  });

  it("(h) default model: buildArgs includes --model gemini-2.5-pro when adapterConfig.model is unset", () => {
    const argv = geminiLocalAdapter.buildArgs({
      prompt: "x",
      sessionId: null,
      authMode: "subscription",
      workdir: "/tmp",
      adapterConfig: {},
      instructionsFilePath: null,
    });
    const idx = argv.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe("gemini-2.5-pro");
    // Sanity: stream-json output mode + yolo approval are also present.
    expect(argv).toContain("--output-format");
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--approval-mode");
    expect(argv).toContain("yolo");

    // Operator override lands.
    const argv2 = geminiLocalAdapter.buildArgs({
      prompt: "x",
      sessionId: null,
      authMode: "subscription",
      workdir: "/tmp",
      adapterConfig: { model: "gemini-3-pro-preview" },
      instructionsFilePath: null,
    });
    const idx2 = argv2.indexOf("--model");
    expect(argv2[idx2 + 1]).toBe("gemini-3-pro-preview");

    // `auto` from the legacy server adapter convention falls back to the
    // pinned default (Invariant 2 — never run a preview tier on retry).
    const argv3 = geminiLocalAdapter.buildArgs({
      prompt: "x",
      sessionId: null,
      authMode: "subscription",
      workdir: "/tmp",
      adapterConfig: { model: "auto" },
      instructionsFilePath: null,
    });
    const idx3 = argv3.indexOf("--model");
    expect(argv3[idx3 + 1]).toBe("gemini-2.5-pro");
  });
});
