# Runner test strategy

_Last updated 2026-05-18. Authoritative layout of the runner package's
test pyramid + the explicit "untestable line" we respect._

## Coverage snapshot

Measured via `pnpm --filter @founderos/runner test --coverage` (vitest + v8):

| File              | Line cov | Branch cov | Notes |
|-------------------|---------:|-----------:|-------|
| `dispatcher.ts`   | 100% | 100% | Fully unit-covered (`dispatcher.test.ts`). |
| `api.ts`          | 97% | 93% | HTTP wire + retry loop fully covered. |
| `config.ts`       | 94% | 89% | Env-var parsing; edge env paths uncovered. |
| `main.ts`         | 90% | 68% | Backoff escalation untested by design (timer-based, flake risk). |
| `spawn.ts`        | 92% | 81% | The remaining 8% is the SIGKILL escalation gap — see "Known bugs" below. |
| `adapters/claude.ts`  | 76% | 72% | Unit + lifecycle. SIGKILL gap shared with spawn.ts. |
| `adapters/codex.ts`   | 67% | 50% | Subscription-mode CLI semantics. |
| `adapters/gemini.ts`  | 64% | 50% | Workspace-trust pre-flight semantics. |
| `cli.ts`          | 58% | 86% | Subcommands (`login`, `init`) not yet exercised. |
| `handlers/types.ts` | 0% | 0% | **Pure types — no runtime. Not a real coverage gap.** |

Aggregate: **74.55% / 67.35%** (statements/branches) across 112 tests in
14 files. 1 skipped (the SIGKILL-no-escalation regression test — see
below).

## Test layering

| Layer | File | What it covers | What it does NOT cover |
|-------|------|----------------|------------------------|
| Pure helpers | `spawn-pure.test.ts`, `cli-flags.test.ts`, `config.test.ts` | `buildClaudeArgs`, `parseStreamJsonLine`, flag parsing, env load | No I/O. |
| Adapter unit | `adapters/claude.test.ts`, `handlers/types.test.ts` | Per-adapter helpers + interface compile-time shapes | No spawn. |
| Adapter lifecycle | `claude-adapter-run.test.ts`, `codex-adapter-run.test.ts`, `gemini-adapter-run.test.ts` | AsyncGenerator run lifecycle with `vi.mock("node:child_process")` (synthetic EventEmitter child) | Real subprocess primitives. |
| API client | `api.test.ts` | HTTP wire format via fake `fetch` | Real TCP / Bearer-on-the-wire / fetch quirks. |
| Loop integration | `main-loop.test.ts`, `main-dispatcher.test.ts` | poll → claim → complete with stubbed API client + mocked dispatcher | Real `fetch`, real subprocess. |
| **HTTP E2E** | **`main-http-e2e.test.ts`** | Real `http.createServer` + real `fetch`. Verifies Bearer headers on the wire, JSON body shape, retry-on-5xx, 401 routing. | Subprocess work (dispatcher still mocked). |
| **Subprocess E2E** | **`spawn-e2e.test.ts`** | Real `child_process.spawn` against bash fake CLIs in `/tmp`. Verifies stream-json parsing across chunk boundaries, stderr surfacing, tempfile cleanup, binary-not-found, oversized-line. | LLM provider calls. |

Both E2E layers (`*-e2e.test.ts`) were added 2026-05-18. They sit ON TOP
of the existing unit pyramid — neither replaces nor duplicates lower
tiers.

## What's untestable (intentional ceiling)

We do NOT test:

1. **Real provider API calls** (Anthropic / OpenAI / Google). Tests would
   need real credentials + live network + cost money. Adapter lifecycle
   tests with mocked `fetch` are the right ceiling.
2. **Real founder-installed CLIs** (`claude`, `codex`, `gemini` binaries
   on the laptop). Tests stub these with bash scripts so they're hermetic.
   "Does the real `claude --print -` work?" is a CI integration test
   problem, not a unit test problem.
3. **Founder-machine signal-handling quirks** (macOS vs Linux SIGTERM
   semantics, supervisor systems like launchd). E2E tests on macOS catch
   the macOS-specific bugs; Linux deployments would need their own probe.

## Known bugs surfaced by E2E testing

### SIGKILL escalation does not fire after a trapped SIGTERM

**Where:** `spawn.ts:117-119` and `adapters/claude.ts:360-376`. Both
guard the SIGKILL backstop on `if (!child.killed) child.kill("SIGKILL")`.

**Why broken:** Per Node docs, `child.killed` is set to `true` after
`child.kill(SIG)` is invoked SUCCESSFULLY — not after the child has
actually died. Once SIGTERM is sent and the child traps/ignores it,
`child.killed === true` and the SIGKILL escalation timer fires but its
guard short-circuits. A trapped-SIGTERM CLI hangs for its full natural
runtime.

**Fix shape (when prioritized):** Replace the `!child.killed` guard with
a local `let exited = false` boolean, set to `true` in the exit
handler. Two-line fix, but it must be applied in lockstep to both
`spawn.ts` and `adapters/claude.ts` (and probably the same pattern in
`adapters/gemini.ts` / `adapters/codex.ts` — verify before fixing).

**Test gating this fix:** `spawn-e2e.test.ts` test (h) is `.skip`'d
with a complete repro comment. After the fix, un-skip and flip the
assertion to `expect(elapsed).toBeLessThan(1500)` for `timeoutSec=0.4`.

**Production blast radius:** Low for the `runClaude()` path (legacy
after PHASE-S7 dispatcher canonicalization — only npm re-exports +
tests reach it). Higher for `adapters/claude.ts` because that's the
hot path. Real-world trigger: a `claude` CLI that's mid-network-call
when SIGTERM arrives may not respond to the soft kill within the
SIGTERM grace window.

### Unbounded stdout line buffer (documented, not yet fixed)

**Where:** `spawn.ts:129` — `stdoutBuf += chunk` grows without a cap.

**Why limited risk:** `claude --output-format=stream-json` emits one
JSON object per newline, bounded by what the model produces. A
malicious or buggy CLI emitting megabytes without a newline could
blow process memory. E2E test (g) documents 10MB behavior (no crash,
no event emitted) as the current ceiling.

**Fix shape (when prioritized):** Cap the buffer at e.g. 1MB and emit
a truncation `stdout_line` event. Make the cap configurable via
`RunnerConfig`.

## Running the suite

```bash
# Full runner test suite + coverage.
pnpm --filter @founderos/runner test -- --coverage

# E2E only.
cd packages/runner && pnpm exec vitest run src/__tests__/*-e2e.test.ts

# Single test by name pattern.
cd packages/runner && pnpm exec vitest run -t "claim-loop"
```

E2E tests write fake CLI scripts to `os.tmpdir()/founderos-runner-e2e-fixtures/`
and clean up via `afterAll`. The HTTP E2E test binds to a random
localhost port (`server.listen(0, "127.0.0.1")`) — safe to run in
parallel with other suites.

## When to add a new E2E test

Add to `*-e2e.test.ts` when:

- A bug repro requires the real subprocess primitive or real `fetch`
  layer (the unit tier's mocks would hide it).
- The fix touches `spawn.ts` orchestration, `main.ts` event-flush
  semantics, or `api.ts` retry-loop conditions.

Stay at the unit tier when:

- The bug is in a pure helper (`buildClaudeArgs`, `parseStreamJsonLine`).
- The bug is in an adapter's argv composition.
- The fix only affects the AsyncGenerator's event sequencing (lifecycle
  test with mocked `node:child_process` is the right primitive).
