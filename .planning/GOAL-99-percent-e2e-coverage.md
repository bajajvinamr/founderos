# GOAL — 99% E2E coverage across the FounderOS codebase

_Created 2026-05-18. Owner: Claude. Sub-goal of: "ship FounderOS to a buyer with verified production-grade reliability"._

> **Why this goal exists:** The 2026-05-18 runner E2E sprint shipped 13 tests across two new files (`spawn-e2e.test.ts`, `main-http-e2e.test.ts`) and immediately surfaced a production bug (SIGKILL escalation broken in `spawn.ts:117-119` + `adapters/claude.ts:360-376`) that the existing 99-test unit pyramid had MASKED via `vi.mock("node:child_process")`. The lesson generalizes: **the existing test suite (400 unit/integration tests, 12 Playwright specs) is well-mocked at the unit tier and the result is a class of bugs that only land in production.** This goal closes that gap codebase-wide by ensuring every package has an E2E layer SITTING ON TOP of its existing unit tests, with measurable coverage targets and a clear exemption policy that prevents the percentage from being gamed.

## Definition of "done"

**99% means three concurrent thresholds, all required:**

1. **Line coverage ≥ 99%** on every non-exempt source file across all 17 workspace packages, measured by `vitest --coverage` (v8 reporter) at the package level. Exempt files (see below) are excluded from the denominator.

2. **Branch coverage ≥ 95%** on non-exempt source files. Branch coverage 99% is achievable for trivial functions but rapidly degenerates into testing-impossible-conditions (e.g., `if (someTrueConst)`). 95% is the honest ceiling without resorting to coverage-game artifacts (`/* istanbul ignore next */`).

3. **E2E flow coverage 100%** for every flow on this list (the Wave 23A critical-flows extended): signup → onboard → first agent wakeup → inbox → goal create → integration connect → invoice → settings → CLI runner install → billing gate flip → admin recovery. Every flow has at least one Playwright test in `e2e/` or `tests/e2e/` that exercises the real call chain from browser → server → DB → adapter → back.

**Exempt-from-denominator policy (must be explicit; no silent skipping):**
- Pure-type files (≤5 runtime statements, only `export type` / `export interface` / discriminated-union helpers). Example: `packages/runner/src/handlers/types.ts` (already 0% because it's literally types — counting it punishes the package for being well-typed).
- Generated code: Drizzle migration `.sql` files, OpenAPI-generated clients, Vite/tsconfig/eslint configs, `*.d.ts`.
- Bootstrap scaffolds: `packages/plugins/create-founderos-plugin/` (templates copied verbatim to new projects; covered by the template's own tests, not the scaffold's).
- Plugin examples (`packages/plugins/examples/*`): demonstration code for buyers, not production. Required to typecheck; not required to test.
- `index.ts` re-export-only files (≤10 lines, no runtime logic): coverage measures the re-exported source, not the re-exporter.
- Build artifacts under any `dist/`, `coverage/`, `.claude/worktrees/`.

Every exemption is captured in `vitest.config.ts` `coverage.exclude` per package + listed in `docs/runbooks/test-coverage-policy.md` (created in this goal — see G99).

If any of 1–3 fails, the goal is not done.

---

## Baseline (measured 2026-05-18)

| Package | Existing tests | Current coverage | E2E layer? |
|---|---:|---:|:---:|
| `packages/runner` | 112 (99 unit + 13 E2E) | **74.55%** | ✅ shipped 2026-05-18 |
| `server` | 279 | unmeasured this sprint | partial (`tests/e2e/`) |
| `ui` | 115 | unmeasured this sprint | partial (`e2e/`) |
| `packages/shared` | ~10 | likely high (validators) | N/A (no I/O) |
| `packages/db` | ~5 | unmeasured | needs migration round-trip test |
| `packages/adapters/anthropic-api` | 14 | unmeasured (shipped today) | needs live-fetch-mocked E2E |
| `packages/adapters/openai-api` | unmeasured | unmeasured | needs live-fetch-mocked E2E |
| `packages/adapters/claude-local` | unmeasured | unmeasured | needs subprocess E2E |
| `packages/adapters/gemini-local` | unmeasured | unmeasured | needs subprocess E2E |
| `packages/adapters/codex-local` | unmeasured | unmeasured | needs subprocess E2E |
| `packages/adapters/cursor-local` | unmeasured | unmeasured | needs subprocess E2E |
| `packages/adapters/opencode-local` | unmeasured | unmeasured | needs subprocess E2E |
| `packages/adapters/openclaw-gateway` | unmeasured | unmeasured | needs HTTP-gateway E2E |
| `packages/adapters/pi-local` | unmeasured | unmeasured | needs subprocess E2E |
| `packages/adapters/gemini-api` | unmeasured | unmeasured | needs live-fetch-mocked E2E |
| `cli` | unmeasured | unmeasured | needs CLI subcommand E2E |
| `packages/mcp-server` | unmeasured | unmeasured | needs MCP-protocol E2E |
| `packages/plugins/sdk` | unmeasured | unmeasured | needs plugin-lifecycle E2E |
| `packages/adapter-utils` | unmeasured | unmeasured | unit only (pure helpers) |
| `packages/templates` | unmeasured | unmeasured | template-render E2E |

**Source of truth for current state**: G1 below produces a measured baseline.

---

## Items (priority order)

| # | Item | Effort | Status | Blocks | Blocked by |
|---|---|---:|---|---|---|
| **G1** | **Codebase-wide coverage baseline.** Run `vitest --coverage` per package, aggregate into `docs/runbooks/test-coverage-baseline-2026-05-18.md` (per-file line/branch percentages, current exemptions, gap delta to 99%). One source of truth before any test-writing starts — every subsequent item flows from this. | 2 hr | pending | G2-G99 | — |
| **G2** | **Coverage policy doc + per-package vitest.config.ts.** Write `docs/runbooks/test-coverage-policy.md` capturing the exemption rules + 99/95/100 thresholds above. Add `coverage` block to every package's `vitest.config.ts` with explicit `thresholds.lines: 99` `thresholds.branches: 95` + `exclude` array matching the policy. CI gate from this commit forward fails on regression. | 3 hr | pending | G3-G99 | G1 |
| **G3** | **Server (`server/`) gap closure.** 279 tests already; measure delta to 99%, write missing route/middleware/service tests. Priority surfaces: route handlers (full HTTP cycle), middleware chains (CSRF + auth + billing-gate stacks), background services (heartbeat dispatcher, runner-token rotation, event-ingest singleton). Distinct from unit tier: every test must hit a real Postgres (embedded-pg fixture per `@founderos/db`). | 1 wk | pending | G99 | G1, G2 |
| **G4** | **UI (`ui/`) gap closure.** 115 component tests already; the gap is interactive component coverage — provider chooser tile clicks, wizard step-gate flips, runner banner deep-link auto-open, admin recovery flow. Use React Testing Library for component-level, Playwright for full-page flows. Pin a target of 99% line coverage on `ui/src/components/`, `ui/src/pages/`, `ui/src/hooks/`. | 1 wk | pending | G99 | G1, G2 |
| **G5** | **Playwright E2E flow grid.** Inventory current `e2e/` (Wave 23A critical-flows) + `tests/e2e/` (onboarding/signoff). Map each flow in the "Definition of done" section to its current Playwright spec or write a new one. Wire `FOUNDEROS_E2E_PROFILE=public-only` for prod-safe runs + a `local-full` profile that exercises auth-mutation against embedded-pg. | 4 days | pending | G99 | G1 |
| **G6** | **Adapter package E2E layer (10 packages).** Each adapter under `packages/adapters/*` needs an E2E test mirroring `packages/runner/src/__tests__/spawn-e2e.test.ts` or `main-http-e2e.test.ts`. CLI-family (claude/gemini/codex/cursor/opencode/pi) → real subprocess against bash fake CLI in `/tmp`. API-family (anthropic/openai/gemini-api) → real `fetch` against `http.createServer` mocking the provider endpoint. Gateway-family (openclaw) → both. | 1 wk | pending | G99 | G1, G2 |
| **G7** | **CLI (`cli/`) subcommand E2E.** `cli/src/commands/{auth-bootstrap-ceo, runner-issue-token, ...}` — invoke as real subprocesses via `spawn`, assert on stdout/stderr/exit code. The admin-recovery escape hatch documented in CLAUDE.md (`pnpm founderos auth bootstrap-ceo`) MUST have a regression test. | 3 days | pending | G99 | G1, G2 |
| **G8** | **MCP server (`packages/mcp-server/`) protocol E2E.** Boot the MCP server on a stdin/stdout pipe, drive the MCP wire protocol from a test harness (init → list-tools → call-tool → response). Validates the server is a valid MCP host for IDE integrations. | 3 days | pending | G99 | G1, G2 |
| **G9** | **Plugin SDK (`packages/plugins/sdk/`) lifecycle E2E.** Use one of the existing examples (`plugin-hello-world-example`) as the test fixture: full lifecycle install → activate → tool-invoke → uninstall. Validates the plugin contract as it ships to 3rd-party developers. | 3 days | pending | G99 | G1, G2 |
| **G10** | **DB migration round-trip E2E.** Apply all migrations bottom-up against a fresh embedded-pg, then exercise schema-drift check, then rollback to `migrate.json` head, then re-apply. Catches the migration journal corruption class documented at `vinamr-invariants.staging.md` (Drizzle journal parallel-branch merge bug). | 2 days | pending | G99 | G1, G2 |
| **G11** | **Cross-package contract tests.** Server publishes `RunnerEvent` shape (api.ts); runner consumes it. Server publishes `AdapterHandler` contract (handlers/types.ts); 10 adapters implement it. Add a fixture test in `packages/shared/` that pins these contracts via Zod parsing of representative payloads. Catches the silent producer-consumer drift class documented at `vinamr-invariants.staging.md` (Drizzle chained `.where()` replacement). | 2 days | pending | G99 | G1, G2 |
| **G12** | **Bug-mining session: re-run all E2E suites, file every bug surfaced as a child issue.** The 2026-05-18 sprint surfaced the SIGKILL bug only because E2E primitives exposed what mocks hid. Expect 5-15 similar bugs codebase-wide. Each gets a fix or a documented `.skip` test with a CLAUDE.md invariant entry (precedent: `packages/runner/src/__tests__/spawn-e2e.test.ts` test (h)). | 3 days | pending | G99 | G3-G11 |
| **G13** | **CI gating.** Add `pnpm coverage:strict` script that runs vitest with `--coverage` and fails on threshold regression. Wire into `ci.yml` as a required check. Promote from `quarantined` to `required` once stable. Existing `ci.yml` is functional as of 2026-05-07 (per CLAUDE.md) — this just adds a new check. | 1 day | pending | G99 | G2-G12 |
| **G99** | **Final verification: 99/95/100.** Run the full suite. Confirm `vitest --coverage` reports line ≥99% / branch ≥95% on every non-exempt source file across all packages. Confirm every flow in the "Definition of done" list has a green Playwright spec. Write a closeout retro at `docs/retros/coverage-99-percent-2026-XX-XX.md`. | 1 day | pending | (closes goal) | G1-G13 |

## Execution order (recommended)

```
G1 → G2 → (G5 || G6 || G3 || G4 in parallel) → G7 → G8 → G9 → G10 → G11 → G12 → G13 → G99
```

Rationale:
- **G1 first** — every subsequent item flows from the baseline. No work without measurement.
- **G2 second** — without the policy doc + per-package config, "coverage" is undefined and the team writes inconsistent exemptions.
- **G3 || G4 || G5 || G6 parallelizable** — server, UI, Playwright flows, and adapter packages have no cross-dependencies for test-writing. 4-track sprint if multiple operators; sequential otherwise.
- **G7 → G8 → G9 → G10 → G11** sequential — each touches infrastructure (CLI subprocess harness, MCP wire protocol, plugin lifecycle, DB round-trip, contract fixtures) that the next builds on.
- **G12 last before G13** — bug-mining IS the deliverable; the test sprint is incomplete without surfacing what was hidden.
- **G13 hard-gates merge** — without CI enforcement, the 99% reverts within 2 sprints to ~85% via gradual drift.

## One-way doors in this goal

- **G2 CI threshold flip** — once `coverage:strict` is required, every PR must maintain ≥99% line / ≥95% branch. Roll out gradually: start as `quarantined` on the first 2-3 packages, promote to `required` only once each package has stabilized for one full sprint.
- **G6 adapter E2E layer** — 10 adapter packages × ~200 LoC of new test scaffolding each = ~2K LoC of test infrastructure. Each package needs its own fake-CLI or fake-fetch harness; copy-paste from `packages/runner/src/__tests__/spawn-e2e.test.ts` is fine. `/council` recommended before starting to validate the harness pattern is right for all adapter shapes.
- **G3 server gap closure with embedded-pg** — every new server test boots an embedded-pg instance, which adds ~2-5s per test file. With 50+ new test files, that's 2-5 minutes added to CI. Acceptable if the parallel sharding works (existing CI shards already). Verify before locking in the pattern.

## Out of scope

- **Visual regression testing** — not part of "E2E coverage" in this goal. Separate `design-review` skill handles that.
- **Performance / load testing** — coverage is correctness, not latency. Existing `pnpm ci:bundle-size` covers the SPA-bundle ceiling; backend load testing is a separate goal.
- **Fuzz testing** — would be valuable on the runner's stream-json parser, the Composio v3 client, and the runner-token entropy validator. Defer to a separate goal once 99/95/100 is hit.
- **3rd-party SaaS integration tests** (Supabase real auth, Stripe real webhook delivery, Composio real tool execution) — these require live credentials + cost money. The mocked-fetch E2E layer is the right ceiling; live integration is a separate "release smoke" goal.
- **Coverage on the Vercel legacy redirect** (`vercel.json` 301 only, no runtime logic to cover).
- **Coverage on `.claude/worktrees/` subtrees** — these are agent scratch directories, not production code.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| **Coverage-percentage gaming.** Test-writers add tests that hit lines without asserting behavior (e.g., `expect(true).toBe(true)` inside a try/catch wrapping the real call). | G2 policy doc requires every test file to have a meaningful assertion on EVERY non-trivial branch. Code review enforces. |
| **Flaky E2E tests under CI load.** The 2026-05-18 runner sprint already hit cross-test signal contamination (one test's cleanup affected another's timing). | Each E2E file is hermetic: own tempdir, own HTTP port, own subprocess lifecycle. Use `vitest --no-file-parallelism` for E2E suites if needed. Document any quarantined tests at `docs/CI-KNOWN-FLAKES.md` per the existing pattern. |
| **The SIGKILL bug class** (E2E surfaces real bugs the unit tier hides) repeats codebase-wide and the bug list grows faster than fixes. | G12 explicitly accepts this: bugs become tracked issues with either a fix or a `.skip` test + CLAUDE.md invariant. Goal is not "zero bugs" — it's "surfaced bugs are visible." |
| **99% is the wrong target** — too strict for some packages (UI render-only components), too lax for others (auth/billing-gate). | G2's per-package `vitest.config.ts` allows per-package overrides. Default 99/95; specific packages may set 100/100 (auth) or 95/85 (UI animations). All overrides recorded in the policy doc. |
| **CI duration balloons past acceptable.** 400 → 600+ tests + per-test embedded-pg + Playwright matrix = potential 30+ min CI. | G13 acceptance criterion: full CI ≤20 min P95. Achieve via test sharding (vitest projects), Playwright sharded workers, and dropping the embedded-pg startup cost via per-shard fixture reuse. |

---

## Definition of "E2E" used in this goal

For unambiguous test classification, this goal uses the following layer definition (matching `docs/runbooks/runner-test-strategy.md`):

- **Pure helper** — no I/O, no async, no module-level state. Tests are pure-function unit tests.
- **Adapter unit** — uses fake EventEmitter children or fake fetch. Tests adapter helpers + interface compile-time shapes.
- **Adapter lifecycle** — uses `vi.mock("node:child_process")` synthetic child or fake `fetch`. Tests AsyncGenerator run lifecycle.
- **API client** — fake `fetch` only. Tests HTTP wire format.
- **Loop integration** — stubs the API client + mocks the dispatcher. Tests poll-claim-complete with no real I/O.
- **HTTP E2E** — real `http.createServer` + real `fetch`. Tests Bearer headers on the wire, real JSON body shape, retry-on-5xx behavior.
- **Subprocess E2E** — real `child_process.spawn` against bash fake CLIs in `os.tmpdir()`. Tests spawn orchestration, signal handling, line buffering.
- **DB E2E** — real Postgres (embedded-pg via `@founderos/db` test fixture). Tests transaction semantics, FK cascades, advisory locks, migration round-trips.
- **Browser E2E (Playwright)** — real browser, real server (local or deployed). Tests full call chain from user click to DB row + back to render.

A package is "E2E covered" when at least one test in its `__tests__/` (or `tests/`) uses one of the bottom 4 layers (HTTP / Subprocess / DB / Browser).

---

_Source materials: `.planning/GOAL-onboarding-and-canary.md` (template), `docs/runbooks/runner-test-strategy.md` (the 2026-05-18 runner E2E sprint that motivated this goal), `CLAUDE.md` (project-local invariants flagged during E2E sprint), `~/.claude/rules/vinamr-invariants.staging.md` (the SIGKILL bug class + other test-surface footguns)._
