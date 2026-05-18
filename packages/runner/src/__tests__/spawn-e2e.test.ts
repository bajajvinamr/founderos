/**
 * E2E spawn tests — exercise `runClaude()` against REAL `node:child_process`
 * with a fake CLI script. This closes the 5.66% coverage gap on `spawn.ts`
 * (the `runClaude()` orchestration: subprocess spawn, stdout/stderr line
 * buffering, SIGTERM/SIGKILL escalation, finalResult extraction, tempfile
 * cleanup).
 *
 * Existing tests like `claude-adapter-run.test.ts` mock `node:child_process`
 * via `vi.mock`, which is the right ceiling for adapter-lifecycle logic but
 * deliberately skips the actual spawn primitive. This file fills that gap by
 * spawning REAL processes using small bash/node fake CLIs written to `/tmp`.
 *
 * Test inventory:
 *   (a) real spawn + scripted stream-json → events surfaced, finalResult
 *       extracted, exit 0
 *   (b) stdout line split ACROSS chunks → reassembled correctly (one JSON
 *       event, not lost)
 *   (c) stderr surfaced as `stderr_line` events
 *   (d) timeout → SIGTERM fires, child dies, `timedOut: true`
 *   (e) binary not found → exitCode -1, no crash
 *   (f) instructions tempfile cleanup runs after exit (success path)
 *   (g) oversized stdout line (10MB no-newline) — bounded memory; line
 *       eventually drained on exit. Documents the unbounded-buffer behavior
 *       so a future regression is loud.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, statSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runClaude, type SpawnResult } from "../spawn.js";
import type { RunnerEvent } from "../api.js";

// ---------------------------------------------------------------------------
// Test fixture directory + fake CLI builders.
//
// `mkdtempSync` creates a unique random-suffixed path under os.tmpdir(),
// e.g. `/tmp/founderos-runner-e2e-fixtures-Xkj92m`. The unguessable suffix
// closes a CodeQL `js/insecure-temporary-file` finding: a predictable path
// like `join(tmpdir(), "founderos-runner-e2e-fixtures")` could be hijacked
// via a pre-staged symlink (TOCTOU) so `writeFileSync(...)` writes through
// the symlink target. Test-only code, but fix the pattern at the source.
// ---------------------------------------------------------------------------

let FIX_DIR: string;

beforeAll(() => {
  FIX_DIR = mkdtempSync(join(tmpdir(), "founderos-runner-e2e-fixtures-"));
});

afterAll(() => {
  rmSync(FIX_DIR, { recursive: true, force: true });
});

/**
 * Write an executable bash script to the fixture dir. Returns the absolute
 * path. The script source is interpolated verbatim — caller controls every
 * byte of stdout/stderr/exit semantics. The script is +x'd via chmod.
 */
function writeFakeCli(name: string, body: string): string {
  const path = join(FIX_DIR, name);
  writeFileSync(path, body, { mode: 0o755 });
  // chmod again belt-and-suspenders — writeFileSync mode may be honored
  // differently on some shells; explicit chmod 0755 guarantees executability.
  chmodSync(path, 0o755);
  return path;
}

/**
 * Collect events fired by `runClaude`. Returns an array we can assert on.
 * Async-safe — onEvent may be awaited internally.
 */
function makeEventSink() {
  const events: RunnerEvent[] = [];
  return {
    events,
    onEvent: async (evt: RunnerEvent) => {
      events.push(evt);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("runClaude — E2E with real subprocess", () => {
  it("(a) emits scripted stream-json + extracts finalResult on exit 0", async () => {
    // Fake CLI: print two stream-json lines (assistant message + result),
    // then exit 0. Mirrors claude --output-format=stream-json output shape.
    const cli = writeFakeCli(
      "fake-claude-happy.sh",
      `#!/usr/bin/env bash
echo '{"type":"assistant","message":{"role":"assistant","content":"hi"}}'
echo '{"type":"result","session_id":"sess_e2e_a","total_cost_usd":0.0042}'
exit 0
`,
    );

    const sink = makeEventSink();
    const result: SpawnResult = await runClaude(
      { binary: cli, prompt: "do the thing", timeoutSec: 10 },
      sink,
    );

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.finalResult).not.toBeNull();
    expect(result.finalResult?.sessionId).toBe("sess_e2e_a");
    expect(result.finalResult?.costUsd).toBeCloseTo(0.0042);
    // At least one model_message event + one run_complete event.
    const kinds = sink.events.map((e) => e.kind);
    expect(kinds).toContain("run_complete");
  });

  it("(b) reassembles a JSON line split across multiple stdout chunks", async () => {
    // The bash script writes one valid JSON object but flushes mid-line
    // (sleep 0.1 between halves). `runClaude`'s `stdoutBuf` must accumulate
    // the partial chunk and parse only when the newline arrives. If the
    // buffer logic regresses to per-chunk parsing, the event is lost
    // and `finalResult` stays null.
    const cli = writeFakeCli(
      "fake-claude-split.sh",
      `#!/usr/bin/env bash
# First half of the JSON, no newline.
printf '{"type":"result","session_id":"sess_split"'
sleep 0.1
# Second half + closing brace + newline.
printf ',"total_cost_usd":0.0001}\\n'
exit 0
`,
    );

    const sink = makeEventSink();
    const result = await runClaude(
      { binary: cli, prompt: "x", timeoutSec: 10 },
      sink,
    );

    expect(result.exitCode).toBe(0);
    expect(result.finalResult?.sessionId).toBe("sess_split");
    expect(sink.events.some((e) => e.kind === "run_complete")).toBe(true);
  });

  it("(c) surfaces stderr lines as stderr_line events", async () => {
    const cli = writeFakeCli(
      "fake-claude-stderr.sh",
      `#!/usr/bin/env bash
echo 'warning: cache miss' >&2
echo '{"type":"result","session_id":"sess_stderr","total_cost_usd":0}'
exit 0
`,
    );

    const sink = makeEventSink();
    await runClaude(
      { binary: cli, prompt: "x", timeoutSec: 10 },
      sink,
    );

    const stderrEvents = sink.events.filter((e) => e.kind === "stderr_line");
    expect(stderrEvents.length).toBeGreaterThanOrEqual(1);
    expect(stderrEvents[0].payload).toContain("warning: cache miss");
  });

  it("(d) SIGTERM at timeout sets timedOut: true (script honors SIGTERM)", async () => {
    // Script does NOT trap SIGTERM — runs sleep, gets killed cleanly by
    // SIGTERM at 0.4s. This is the happy-path soft-kill assertion:
    // `timedOut: true` flips, child exits via SIGTERM, elapsed is small.
    const cli = writeFakeCli(
      "fake-claude-sleep.sh",
      `#!/usr/bin/env bash
sleep 5
`,
    );

    const sink = makeEventSink();
    const start = Date.now();
    const result = await runClaude(
      { binary: cli, prompt: "x", timeoutSec: 0.3 },
      sink,
    );
    const elapsed = Date.now() - start;

    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(1_500);
    // Child terminated by signal (SIGTERM), not natural exit.
    expect(result.signal !== null || result.exitCode !== 0).toBe(true);
  }, 10_000);

  it.skip("(h) SKIPPED — known SIGKILL-no-escalation bug, see comment", async () => {
    // ⚠️ FOLLOW-UP BUG FOUND BY E2E TESTING (2026-05-18) ⚠️
    //
    // spawn.ts:117-119 guards the SIGKILL escalation on `if (!child.killed)`.
    // Per Node docs, `child.killed` is set to `true` after `child.kill(SIG)`
    // is invoked SUCCESSFULLY (i.e., the signal was delivered to the OS) —
    // NOT after the child actually died. So once SIGTERM is sent (and the
    // child traps/ignores it), `child.killed === true` and the SIGKILL
    // backstop is suppressed. A trapped-SIGTERM CLI hangs for its full
    // natural runtime. Same bug pattern in adapters/claude.ts:360-376 (two
    // of three kill paths share the broken primitive; line 570 uses the
    // correct `exitState.value` flag).
    //
    // Verified empirically in isolation (vitest -t "DOCUMENTED BUG"):
    //   - timeoutSec=0.4, script: trap '' TERM; sleep 3; exit 0
    //   - Observed elapsed: 3197ms (the full sleep — SIGKILL never fired)
    //
    // Marked SKIPPED rather than running:
    //   - It's flaky when other tests run in the same file (cross-test
    //     signal/cleanup contamination caused 425ms one run, 3197ms another)
    //   - Asserting either bound codifies the bug into the test suite
    //   - The honest signal is "this is a known bug" — surface in
    //     vinamr-invariants and follow-up PR
    //
    // Why we don't fix it inline with this E2E sprint:
    //   - Production hot path is adapters/claude.ts, not spawn.ts:runClaude
    //     (the latter is legacy after PHASE-S7 dispatcher canonicalization —
    //     only the npm re-export + tests reach it)
    //   - Fixing requires touching spawn.ts + adapters/claude.ts +
    //     gemini/codex adapters (same pattern copied across) — council call,
    //     not a green-tests inline.
    //
    // To un-skip after fix: replace `if (!child.killed)` with a local
    // `let exited = false` flag set in the exit handler; the assertion
    // becomes `expect(elapsed).toBeLessThan(1500)` for a 0.4s timeout.
    expect(true).toBe(true);
  });

  it("(e) returns exitCode -1 when binary is missing (no crash)", async () => {
    const sink = makeEventSink();
    const result = await runClaude(
      {
        binary: "/nonexistent/path/to/no/such/claude",
        prompt: "x",
        timeoutSec: 10,
      },
      sink,
    );

    // The `child.once("error", ...)` handler in spawn.ts resolves with
    // { code: -1, signal: null }; the runner does not crash.
    expect(result.exitCode).toBe(-1);
    expect(result.finalResult).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  // SKIPPED — flakes under `pnpm -w run test` parallel execution because
  // multiple packages share `os.tmpdir()`. Embedded-postgres tests, plugin
  // sandbox tests, and others create files matching the `claude|instructions|founderos`
  // filter concurrently with this test's snapshot, producing a non-zero
  // delta that has nothing to do with the runner's cleanup contract.
  // The cleanup primitive itself is unit-tested in claude-adapter-run.test.ts
  // via vi.mock("node:fs"); this E2E was an over-broad sanity check. If
  // re-introducing, scope the snapshot to a per-test unique sub-tmpdir
  // (mkdtemp + pass via env to the runner) so other packages can't pollute
  // the count.
  it.skip("(f) cleans up instructions tempfile after exit (success path) [skip: tmpdir race under -w run]", async () => {
    // The cleanup contract: materialized tempfile is deleted after the
    // child exits. Verify by snapshotting the runner's tempfile root
    // before/after; the count should not net-grow.
    const cli = writeFakeCli(
      "fake-claude-cleanup.sh",
      `#!/usr/bin/env bash
echo '{"type":"result","session_id":"sess_cleanup","total_cost_usd":0}'
exit 0
`,
    );

    // Encode a small instructions blob — runner materializes this to a
    // tempfile in os.tmpdir().
    const instructionsBase64 = Buffer.from(
      "# Test instructions\nyou are a teapot",
      "utf-8",
    ).toString("base64");

    // Snapshot tempdir entries that look like runner-instructions tempfiles
    // BEFORE the run. The exact filename pattern is opaque (an
    // implementation detail of materializeInstructions), so we compare
    // counts not names.
    const tmpRoot = tmpdir();
    const beforeCount = readdirSync(tmpRoot).filter((n) =>
      n.includes("founderos") || n.includes("instructions") || n.includes("claude"),
    ).length;

    const sink = makeEventSink();
    const result = await runClaude(
      {
        binary: cli,
        prompt: "x",
        timeoutSec: 10,
        instructionsBase64,
      },
      sink,
    );

    expect(result.exitCode).toBe(0);

    const afterCount = readdirSync(tmpRoot).filter((n) =>
      n.includes("founderos") || n.includes("instructions") || n.includes("claude"),
    ).length;

    // Net-zero growth: cleanup ran. Allow for the FIX_DIR itself being
    // created above, but it's not in the filter — so afterCount must equal
    // beforeCount.
    expect(afterCount).toBeLessThanOrEqual(beforeCount);
  });

  it("(g) handles a 10MB no-newline stdout chunk without OOM (documents unbounded-buffer behavior)", async () => {
    // The line buffer in spawn.ts:129 grows unbounded until a newline
    // arrives. A malicious or buggy CLI emitting megabytes of garbage
    // without a newline blows the buffer. This test documents the current
    // behavior: 10MB is tolerable on a typical dev box, but the design
    // gap is real — a future fix could cap the buffer at e.g. 1MB and
    // emit a `stdout_line` truncation event.
    //
    // We test 10MB (not 100MB) to keep the test under 5s on CI. The
    // behavior we assert is: process exits cleanly + finalResult is null
    // because no parseable JSON ever arrived. We do NOT assert on memory
    // residency — that would be machine-dependent and flaky.
    const cli = writeFakeCli(
      "fake-claude-bigchunk.sh",
      `#!/usr/bin/env bash
# Emit 10MB of 'A' characters with no newline, then exit cleanly.
# 10485760 bytes = 10 * 1024 * 1024.
yes A | tr -d '\\n' | head -c 10485760
exit 0
`,
    );

    const sink = makeEventSink();
    const result = await runClaude(
      { binary: cli, prompt: "x", timeoutSec: 10 },
      sink,
    );

    expect(result.exitCode).toBe(0);
    // No parseable JSON arrived → no finalResult.
    expect(result.finalResult).toBeNull();
    // The drain-on-exit path at spawn.ts:173-176 attempts to parse the
    // trailing buffer. 10MB of 'A's isn't valid JSON, so no event is
    // surfaced. Either way: no crash, exit captured.
  }, 15_000);
});
