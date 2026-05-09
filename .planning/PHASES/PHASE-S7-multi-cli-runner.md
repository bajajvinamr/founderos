# Sprint 7 — Multi-CLI Runner (BYO-AI expansion)

_Status: planned · Effort: 3 weeks (1 prereq + 4 sub-phases) · Depends on: S2 (parallelizable with S3+) · Blocks: design-partner reach beyond Claude-Pro users · **Revised 2026-05-07 after council R1+R2 PASS WITH CONDITIONS**_

> **Council revision summary** (2026-05-07): Original plan was strategically right but architecturally premature. R1+R2 (Codex gpt-5.4 + Gemini 3.1-pro-preview) found 4 confirmed P1s requiring rework before any code lands. Changes applied:
> - **NEW S7.0 prerequisite phase** with 4 tickets (S7.0.1 through S7.0.4) that MUST complete before S7.1
> - **S7.1 interface expanded** from 4-method to full-lifecycle (`run()` ownership + lifecycle hooks for tempfile/skill-injection/timeout)
> - **S7.2 rewritten** to introduce `executionTransport` signal so UI/server code paths gating on `byo_runner` literal don't break
> - **S7.3 revised** to include `setupEnvironment()` step for adapter skill injection
> - **S7.10 + S7.11 DELETED** — `hermes-paperclip-adapter` is already a `server/package.json` dependency registered in `server/src/adapters/registry.ts:184`; creating `packages/adapters/hermes-local/` from scratch was wrong end-to-end. Replaced with S7.0.3 (decide policy) and conditional S7.15 (only if policy chooses externalization)
> - **S7.7 (Cursor)** gets a prereq fix: existing package exports `"cursor"` not `"cursor_local"` — normalized in S7.0.4
> - Decision logged: `~/.gstack/projects/bajajvinamr-founderos/decisions.md` 2026-05-07

## Goal

> Unlock 6 additional CLI runtimes (Gemini, Codex, Cursor, OpenCode, Pi, Hermes) so design partners aren't locked to Claude Code. Today the runner hardcodes `claude` (`packages/runner/src/spawn.ts:runClaude`); this collapses the buyer's addressable market to "people who already have Claude Pro." Multi-CLI is the ICP-expansion lever — biggest unlock is the India/Gemini-ecosystem (free tier) and the ChatGPT/Codex segment.

## Why now (load-bearing context)

- The buyer is sending FounderOS to design partners THIS WEEK. Gemini support is the highest-impact CLI to ship first (free tier + India-heavy adoption).
- BYO-AI economics are the unit-economics moat: each user pays Anthropic/Google/OpenAI directly via their own subscription. Claude-only locks ~60% of would-be partners out of the funnel.
- `FOUNDEROS_BYO_RUNNER_ENABLED=1` is already live in prod — runner package is in production but only spawns claude. Adapter packages already exist for 5 of 6 targets. The dispatcher is missing, that's the keystone.

## Success criteria

1. **Dispatcher is adapter-aware**: `runner/src/spawn.ts` dispatches on `agent.adapter_type`; `main.ts` no longer hardcodes `runClaude` import.
2. **Claude + Gemini both ship end-to-end this sprint**: a design partner with EITHER `claude` CLI OR `gemini` CLI can complete onboarding, run their first agent task, and see results in the UI.
3. **6 additional adapters wired**: Codex, Cursor, OpenCode, Pi, Hermes (after package creation), each with a smoke test that proves spawn → result extraction works against a real CLI install.
4. **User choice preserved end-to-end**: the `byo_runner` adapter-type collapse at `server/src/services/onboarding-bootstrap.ts:307` is reversed; `agent.adapter_type` reaches the runner with the user's actual selection.
5. **Onboarding UI surfaces all 7 CLI choices** with friction-honest copy (subscription/install requirements per CLI).
6. **Agent settings allow post-onboarding CLI swap** (per agent, not per workspace).
7. **E2E coverage** for Claude + Gemini in CI; smoke tests for the other 5 in `e2e/tests/critical-flows.spec.ts`.
8. **"Claude only" gate removed** from production onboarding once at least Claude + Gemini are e2e-green.

QA acceptance: a real install of Gemini CLI on a fresh machine, paired with FounderOS onboarding, runs an agent task end-to-end without manual intervention. Council PASS verdict on the dispatcher refactor PR.

## What exists today (don't rebuild)

| Surface | Where | Status |
|---|---|---|
| `claude_local` adapter | `packages/adapters/claude-local/` | ✓ live + the only CLI runner spawns today |
| `gemini_local` adapter package | `packages/adapters/gemini-local/` | ✓ exists; not wired to runner |
| `codex_local` adapter package | `packages/adapters/codex-local/` | ✓ exists; not wired to runner |
| `cursor_local` adapter package | `packages/adapters/cursor-local/` | ✓ exists; not wired to runner |
| `opencode_local` adapter package | `packages/adapters/opencode-local/` | ✓ exists; not wired to runner |
| `pi_local` adapter package | `packages/adapters/pi-local/` | ✓ exists; not wired to runner |
| `hermes_local` package | `packages/adapters/hermes-local/` | ✗ DOES NOT EXIST — type slot only |
| Type slot `hermes_local` | `packages/adapter-utils/src/session-compaction.ts:44` | ✓ registered |
| Hermes UI metadata | `ui/src/adapters/adapter-display-registry.ts:77` | ✓ registered |
| `runner_jobs` schema | DB table holds adapter_type per job | ✓ live |
| `agent.adapter_type` | flows from agent → runner_job | ✓ wired ALMOST end-to-end (collapse at onboarding) |
| `BYO_RUNNER` flag | `FOUNDEROS_BYO_RUNNER_ENABLED=1` in Fly | ✓ live |
| Runner long-poll loop | `packages/runner/src/main.ts` | ✓ live; calls `runClaude` directly |
| Runner spawn (Claude-specific) | `packages/runner/src/spawn.ts` | ✓ live; needs dispatcher refactor |
| `AGENT_ADAPTER_TYPES` enum | `packages/shared/src/constants.ts:37` | ✓ all 7 types listed |

## Risk hot-spots (per `~/.claude/rules/vinamr-invariants.md`)

These are the failure modes the planner and council MUST address before any code is written:

- **Stream-json shape divergence**: `spawn.ts` is hardcoded to claude's stream-json event shape. Each CLI emits different event types; `parseStreamJsonLine` per-CLI is required.
- **Auth model divergence**:
  - Claude uses `~/.claude` config + login session
  - Gemini uses `GEMINI_API_KEY` env OR `GEMINI_CLI_TRUST_WORKSPACE=true` — without trust, exits code 55 "not running in a trusted directory" (vinamr-invariants confirmed)
  - Codex sandbox/approval flags `-a`/`-s` cause arg-parse failure (exit 2) — omit unless specifically needed (vinamr-invariants confirmed)
  - Cursor uses Cursor's own auth; offline-only when no Cursor account
- **Session/continuation semantics differ across CLIs**: runner persists `sessionId` for resumability. Need a per-CLI session-id map; some CLIs may not support continuation at all.
- **Cost-tracking parity**: Claude emits `cost_usd` in result events; Gemini/Codex don't always. The cost field becomes nullable; analytics dashboard must gracefully handle absent cost.
- **The `byo_runner` adapter-type collapse** at `onboarding-bootstrap.ts:307` was the original ADR-011 fix. Reversing it without reintroducing the "agents can't actually run on hosted Fly" gap is the load-bearing decision — runner_jobs queue mechanism stays; only the adapter_type field reflects the user's actual choice.
- **CLI version drift**: each CLI evolves independently. Pinning a known-working invocation per adapter (and surfacing version mismatch warnings) prevents silent breakage on next CLI release.
- **`Agent({isolation: "worktree"})` does NOT 100% partition writes** (vinamr-invariants confirmed): if multiple agents implement adapters in parallel worktrees, always run `git diff --name-only HEAD` before commit. Restore phantom changes via `git restore`.

**Council requirement**: ✅ COMPLETED 2026-05-07 (R1+R2, FULL mode, Codex gpt-5.4 + Gemini 3.1-pro-preview). Verdict: PASS WITH CONDITIONS. Findings applied throughout this revised plan.

---

## Tickets

### S7.0 — Prerequisites (NEW — must complete before S7.1)

These 4 tickets resolve council-found blockers. None are optional. Estimated 3-4 days for all four.

---

### Ticket S7.0.1 — Add `adapter_type` to runner_jobs schema + enqueue + claim payload

**PM intent**: Council R1+R2 confirmed (Codex P1, both rounds): the runner cannot dispatch on adapter_type because `runner_jobs` schema has no such column. The enqueue path doesn't write it. The claim API doesn't return it. **Without this ticket, S7.1's dispatcher has nothing to dispatch on.**

**Engineering**:
- Migration: add `adapter_type TEXT NOT NULL DEFAULT 'claude_local'` column to `runner_jobs` table (per `packages/db/src/schema/runner.ts:129`). Add CHECK constraint mirroring `AGENT_ADAPTER_TYPES`. Default value matches current production behavior (claude-only).
- Backfill is trivial — all existing rows are claude. No backfill ticket needed.
- Enqueue path: `server/src/adapters/byo-runner/index.ts:132` currently writes `prompt`, `promptHash`, `sessionIdHint`, `runtimeConfig`, `status`. Add `adapter_type: agent.adapterType` to the insert.
- Claim API: extend `JobPayload` interface in `packages/runner/src/api.ts:26` to include `adapterType: AgentAdapterType`. Update `server/src/routes/runner.ts:303` to return the column value.
- Server-side OpenAPI/Zod schemas updated to match.
- Tests: existing claim test fixtures get adapter_type; assert it round-trips through enqueue → claim → JobPayload.

**Files**:
- New: `packages/db/src/migrations/0105_runner_jobs_adapter_type.sql`
- New: `packages/db/src/migrations/meta/0105_snapshot.json` (per the gappy pattern from PR #86/#87)
- Edit: `packages/db/src/schema/runner.ts:129` (add column to schema)
- Edit: `server/src/adapters/byo-runner/index.ts:132` (write column on enqueue)
- Edit: `server/src/routes/runner.ts:303` (return column on claim)
- Edit: `packages/runner/src/api.ts:26` (extend JobPayload type)
- Edit: existing claim/enqueue tests + add new round-trip assertion

**Council before merge**: NO (this is the prerequisite the council itself called for; no architectural ambiguity).

**QA**:
- New runner_jobs row has correct adapter_type per the agent that triggered it
- Claim API returns adapter_type in JobPayload
- Existing prod runner_jobs rows continue to work (default value preserves them)
- Migration applies cleanly on embedded PG + against a Fly MPG snapshot

---

### Ticket S7.0.2 — Extend onboarding API + UI schemas to accept all CLI choices

**PM intent**: Council R1 confirmed (Codex P2): `server/src/routes/onboarding.ts:82` Zod enum is `["claude_local", "anthropic_api", "skip"]`; `ui/src/components/onboarding/onboarding-types.ts:127` ADAPTER_CHOICES is the same triple. **Today there is no way to even submit "Gemini" through the onboarding flow.** S7.4's QA ("founder picks Gemini") is impossible without this.

**Engineering**:
- Extend `adapterChoiceSchema` Zod enum at `server/src/routes/onboarding.ts:82` to include all 7 CLI choices: `claude_local`, `anthropic_api`, `gemini_local`, `codex_local`, `cursor_local`, `opencode_local`, `pi_local`, `hermes_local`, `skip`.
- Extend `ADAPTER_CHOICES` constant in `ui/src/components/onboarding/onboarding-types.ts:127` to match.
- Add `mapOnboardingChoiceToAdapter` helper (per CLAUDE.md gotchas: `server/src/services/adapter-resolver.ts` is the right home if it exists, else create). Keep `claude_local` for `claude_local`/`anthropic_api`/`skip`; map all `*_local` choices to themselves.
- Tests: enum acceptance tests for all 7 + `skip`; rejection tests for unknown values.

**Files**:
- Edit: `server/src/routes/onboarding.ts:82`
- Edit: `ui/src/components/onboarding/onboarding-types.ts:127`
- Edit/New: `server/src/services/adapter-resolver.ts` (add or extend `mapOnboardingChoiceToAdapter`)
- Tests: `server/src/routes/__tests__/onboarding.test.ts` (or wherever onboarding tests live)

**QA**:
- POSTing onboarding with `adapterChoice: "gemini_local"` succeeds
- POSTing with `"foo_local"` 400s
- Helper maps each choice to expected adapter_type

---

### Ticket S7.0.3 — Decide Hermes policy (founder decision required)

**PM intent**: Council R1+R2 confirmed (both models, P1): the original S7.10 plan ("create `packages/adapters/hermes-local/` from scratch") is wrong end-to-end. Reality: `hermes-paperclip-adapter` is already a `server/package.json` dependency (line ~72) and registered in `server/src/adapters/registry.ts:184` as `type: "hermes_local"`. Meanwhile `AGENTS.md:168` mandates: "core has NO `hermes-paperclip-adapter` dependency and NO built-in `hermes_local` registration. Install Hermes via the Adapter Plugin manager." **Two contradictory states need a single founder decision.**

**Engineering**:
This is a 30-minute decision call, not engineering work. The decision determines whether S7.C runs at all and what S7.15 (new ticket) becomes.

**Options**:
- **A. Keep `hermes-paperclip-adapter` as a built-in dependency.** Hermes already works. No further work in S7. Trade-off: violates AGENTS.md invariant; technical debt for the next contributor reading AGENTS.md.
- **B. Strip built-in Hermes per AGENTS.md.** Remove `hermes-paperclip-adapter` from `server/package.json`. Remove its registration in `server/src/adapters/registry.ts:184`. Wire Hermes via the Adapter Plugin manager pattern. Trade-off: ~3 days of plugin-system work that doesn't move the design-partner needle this sprint. AGENTS.md compliance.
- **C. Defer.** Leave Hermes as-is in S7. Open S8 ticket to decide. Ship the other 5 CLIs without touching Hermes.

**Recommended**: Option C if buyer has zero design partners using Hermes. Option B if AGENTS.md compliance is a stated requirement. Option A is defensible only if founder accepts the technical-debt note.

**Files**:
- New: ADR `docs/adr/013-hermes-adapter-policy.md` recording the decision
- Update: `AGENTS.md:168` if option A or C is chosen (modify the "no built-in" claim to match reality)

**QA**:
- ADR exists with date + decision + rationale
- If option B: no `hermes-paperclip-adapter` in `server/package.json`; no built-in registration in `registry.ts`
- If option A or C: `AGENTS.md:168` no longer claims "no built-in Hermes"

---

### Ticket S7.0.4 — Normalize Cursor adapter type name

**PM intent**: Council R1 confirmed (Codex P2): `packages/adapters/cursor-local/src/index.ts:1` exports `type = "cursor"` while `AGENT_ADAPTER_TYPES` in `packages/shared/src/constants.ts` lists `"cursor"` (without `_local`). Plan ticket S7.7 calls it `cursor_local`. The enum and the package agree on `"cursor"`; the original plan was wrong. Normalize before any wiring touches it.

**Engineering**:
- Decision: pick canonical name. Recommend `cursor_local` to match the `*_local` family pattern (claude_local, gemini_local, codex_local, etc.). The current `"cursor"` is the outlier.
- If `cursor` → `cursor_local`: rename in `packages/adapters/cursor-local/src/index.ts:1`; update `AGENT_ADAPTER_TYPES`; grep all callsites; update any DB rows (likely none in prod).
- If keep `cursor`: update `AGENT_ADAPTER_TYPES` to NOT have `_local` suffix for cursor; update plan tickets S7.7 and S7.12 to use `"cursor"` instead of `"cursor_local"`.

**Recommended**: rename to `cursor_local` for family consistency.

**Files**:
- Edit: `packages/adapters/cursor-local/src/index.ts:1`
- Edit: `packages/shared/src/constants.ts` (AGENT_ADAPTER_TYPES)
- Edit: `packages/adapter-utils/src/session-compaction.ts:42` (if `cursor` is in LEGACY_SESSIONED_ADAPTER_TYPES)
- Edit: `ui/src/adapters/adapter-display-registry.ts` (display map)

**QA**:
- `pnpm typecheck` passes
- `pnpm test` passes (no test references the old name)
- DB migration adds CHECK constraint matching new canonical name (could fold into 0105 from S7.0.1)

---

### S7.A — Ship Gemini end-to-end (this week)

The keystone phase. After this lands, design partners with Gemini CLI installed can use FounderOS.

---

### Ticket S7.1 — Adapter dispatcher in runner (KEYSTONE)

**PM intent**: Today `runner/src/main.ts:21` hardcodes `import { runClaude } from "./spawn.js"`. The runner picks up jobs whose `adapter_type` could be any of 7 values but always spawns claude. After this ticket, the runner reads `job.adapterType` and dispatches to the correct CLI handler. Foundation for everything else in S7.

**REVISED interface (council R1+R2 P1 finding — both models)**: The original 4-method shape (`buildArgs`/`parseStreamLine`/`extractFinalResult`) leaked too much claude-specific concern. Real adapters need to own: prompt transport (Gemini uses positional args, NOT stdin like claude), instructions blob handling (Codex prepends to prompt; Claude uses tempfile + `--append-system-prompt-file`), skill injection (Gemini symlinks `~/.gemini/skills/`), env var injection per CLI, timeout/SIGTERM/SIGKILL escalation policy, version probing. **The dispatcher must own coordination; adapters must own execution.**

**Engineering**:
- Refactor `packages/runner/src/spawn.ts` into an adapter-agnostic dispatcher with a **full-lifecycle handler** interface:
  ```ts
  export interface AdapterSpawnHandler {
    /** CLI binary name resolved at runner config load (e.g. "claude", "gemini"). */
    binary: string;

    /**
     * Pre-spawn setup. Materializes any adapter-specific filesystem state:
     *   - Claude: write `instructionsBase64` to a tempfile for `--append-system-prompt-file`
     *   - Gemini: symlink local skills into `~/.gemini/skills/` per
     *     packages/adapters/gemini-local/src/index.ts:31
     *   - Codex: prepend instructions to the prompt string in-memory
     * Returns env additions + a cleanup() invoked unconditionally on exit.
     */
    setupEnvironment(args: SpawnArgs): Promise<{
      envAdditions: Record<string, string>;
      promptTransform?: (prompt: string) => string;
      addedSkillSymlinks?: string[];
      cleanup: () => Promise<void>;
    }>;

    /**
     * Build argv. Each adapter pins a stable invocation per vinamr-invariants
     * (e.g. Codex MUST NOT receive -a/-s — exit 2; Gemini MUST set
     * GEMINI_CLI_TRUST_WORKSPACE or pass --skip-trust — exit 55 otherwise).
     */
    buildArgs(args: SpawnArgs, ctx: { instructionsFilePath?: string | null }): string[];

    /**
     * Per-CLI prompt-transport policy. "stdin" matches claude today;
     * "positional-arg" matches gemini; "prepended-prompt" matches codex.
     * The dispatcher uses this to wire the spawned child correctly.
     */
    promptTransport: "stdin" | "positional-arg" | "prepended-prompt";

    /** Per-CLI stream-json line shape. Returns null if the line should be skipped. */
    parseStreamLine(line: string): RunnerEvent | null;

    /** Extract sessionId + cost from collected events. Cost may be null per CLI. */
    extractFinalResult(events: RunnerEvent[]): SpawnResult["finalResult"];

    /**
     * Optional: per-CLI exit-code interpretation. Default treats 0 as success.
     * Codex/Gemini may use specific non-zero codes for known states (Gemini exit
     * 55 = workspace not trusted) — adapters can map to clearer errors.
     */
    interpretExitCode?(code: number, signal: string | null): {
      status: "completed" | "failed";
      errorMessage?: string;
    };

    /** Best-effort `binary --version` reader for `runner_jobs.cli_version`. */
    readVersion?(): Promise<string>;
  }
  export const ADAPTER_HANDLERS: Record<AgentAdapterType, AdapterSpawnHandler>;

  /**
   * The dispatcher. Coordinates: setupEnvironment → buildArgs → spawn with
   * correct prompt transport → buffered stdout/stderr parse → SIGTERM/SIGKILL
   * timeout escalation → cleanup → final result extraction.
   * Tests substitute `spawnImpl` to run scripted streams (existing pattern).
   */
  export function runAdapter(
    adapterType: AgentAdapterType,
    args: SpawnArgs,
    hooks: { onEvent: (evt: RunnerEvent) => void | Promise<void> },
    spawnImpl?: typeof spawn,
  ): Promise<SpawnResult>;
  ```
- The dispatcher (NOT the adapter) owns timeout escalation (`SIGTERM` then `SIGKILL` 1.5x later — current behavior at `spawn.ts:226-232`), stdout/stderr line-buffering, and event flushing. This keeps adapters small.
- Move existing claude logic into `packages/runner/src/adapters/claude.ts`. The claude handler implements:
  - `setupEnvironment`: existing `materializeInstructions` logic (spawn.ts:201)
  - `buildArgs`: existing `buildClaudeArgs` (spawn.ts:58)
  - `promptTransport: "stdin"`
  - `parseStreamLine`: existing `parseStreamJsonLine` (spawn.ts:93)
  - `extractFinalResult`: existing finalResult code (spawn.ts:252-258)
- `main.ts:21` import switches from `runClaude` to `runAdapter`. Test seam (`spawnFn?: typeof runClaude`) renamed to `runAdapterFn?: typeof runAdapter`.
- If `job.adapterType` has no registered handler: emit a typed error event and complete the job with `failed` status + clear error message. **Do NOT silently fall back to claude** — that's how regressions hide. Council R1+R2 confirmed.
- Preserve all existing behavior for `claude_local` jobs — this ticket is a pure refactor with the same observable behavior. Existing `claude_local` E2E pins this.

**Files**:
- Refactor: `packages/runner/src/spawn.ts` → split into dispatcher + adapter file
- New: `packages/runner/src/adapters/claude.ts` (extracted)
- New: `packages/runner/src/adapters/index.ts` (registry export)
- Edit: `packages/runner/src/main.ts:21` import + line 21 callsite
- Edit: `packages/runner/src/__tests__/spawn-pure.test.ts` to test dispatch table
- New: `packages/runner/src/__tests__/dispatcher.test.ts` — unit-test the registry, missing-handler error path

**Council before merge**: YES. This is the keystone refactor; everything downstream depends on getting the abstraction shape right. Any change to the handler interface after this lands is expensive.

**QA**:
- Existing claude_local jobs continue to run identically (pin via existing E2E)
- Job with unknown adapter_type produces a clear "no handler for `foo_local`" error in `runner_jobs.error_message`, NOT a crash
- Unit test asserts `ADAPTER_HANDLERS.claude_local` exists; assert dispatcher routes correctly

---

### Ticket S7.2 — Introduce `executionTransport` signal + reverse `byo_runner` collapse

**PM intent**: Council R1+R2 confirmed (both models, P1): naively reversing `byo_runner` at `onboarding-bootstrap.ts:307` breaks UI gating at `ui/src/pages/Agents.tsx:212` (`a.adapterType === "byo_runner"`) and `server/src/lib/byo-runner-flag.ts` semantics. **Multiple code paths today gate on the literal string `"byo_runner"`; flipping the column value silently changes behavior in places nobody reviewed.** The fix is to introduce a separate `executionTransport` (or `requiresLocalRunner`) signal that captures "this agent runs via the BYO runner queue mechanism" — orthogonal to which CLI it spawns. THEN reverse the adapter_type collapse safely.

**Engineering — split into 3 ordered sub-steps (do not interleave)**:

**S7.2.a — Introduce `executionTransport` field (does not change behavior yet)**:
- Add column `agents.execution_transport TEXT NOT NULL DEFAULT 'local-runner'` with CHECK constraint values `('local-runner' | 'server-spawn')` (or whatever 2-value enum captures the existing distinction). Same migration also adds `runner_jobs.execution_transport` (denormalized for fast filter).
- Backfill: every existing agent gets `execution_transport='local-runner'` since BYO_RUNNER is the universal prod flag today.
- Add helper `agent.requiresLocalRunner()` that reads the new column. **Use this everywhere `adapter_type === 'byo_runner'` is currently checked.** Migrate callsites:
  - `ui/src/pages/Agents.tsx:212` — replace literal check
  - `server/src/lib/byo-runner-flag.ts` — semantics review; the env var still gates whether new rows default to `execution_transport='local-runner'`, not the adapter type
  - `server/src/services/adapter-resolver.ts` — branch on `executionTransport`, not adapter_type, when deciding whether to enqueue into runner_jobs vs invoke server-side adapter
  - Any other grep hit on `"byo_runner"` literal across server/ ui/ packages/
- Tests: each migrated callsite gets a regression test that asserts behavior is unchanged for existing prod data shape.

**S7.2.b — Reverse the onboarding-bootstrap.ts:307 collapse (now safe)**:
- Replace:
  ```ts
  const adapterType = isByoRunnerEnabled() ? "byo_runner" : "claude_local";
  ```
  with:
  ```ts
  // adapter_type now reflects the user's actual CLI choice.
  // execution_transport (set separately below) captures the queue-vs-server-spawn distinction.
  const adapterType = mapOnboardingChoiceToAdapter(input.adapterChoice);
  const executionTransport = isByoRunnerEnabled() ? "local-runner" : "server-spawn";
  ```
- New onboarding writes both fields. Legacy `byo_runner` value retained as deprecated; agents with that value continue to run via dispatcher's legacy-fallback path (routes to claude handler).

**S7.2.c — Mark `byo_runner` adapter type deprecated**:
- Update agent schema docstring + `AGENT_ADAPTER_TYPES` comment: "`byo_runner` is deprecated as of S7. New agents must specify a real CLI adapter type and `execution_transport`. Retained for backward compatibility with pre-S7 prod rows."
- ADR `docs/adr/014-execution-transport-vs-adapter-type.md` documents the split + migration rationale.

**Files**:
- New migration: `packages/db/src/migrations/0106_execution_transport.sql` (column + backfill + CHECK)
- New: `packages/db/src/migrations/meta/0106_snapshot.json`
- Edit: `packages/db/src/schema/agents.ts` (add column)
- Edit: `packages/db/src/schema/runner.ts` (denormalize column)
- Edit: `ui/src/pages/Agents.tsx:212` (use `agent.executionTransport`)
- Edit: `server/src/lib/byo-runner-flag.ts` (semantics)
- Edit: `server/src/services/adapter-resolver.ts` (branch on execution_transport)
- Edit: `server/src/services/onboarding-bootstrap.ts:307` (the actual reversal)
- New: `docs/adr/014-execution-transport-vs-adapter-type.md`
- Tests: regression coverage for every migrated callsite

**Council before merge**: ✅ already done (this is the council-revised version of S7.2). No second council pass needed unless implementation diverges.

**QA**:
- New onboarding with `adapterChoice: "claude_local"` produces agents with `adapter_type='claude_local'` AND `execution_transport='local-runner'`
- Existing prod agents (with `adapter_type='byo_runner'`) continue to run correctly — backfill set their `execution_transport='local-runner'` and dispatcher's legacy-fallback handles the deprecated adapter_type
- `ui/src/pages/Agents.tsx` UI badge that previously read "BYO Runner" still appears for migrated agents (because `execution_transport='local-runner'`, not because adapter_type matches a literal)
- `FOUNDEROS_BYO_RUNNER_ENABLED=0` (test path) → new agents get `execution_transport='server-spawn'`; runner_jobs queue is bypassed for them

---

### Ticket S7.3 — Wire `gemini_local` adapter

**PM intent**: First non-Claude CLI ships. Builds on S7.1's dispatcher and consumes `packages/adapters/gemini-local/`.

**Council R1 found** (Gemini P2): the existing `packages/adapters/gemini-local/src/index.ts:31` documents that **Paperclip auto-injects local skills into `~/.gemini/skills/` via symlinks**. Without this pre-spawn step, Gemini agents launch with no tools (no bash, read, edit) and fail immediately. The expanded S7.1 interface includes `setupEnvironment()` precisely so this kind of pre-spawn work has a home — this ticket exercises it for Gemini.

**Engineering**:
- Create `packages/runner/src/adapters/gemini.ts` exporting `geminiHandler: AdapterSpawnHandler` per the expanded interface from S7.1
- Implement:
  - `binary: "gemini"`
  - `setupEnvironment`: invoke the skill-injection logic from `packages/adapters/gemini-local/src/index.ts` to symlink local skills into `~/.gemini/skills/`. Return env additions (`GEMINI_CLI_TRUST_WORKSPACE=true` per vinamr-invariants if the host config opts in). Returned `cleanup()` removes the symlinks on exit so we don't pollute the founder's gemini config across runs.
  - `buildArgs`: pin a stable invocation. **Per vinamr-invariants, do NOT pass Codex-style `-a`/`-s` flags (those are Codex-specific and unrelated to Gemini, but worth flagging — Gemini has its own `--skip-trust` flag for workspace-trust bypass).** Use stream-json output mode if Gemini supports it; else default-text + line parsing.
  - `promptTransport: "positional-arg"` — Gemini takes the prompt as a positional arg, NOT via stdin (this was a council-found mismatch with the original interface).
  - `parseStreamLine`: parse Gemini's stream-json shape (different from Claude's; verify against `gemini --help` output and a real install + capture fixture).
  - `extractFinalResult`: extract sessionId if Gemini exposes one; cost may be null (free tier) — handle gracefully.
  - `interpretExitCode`: detect exit code 55 ("not running in a trusted directory") and emit clear error: "Gemini CLI requires `GEMINI_CLI_TRUST_WORKSPACE=true` or `--skip-trust`. Set this on the runner host."
  - `readVersion`: best-effort `gemini --version` for `runner_jobs.cli_version` audit.
- Register in `packages/runner/src/adapters/index.ts:ADAPTER_HANDLERS.gemini_local`.
- Add unit test using a fixture stream-json log captured from a real Gemini run (no live spawn in unit tests).
- Add skill-injection unit test asserting that `setupEnvironment()` creates the expected symlinks AND `cleanup()` removes them. The runner currently doesn't do skill injection at all (only claude needed it via tempfile), so this is the first adapter that exercises the new lifecycle hook.

**Files**:
- New: `packages/runner/src/adapters/gemini.ts`
- Edit: `packages/runner/src/adapters/index.ts` (add to registry)
- New: `packages/runner/src/__tests__/adapters/gemini.test.ts`
- New: `packages/runner/src/__tests__/fixtures/gemini-stream-json.txt` (captured fixture)
- New: `packages/runner/src/__tests__/adapters/gemini-skills-symlink.test.ts` (skill injection round-trip)

**QA**:
- A real `gemini` binary on the test host produces a non-zero `runner_jobs.events` count for a known-good prompt
- Workspace-trust error case produces a clear error message in the agent's run_log
- After agent run, `~/.gemini/skills/` is restored to its pre-run state (no leaked symlinks)
- Manual install: `npm install -g @google/generative-ai-cli`, `export GEMINI_API_KEY=...`, run an agent → success
- Smoke runbook (`docs/runbooks/multi-cli-smoke.md`) updated with Gemini-specific install + run steps

---

### Ticket S7.4 — Onboarding UI: surface Claude + Gemini choices

**PM intent**: Today the onboarding step lists multiple CLI options but they all silently fall back to claude. Now the UI honestly surfaces the 2 supported choices with friction-honest copy.

**Engineering**:
- Edit the onboarding adapter-choice screen (location: `ui/src/pages/onboarding/*` or per-step component) to render only Claude + Gemini.
- Per-CLI helper text:
  - Claude Code: "Requires Claude Pro ($20/mo) or Max ($100/mo). Most popular."
  - Gemini CLI: "Free tier available. `npm install -g @google/generative-ai-cli`. Set `GEMINI_API_KEY` or trust workspace."
- Other 4 (Codex, Cursor, OpenCode, Pi) and Hermes hidden behind a feature flag `FOUNDEROS_MULTICLI_BETA=1` until S7.B/C/D ship.
- Update `ui/src/adapters/adapter-display-registry.ts` if any copy needs change.

**Files**:
- Edit: `ui/src/pages/onboarding/*` (adapter-choice step component)
- Edit: `ui/src/adapters/adapter-display-registry.ts`
- Tests: `ui/src/pages/onboarding/__tests__/*` if onboarding has component tests

**QA**:
- Founder onboards picking "Gemini" → agent rows have adapter_type="gemini_local"
- Cypress/Playwright e2e for the choice → agent.adapter_type assertion

---

### Ticket S7.5 — E2E for Claude + Gemini

**PM intent**: CI guard. If a future change breaks Claude OR Gemini end-to-end, CI catches it before merge.

**Engineering**:
- Extend `e2e/tests/critical-flows.spec.ts` (or create `multi-cli.spec.ts`) with two paths:
  - Path A (Claude): existing flow, pin
  - Path B (Gemini): same flow, adapter_type=gemini_local — but mocked at the runner spawn layer (don't require Gemini binary in CI; assert the dispatcher routes correctly + the handler emits the expected events from a fixture)
- Stress: do NOT spawn real CLI binaries in CI. Use the fixture-based test pattern from S7.3.
- Add a separate manual smoke test runbook at `docs/runbooks/multi-cli-smoke.md` that an operator runs against real binaries before each S7 ticket merges.

**Files**:
- Edit/New: `e2e/tests/critical-flows.spec.ts` (or new `multi-cli.spec.ts`)
- New: `docs/runbooks/multi-cli-smoke.md`

**QA**:
- CI catches a regression where dispatcher routes gemini_local to claude (test the negative)
- Manual smoke runbook completes for Claude + Gemini before tag

---

### S7.B — Add 4 more CLIs (week 2, parallelizable)

These four can run in parallel pairs (max 2 concurrent agents per worktree caveat in vinamr-invariants).

---

### Ticket S7.6 — Wire `codex_local` adapter

**PM intent**: OpenAI Codex CLI runs. Same shape as Gemini ticket but Codex-specific spawn args + sandbox semantics.

**Engineering**:
- Create `packages/runner/src/adapters/codex.ts`. Mirror gemini handler shape.
- **Pin invocation per vinamr-invariants**: do NOT pass `-a` (approval policy) or `-s` (sandbox) flags. Codex exits code 2 "unexpected argument '-a'" if you do. Use only the prompt + model selection.
- Stream-json shape: capture a real fixture from a current Codex install; parse accordingly.
- Auth: Codex uses OpenAI's auth; emit clear error on missing/invalid key.

**Files**:
- New: `packages/runner/src/adapters/codex.ts`
- Edit: `packages/runner/src/adapters/index.ts`
- New: tests + fixture

**QA**:
- Real Codex install runs an agent end-to-end
- Sandbox-flag passthrough is rejected; no silent flag injection

---

### Ticket S7.7 — Wire `cursor_local` adapter

**PM intent**: Cursor CLI runs. Cursor-specific because the package already has a `server/execute.ts` (saw it during scoping) — investigate whether to reuse vs re-implement at the runner layer.

**Engineering**:
- Read `packages/adapters/cursor-local/src/server/execute.ts` and `packages/adapters/cursor-local/src/server/parse.ts` first — these may already encapsulate the spawn + parse contract. If so, the runner adapter is a thin wrapper.
- Create `packages/runner/src/adapters/cursor.ts` calling into the cursor-local package's existing helpers.
- Auth: Cursor requires a Cursor account; emit clear error if not logged in.

**Files**:
- New: `packages/runner/src/adapters/cursor.ts`
- Edit: `packages/runner/src/adapters/index.ts`
- Tests + fixture

**QA**:
- Cursor agent runs end-to-end
- Not-logged-in case produces actionable error

---

### Ticket S7.8 — Wire `opencode_local` adapter

**PM intent**: OpenCode CLI runs. Adapter package exists; wire it.

**Engineering**:
- Same shape as gemini.ts. Read `packages/adapters/opencode-local/src/index.ts` for any pre-existing helpers.
- OpenCode auth: TBD per current docs; capture in fixture.

**Files**:
- New: `packages/runner/src/adapters/opencode.ts`
- Edit: `packages/runner/src/adapters/index.ts`
- Tests + fixture

**QA**:
- OpenCode agent runs end-to-end

---

### Ticket S7.9 — Wire `pi_local` adapter

**PM intent**: Pi CLI runs. Adapter package exists; wire it.

**Engineering**:
- Same shape as gemini.ts. Read `packages/adapters/pi-local/src/index.ts` for pre-existing helpers.
- Pi auth model: capture in fixture.

**Files**:
- New: `packages/runner/src/adapters/pi.ts`
- Edit: `packages/runner/src/adapters/index.ts`
- Tests + fixture

**QA**:
- Pi agent runs end-to-end

---

### S7.C — Hermes follow-through (CONTINGENT on S7.0.3 outcome)

**Council R1+R2 confirmed (both models, P1)**: original S7.10 (create `packages/adapters/hermes-local/` from scratch) was wrong end-to-end. Reality found in repo:
- `server/package.json` (~line 72) already has `hermes-paperclip-adapter` as a direct dependency
- `server/src/adapters/registry.ts:184` already registers `type: "hermes_local"` from that package
- `packages/adapter-utils/src/session-compaction.ts:80-85` already maps `hermes_local` with `nativeContextManagement: "confirmed"` (deliberate enrollment, not aspirational)
- `AGENTS.md:168` mandates: "core has NO `hermes-paperclip-adapter` dependency and NO built-in `hermes_local` registration. Install Hermes via the Adapter Plugin manager"

**S7.C content depends on the S7.0.3 decision**:
- **If S7.0.3 picks Option A (keep paperclip dependency)**: S7.C is empty — Hermes already works. Update CLAUDE.md gotchas + AGENTS.md to reflect reality. No tickets here.
- **If S7.0.3 picks Option B (strip and externalize per AGENTS.md)**: S7.C contains a single ticket S7.15 (below).
- **If S7.0.3 picks Option C (defer)**: S7.C is empty for this sprint. Add `Hermes plugin path` to S8 backlog.

---

### Ticket S7.15 — Strip built-in Hermes registration + wire via Adapter Plugin manager (CONTINGENT — only if S7.0.3=B)

**PM intent**: Per AGENTS.md mandate, remove `hermes-paperclip-adapter` from core dependencies and route Hermes-using agents through the Adapter Plugin manager.

**Engineering**:
- Remove `hermes-paperclip-adapter` from `server/package.json`. Run `pnpm install` to update lockfile.
- Remove built-in registration block at `server/src/adapters/registry.ts:184`.
- Route `adapter_type='hermes_local'` through whatever Adapter Plugin manager surface AGENTS.md describes. (Read AGENTS.md to find the canonical path; if the plugin manager surface doesn't exist yet, this ticket grows to "build the plugin manager surface first" — confirm scope with founder before merge.)
- Migration: any prod agent rows with `adapter_type='hermes_local'` need to be paired with a plugin install OR have their adapter_type changed.
- E2E: a Hermes agent run before + after the swap produces equivalent results.

**Files**:
- Edit: `server/package.json` (remove dependency)
- Edit: `pnpm-lock.yaml` (regenerate)
- Edit: `server/src/adapters/registry.ts:184` (remove block)
- Likely new: plugin-manager wiring surface (scope TBD)
- New ADR: `docs/adr/015-hermes-as-plugin.md` if it's a non-trivial architecture move

**Council before merge**: YES — anything that touches the plugin-manager surface or removes a server-package dependency needs a fresh council pass.

**QA**:
- `pnpm install` clean post-strip
- An agent with `adapter_type='hermes_local'` and the Hermes plugin installed → runs end-to-end
- Same agent without the plugin → clear "Hermes plugin not installed" error in run_log

---

### S7.D — Polish (week 3 second half)

---

### Ticket S7.12 — Onboarding UI: surface all 7 CLIs + per-CLI friction copy

**PM intent**: After S7.A through S7.C ship, expose the full menu to founders.

**Engineering**:
- Remove the `FOUNDEROS_MULTICLI_BETA` gate from S7.4
- Show all 7 CLIs with friction-honest copy:
  - Claude Code — "$20/mo Pro · most popular"
  - Gemini CLI — "free tier · India-friendly"
  - Codex CLI — "ChatGPT Plus required"
  - Cursor CLI — "Cursor account required"
  - OpenCode CLI — "[research-driven]"
  - Pi CLI — "[research-driven]"
  - Hermes CLI — "[research-driven · may be unavailable]"
- Add a "Help me choose" link → modal that asks 2 questions (which AI subscription do you have? what's your install comfort?) and recommends one CLI.

**Files**:
- Edit: `ui/src/pages/onboarding/*` (adapter-choice component)
- New (optional): `ui/src/pages/onboarding/CLIChooserHelp.tsx`

**QA**:
- All 7 choices render
- Each maps to the correct adapter_type
- "Help me choose" produces a deterministic recommendation

---

### Ticket S7.13 — Agent settings: post-onboarding CLI swap

**PM intent**: A user starts on Claude, then later wants to switch to Gemini for a specific agent (cost, perf, preference). Today there's no UI for this.

**Engineering**:
- Add per-agent `adapter_type` editor in agent-settings page.
- PATCH endpoint `PATCH /api/agents/:id/adapter` (admin-only or owner-only — confirm RBAC in code review).
- Optionally show a "your last 5 runs would have cost $X on Gemini" delta for users with cost data — DEFER if it adds scope.

**Files**:
- New endpoint: `server/src/routes/agents-adapter.ts` (or extension of existing agents route)
- Edit: `ui/src/pages/AgentSettings.tsx` (or whatever the agent settings surface is)
- Tests: enforce RBAC, audit log entry

**QA**:
- Agent's adapter_type can be changed by owner; not by lower-permission roles
- Audit log records the change
- Subsequent runner jobs use the new adapter_type

---

### Ticket S7.14 — Smoke tests + Claude-only gate removal

**PM intent**: Gate-removal is the literal "we are no longer Claude-only" milestone. Smoke tests for the 4 added adapters give CI confidence.

**Engineering**:
- Add fixture-based smoke tests for codex/cursor/opencode/pi/hermes adapters (mirror S7.5 pattern)
- Remove any "Claude only" copy from marketing/onboarding pages
- Update `docs/ops/design-partner-onboarding-kit.md` to mention multi-CLI support
- Update CLAUDE.md gotchas section: "BYO Runner adapter is no longer Claude-only as of S7"

**Files**:
- Edit: `e2e/tests/multi-cli.spec.ts` (or wherever S7.5 lives)
- Edit: `docs/ops/design-partner-onboarding-kit.md`
- Edit: `CLAUDE.md` (the BYO Runner gotcha entry)

**QA**:
- All 7 fixture-based smoke tests green in CI
- Manual smoke runbook (`docs/runbooks/multi-cli-smoke.md`) executes clean for at least 2 real CLIs (Claude + Gemini)
- No "Claude only" copy remains in onboarding/marketing surfaces

---

## Phase exit criteria

Sprint 7 is done when:

1. ✅ Council PASS verdict — **already done 2026-05-07** (R1+R2, FULL, PASS WITH CONDITIONS); revisions applied to this plan in place
2. ✅ S7.0 prerequisites all merged: `runner_jobs.adapter_type` column live, onboarding API/UI accepts all CLI choices, Hermes policy ADR written, Cursor type name normalized
3. ✅ Claude + Gemini both run end-to-end against real CLI installs (manual smoke runbook completed)
4. ✅ All applicable tickets merged or explicitly deferred with rationale (note: S7.15 is contingent on S7.0.3 outcome — may not exist)
5. ✅ `e2e/tests/multi-cli.spec.ts` green in CI (fixture-based)
6. ✅ Onboarding UI shows the 7 CLI choices with no "Claude only" copy remaining (or 6 + Hermes-via-plugin if S7.0.3=B)
7. ✅ At least 1 design partner has run an agent on a non-Claude CLI in production (telemetry confirmation)
8. ✅ ADR `014-execution-transport-vs-adapter-type.md` exists documenting the S7.2 split

## Out of scope (defer to S8 or later)

- **Hosted runner pool** — eliminating the BYO requirement entirely. That's a separate architecture: containers per CLI, license/billing model for hosted inference, vault for user keys. Don't build this in S7 — let it land if/when 50+ paying users justify the inference cost.
- **Per-CLI cost normalization** — converting Gemini/Codex token counts to dollar estimates at runtime. Defer to Finance dept work in S5.
- **Auto-detection** of which CLI is installed on the runner host. Manual selection in S7.13 is sufficient for design-partner phase.
- **Multi-CLI within one agent** ("CoS uses Claude, Growth uses Gemini") — already covered by S7.13's per-agent adapter setting; no separate work needed.

---

## Council results (R1+R2 completed 2026-05-07)

**Verdict**: PASS WITH CONDITIONS · **Mode**: FULL · **Rounds**: 2

**Models**: Codex `gpt-5.4` HEALTHY · Gemini `gemini-3.1-pro-preview` HEALTHY (no fallbacks)

**4 P1s confirmed by both models** (all addressed in revised plan above):
1. `runner_jobs.adapter_type` column doesn't exist today — dispatcher had nothing to dispatch on. **Resolved by S7.0.1**.
2. byo_runner reversal would break UI gating + adapter-resolver routing — multiple code paths gate on the literal string. **Resolved by S7.2 rewrite (executionTransport signal)**.
3. AdapterSpawnHandler interface omitted real lifecycle (instructions tempfile, prompt transport variance, skill injection, SIGTERM/SIGKILL). **Resolved by S7.1 interface expansion**.
4. Hermes plan was wrong end-to-end — `hermes-paperclip-adapter` already a server dependency; AGENTS.md mandates external plugin manager. **Resolved by S7.10/S7.11 deletion + S7.0.3 (decide policy) + contingent S7.15**.

**3 P2s** (all addressed):
- Onboarding API/UI schemas only allowed claude/anthropic/skip → S7.0.2 extends both
- Cursor adapter package exports `"cursor"` not `"cursor_local"` → S7.0.4 normalizes
- Skill injection pre-spawn step missing → S7.3 revised + S7.1 setupEnvironment hook

**Decision logged**: `~/.gstack/projects/bajajvinamr-founderos/decisions.md` 2026-05-07 (90-day expiry, scope: phase-only)

**R3 not warranted** — R2 was clean convergence; both models agreed on each peer's R1 findings; the 2 R2-net-new findings (Codex schema audit + Gemini built-in-Hermes registration) are direct verifications of R1 P1s, not new architectural surface.

---

_Detailed plan created 2026-05-07. Council R1+R2 completed same day with PASS WITH CONDITIONS verdict; all findings applied above. Phase entry in `.planning/ROADMAP.md`. **Ready to begin S7.0 prerequisites.**_
