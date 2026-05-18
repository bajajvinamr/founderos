# COUNCIL — Adversarial review of `GOAL-99-percent-e2e-coverage.md`

_Run 2026-05-18. Critique-only. No code changes. Reviewer: Claude (Opus 4.7) acting as solo council under degraded-mode (Multi-CLI not invoked for this pass; flag explicitly)._

> **Headline verdict:** The goal correctly identifies the failure class (well-mocked unit pyramids hide real bugs) and the precedent (runner SIGKILL E2E catch) is strong. But the **target numbers are wrong, the exemption policy has at least one large loophole, the CI duration math is hand-wavy, and three of the thirteen items are scope-creep dressed as rigor.** Ship with re-scoping on G2 (thresholds), G6 (per-adapter mode), G12 (effort), plus three ADDs (mutation testing, contract-tests-first inversion, security-flow Playwright). Do not flip CI gates until G3+G4+G6 are independently green for a sprint.
>
> Degraded-mode notice: This is solo critique. Run `/council` with Gemini + Codex on this critique BEFORE acting on it — the cost of being wrong about test infrastructure is two weeks of false-positive CI failures.

---

## 1. Is 99/95/100 the right bar?

**Verdict: RE-SCOPE.**

Industry norm is 80% for a reason — the marginal cost of bug-found-per-test-written is convex. The first 80% catches the obvious. The 80→95% band catches the genuinely-useful edge cases. The 95→99% band catches mostly the embarrassing-but-rare. The 99→100% band catches mostly your own test code.

What concretely fails at 80% that 99% catches in this codebase, based on the actual bug ledger in CLAUDE.md + vinamr-invariants.staging.md:
- The SIGKILL bug (line `!child.killed` guard) — would be caught at 80% **if** the test was an E2E. **Coverage % is not the discriminator here; the unit-vs-E2E layer is.** A 99% unit-coverage suite would still have missed this.
- The "if (!result) return" wizard gate (line 454 OnboardingWizard.tsx) — branch coverage catches the missing-discriminator branch, but only if the test asserts on the `status === "fail"` payload. Coverage % alone does not enforce the assertion.
- Drizzle chained `.where()` silently replacing — this is a *contract* bug between Drizzle versions, not a coverage bug. 100% coverage on a wrong call pattern is still wrong.

What concretely fails at 99% that 100% would catch: nothing real. 100% coverage is achieved by either deleting unreachable code (good) or adding tests for impossible branches (bad — wastes time and degrades the suite by training operators to write assertion-free tests just to hit the line). Goal correctly sets branch ceiling at 95% for this reason but inconsistently demands line 99%.

**Concrete change-request:**
- Change line threshold to **90% default**, **95% for `server/src/middleware/`, `server/src/auth/`, `packages/runner/`, `packages/adapters/*/src/server/execute.ts`** (the security/safety hot paths), **80% for `ui/src/components/`** (animation/render code where 99% means snapshot-trap tests).
- Change branch threshold to **80% default**, **90% for auth/billing/runner**.
- Keep "100% critical-flow Playwright" — that one IS the discriminator, because flow coverage measures call-chain breadth, not line coverage.
- Reframe goal title from "99% coverage" to "100% E2E flow coverage + per-tier coverage floors." The 99 number is a vanity metric; the flow grid is the actual safety property.

---

## 2. Does the exemption policy have loopholes?

**Verdict: BLOCK on current policy. Two material loopholes.**

Going exemption-by-exemption:

1. **"Pure-type files (≤5 runtime statements)"** — Loophole: a malicious test-writer (or a tired one) can refactor a 200-line module into "pure type re-exports + the real code in a sibling file" and tag the re-export as a pure-type file. The 5-statement threshold is too loose — most type files are 0 runtime statements, so set the limit at **0 runtime statements AND zero `export const` / `export function`**. Anything that exports a runtime value belongs in the denominator.

2. **"Generated code: Drizzle migration `.sql`, OpenAPI clients, configs, `*.d.ts`"** — Mostly fine. But `vite.config.ts` and `eslint.config.ts` are NOT generated; they're hand-written and CAN contain bugs (plugin registration, alias resolution). Exempting them is wrong. Specifically: `packages/db/drizzle.config.ts`, `server/vitest.config.ts` setup hooks, `ui/vite.config.ts` plugin chain — all hand-authored, all bug-prone. Exempt only true generated output (`.d.ts` from `tsc`, `migrations/*.sql` from drizzle-kit). Hand-written configs go in the denominator with a per-file justification if untestable.

3. **"Bootstrap scaffolds: `packages/plugins/create-founderos-plugin/`"** — Materially OK but specify: the scaffold's *runner* (the code that copies templates and substitutes variables) must be tested at 90%+. Only the templates themselves are exempt. Right now the policy reads as "the entire package is exempt" which is wrong if the scaffold has any string interpolation, file I/O, or arg parsing.

4. **"Plugin examples (`packages/plugins/examples/*`): demonstration code for buyers, not production. Required to typecheck; not required to test."** — **MATERIAL LOOPHOLE.** Per `CLAUDE.md`, `plugin-hello-world-example` is also the **test fixture for the plugin SDK lifecycle E2E (G9)**. If examples are exempt from coverage AND they're the lifecycle test fixture, then bugs in the example code mask bugs in the SDK — exactly the unit-vs-E2E inversion this goal is trying to fix. Fix: examples ARE in the denominator at a lower threshold (60%), OR examples are exempt but the SDK lifecycle test must use a non-example fixture authored specifically for testing.

5. **"`index.ts` re-export-only files (≤10 lines, no runtime logic)"** — Loophole: 10 lines is too generous. The exact pattern that breaks is `index.ts` files that do `export * from "./foo"; export { bar } from "./bar"` — these compile to runtime re-exports and CAN have ordering bugs (TDZ on circular imports). Tighten to **≤5 lines AND zero non-`export` statements**. And add a CI lint that fails if an `index.ts` claimed as a re-export-only contains any `if`, `try`, function bodies, or non-trivial expressions.

6. **"Build artifacts under any `dist/`, `coverage/`, `.claude/worktrees/`"** — Fine but add `tests/__fixtures__/`, `**/test-data/`, `**/*.test.ts.snap` (Vitest snapshots). These should never be in coverage.

**Concrete change-request:** rewrite the exemption section in G2 with the tightened thresholds above + add a lint rule (likely a custom ESLint check or `vitest.config` post-build script) that re-validates each exempt file against the rules quarterly. Otherwise the exemption list rots silently.

---

## 3. Realistic CI duration impact

**Verdict: BLOCK until measured. Numbers are made up.**

The goal asserts ≤20 min P95. CLAUDE.md says current `test+coverage` ~10 min. The goal handwaves the math: "test sharding, Playwright sharded workers, embedded-pg startup cost dropped via per-shard fixture reuse." This is not a plan; it is a wish list.

Honest accounting of the additions:

| Cost | Magnitude | Source |
|---|---|---|
| ~200 new server/UI/adapter E2E tests | unknown — depends on what fraction are embedded-pg, subprocess, fetch-mocked | G3+G4+G6 |
| Embedded-pg startup | 2-5s per *test file*, not per test (per CLAUDE.md). With ~50 new server test files at 5s each = 4 min serial, ~30s with 8-way sharding | G3 |
| Subprocess E2E | bash fake CLI spawn is ~50-100ms per test; cheap | G6 CLI-family |
| Coverage instrumentation overhead | v8 reporter adds 10-30% to test runtime in node; istanbul adds 50-100%. Goal does not specify which | G2 |
| Playwright matrix expansion | Each new flow at full breadth (chromium + 1 viewport) is ~10-30s per flow. The "11+ critical flows" list × 30s = ~5 min worst case | G5 |

Plausible end state: **15-25 min P95**, with the wide range depending entirely on shard count, embedded-pg fixture reuse, and whether Playwright runs sequentially or sharded.

The goal's mitigations are sound in direction but missing the actual numbers. Specifically: "per-shard fixture reuse" for embedded-pg is a known-hard pattern — embedded-pg state must be reset between tests, and the reset cost (DROP DATABASE + CREATE DATABASE or TRUNCATE all tables) is itself 200-500ms. If you don't measure this before G3 starts, you commit to a strategy that may not work.

**Concrete change-request:**
- Add **G0 (new, before G1): "Measure CI duration with `--coverage` added to the existing 400-test suite, no new tests."** This isolates the instrumentation cost from the new-test cost. If `--coverage` alone pushes existing CI from 10 → 16 min, the 20 min ceiling is effectively gone before any new tests are written.
- Add **G6.5 (new): "Embedded-pg fixture reuse spike."** 2 days to prototype a shared-fixture pattern for embedded-pg (boot once per shard, TRUNCATE between tests, transactional rollback if possible). If the prototype doesn't get setup-per-test below 500ms, the goal's CI ceiling is not achievable and G3 needs a different fixture strategy (postgres in CI service container, not embedded).
- State explicitly: **goal accepts a CI ceiling of 25 min P95**, not 20. If the team really wants 20, the embedded-pg cost has to be designed out, not handwaved.

---

## 4. Does G12 ("bug-mining session") scope-creep?

**Verdict: RE-SCOPE. The 1-week estimate is structurally wrong.**

The runner E2E sprint surfaced 1 bug from 13 tests = ~8% surface rate. Goal extrapolates: ~200 new tests × 8% = ~16 bugs. Reasonable upper bound.

But the goal's effort estimate ("3 days") treats every bug as a quick fix. The actual distribution of "bugs surfaced by E2E that unit tests missed" is, from the runner sprint and general experience:
- **~50% are 1-2 line fixes** (the SIGKILL `!child.killed` guard is this shape). 30 min each. 8 bugs × 30 min = 4 hours.
- **~30% are "the test was misconfigured for the production singleton shape"** (event-ingest test class per CLAUDE.md). These are also small but require understanding two pieces of code at once. 1 hr each. 5 bugs × 1 hr = 5 hours.
- **~15% are "this needs a refactor"** (e.g., the chained `.where()` Drizzle pattern was reproduced in N places; the fix is a codemod). 1-2 days each. 2 bugs × 1.5 days = 3 days.
- **~5% are "this is actually a design flaw, escalate to council"** (the in-flight-handle-to-changed-resource class). 3-5 days each. 1 bug × 4 days = 4 days.

Total realistic: **~9 days**, not 3.

If G12 hits the upper-bound 16-bug case with 3 refactor-class fixes, **the 3-day estimate becomes 4 weeks**, which blows the entire goal's timeline. The goal handwaves this with "each gets a fix or a documented `.skip` test + CLAUDE.md invariant," but `.skip` is not free — every skipped test is a known-bug-shipped-to-production, and the founder's $4k buyer-funded position cannot absorb 16 known-bugs-shipped.

**Concrete change-request:**
- Re-scope G12 effort to **1-3 weeks (range, not point estimate)** with the distribution above explicitly called out.
- Add a **G12 stop-rule**: if the surfaced-bug count exceeds 20, **halt G13 (CI gating) until a separate triage week is scheduled.** Locking in a CI gate while 20+ bugs are skipped means the gate is mis-calibrated from day 1.
- Add a **G12 deliverable**: bug-severity classification grid (small/medium/refactor/escalate) before any fixes start. The goal currently asks for fixes without asking for triage.

---

## 5. One-way doors not flagged

**Verdict: BLOCK — at least four additional one-way doors exist; the goal flags three.**

Additional one-way doors:

1. **G2-without-G3-done CI gap.** If G2 flips on `coverage:strict` thresholds at 99% line, and G3 (server gap closure) isn't done yet, **every server PR fails CI immediately** because the server's current coverage (per goal: "unmeasured this sprint") is almost certainly <99%. The execution order says G2 blocks G3-G99, but doesn't say "G2 thresholds start at current baseline + ratcheting, not at 99% absolute." This is the classic "set the bar where you are, raise it as you climb" pattern, and the goal silently violates it. **Fix:** G2 must set thresholds at *current measured baseline* (from G1 output) per package, with a separate G13 ratcheting plan that raises them as G3/G4/G6 close gaps. Otherwise CI is red from G2 commit forward.

2. **Test-writer behavior change.** Once "99% line" is a CI gate, the rational test-writer optimizes for `lines hit / minute spent`, not `assertion quality / minute spent`. This is well-documented in the coverage literature — Goodhart's Law applied to test metrics. The risks table acknowledges this ("Coverage-percentage gaming") but the mitigation ("code review enforces") is hopium — code review reliably catches "no assertion" but not "weak assertion" (the `expect(result).toBeDefined()` pattern, the missing-discriminator branch). **Fix:** add G14 (new): **mutation testing on auth/billing/runner** (Stryker or similar). Mutation score is the only metric that can't be gamed by adding assertion-free tests. Without it, the 99% number is a vanity metric and the goal's safety property is unverified.

3. **Tooling lock-in.** Goal says "vitest --coverage (v8 reporter)." V8 coverage is fast but has known gaps: it doesn't track inline ternaries in JSX as separate branches, it under-counts async/await branches, and switching to istanbul later requires re-running the entire baseline. **Fix:** either pin v8 and accept the gaps OR pick istanbul (slower but more accurate) and pay the perf cost up front. The goal must specify which AND document the gap class so future operators know what 99% v8-line-coverage does NOT cover.

4. **Embedded-pg version pin.** Per CLAUDE.md, `@founderos/db` provides `startEmbeddedPostgresTestDatabase`. Once 50+ new tests depend on this fixture's exact API shape, the embedded-pg version (and the wrapper API) becomes load-bearing. Bumping postgres-major in a year (16→17) becomes a multi-day project instead of a config change. **Fix:** explicit ADR on embedded-pg version + a `pnpm test:db-version-canary` script that runs a smoke test on the next pg-major before the team commits to a major-bump. Cheap. Save weeks later.

**Concrete change-request:** add a fourth row to the "One-way doors" table for the test-writer behavior change (+ Stryker mutation testing as the mitigation, deferred to G14). Add inline notes on G2 ("ratchet from baseline, do NOT set to 99% absolute on commit") and on G13 ("v8 vs istanbul decision, ADR required").

---

## 6. Items that should be re-scoped or dropped

**Verdict by item:**

- **G1 — KEEP.** Measure-before-act is correct.
- **G2 — RE-SCOPE.** Thresholds must ratchet from baseline, NOT lock in at 99/95 on commit. See §5.1 above.
- **G3 — KEEP, RE-SCOPE EFFORT.** 1 week for 279 → "99% coverage" on the largest package in the codebase is aggressive. Plausible if "missing route/middleware/service tests" is mostly happy-path; not plausible if it requires real-Postgres E2E (per goal it does). **Real effort: 1.5-2.5 weeks.** Set expectations honestly.
- **G4 — KEEP, RE-SCOPE EFFORT + THRESHOLD.** UI 99% line coverage is the *worst* place to push to 99%, because rendering code is mostly visual — covered by snapshot tests or visual regression, not unit tests. Pushing to 99% will produce a class of "this component renders without crashing" tests with zero assertion value. **Set UI floor at 80% line / 70% branch and rely on Playwright flow coverage for the rest.**
- **G5 — KEEP.** Playwright flow grid is the highest-leverage item in the entire goal; this is where the real safety property lives.
- **G6 — RE-SCOPE.** "All 10 adapters need E2E mirroring spawn-e2e.test.ts" — but per CLAUDE.md, the runner package's `ADAPTER_HANDLERS` registry **explicitly EXCLUDES API-family adapters** (anthropic-api/openai-api/gemini-api). Those run server-side via SDK; they need fake-fetch E2E, not subprocess E2E. The goal says "CLI-family → real subprocess... API-family → real fetch against http.createServer" which is correct in principle, but treats the two families as the same effort. Fake-fetch E2E is ~half the complexity of subprocess E2E. **Split G6 into G6a (CLI-family, 7 packages, 1 week) + G6b (API-family, 3 packages, 3 days).**
- **G7 — KEEP.** CLI subcommand E2E is correctly identified; admin-recovery escape hatch MUST have a regression test (this is the kind of thing that silently breaks and you only find out when production is on fire).
- **G8 — RE-SCOPE OR DROP.** MCP server protocol E2E sounds rigorous but the actual surface is: stdin/stdout pipe, init, list-tools, call-tool. **You can test this with a 200-line harness, not 3 days of work.** Re-scope to 1 day, OR drop entirely if MCP is not a launch-critical surface (per FounderOS positioning at $4k buyer, IDE integrations are nice-to-have).
- **G9 — KEEP.** Plugin lifecycle E2E is the right call — this is what 3rd-party developers will hit first.
- **G10 — KEEP.** Migration round-trip catches the Drizzle journal class from vinamr-invariants. High value, well-scoped.
- **G11 — KEEP AND PROMOTE.** Cross-package contract tests are the **most important item in the entire goal** and they're buried at #11. The Drizzle `.where()` silent replacement, the `RunnerEvent` shape drift, the `AdapterHandler` contract — these are the bugs that the unit pyramid hides because each package mocks the other side. **Move G11 to right after G2, BEFORE G3-G6.** If the contracts are pinned first, the per-package tests don't accidentally encode wrong assumptions about the other side.
- **G12 — RE-SCOPE EFFORT.** See §4. 1-3 weeks, not 3 days.
- **G13 — KEEP, RE-SCOPE GATE.** "Promote from `quarantined` to `required` once stable" needs a definition of "stable." Recommend: **2 consecutive sprints with zero false-positive failures.** Without this, the gate flips when someone decides it's "felt right," and the goal loses its hard-shut-down on regressions.

**Items I'd drop or merge:** None entirely; G8 (MCP) is the only candidate for outright drop. Most items are correctly identified, just badly sized.

---

## 7. Items that are MISSING

**Verdict: ADD four items.**

The goal explicitly defers fuzz/mutation/visual/performance/3rd-party-live testing to "separate goals once 99/95/100 is hit." This is wrong on at least four counts:

1. **ADD: Mutation testing on auth/billing/runner hot paths.** See §5.2. Without it, the 99% coverage number is unverified — a 99%-covered suite that catches 30% of mutants is functionally worse than an 85%-covered suite that catches 80% of mutants. Mutation testing is the ONLY metric that distinguishes "test exists" from "test asserts." Tooling: Stryker for TypeScript. Effort: 3-5 days to wire + 1 day to set baseline. Run nightly, not on every PR (mutation testing is slow). **Should be G14, not a deferred goal.**

2. **ADD: Property-based / fuzz tests on stream-json parser + token entropy + dedup-key generator.** The goal says fuzz testing is deferred. But the **runner's stream-json parser is exactly the kind of byte-level parser that fuzzing catches**, and the synthetic dedup-key contract in event-ingest (per CLAUDE.md: `${channelId}:${ts}`, `synth:${eventName}:${timestamp}:${distinctId}`) is exactly the kind of string-construction that has collision edge cases. fast-check (TypeScript) is cheap to wire. **Should be G15, not deferred.** Effort: 2-3 days for three target parsers.

3. **ADD: Security flows in Playwright critical-flow grid.** The Wave 23A flows in the goal (signup → onboard → first agent wakeup → ...) are happy-path operational. Missing entirely: **negative-path security flows.** Specifically:
   - Cross-org Composio bypass (the bug class fixed in PR #30 — verified at composio-skill-bridge.ts:96-113). A Playwright test that creates Org A and Org B, connects Slack to both, and asserts Org A agents cannot post to Org B Slack.
   - Magic-link single-use enforcement (verified S6.7 at magic_link_tokens). A Playwright test that issues a magic link, consumes it, then asserts a second click returns 410/expired.
   - First-admin race (the orphan admin bug from 2026-05-04). A Playwright test that simulates two concurrent signups and asserts exactly one becomes admin.
   - Runner token plaintext-not-in-DB. An integration test that issues a token, then queries the DB directly and asserts the plaintext doesn't appear in `runner_tokens.token_hash` (only the sha256).
   These are the **highest-impact tests in the goal** because they protect against the exact bug class the buyer would file a P0 on. **Add as G5.5: Security flow Playwright additions. 3-4 days.**

4. **ADD: Accessibility tests via axe-core integration in Playwright.** Not because $4k buyers care about WCAG, but because axe-core surfaces real DOM bugs (missing labels on inputs that break form submission, `aria-disabled` on buttons that look enabled, focus traps in modals). Per Playwright test = 1 axe scan = 5-30s. Wire as a fixture that runs on every page navigation in the existing Playwright suite. **Add as G5.6: axe-core integration. 1 day.**

**Items I'm NOT adding (but the goal could):**
- Visual regression — correctly deferred; design-review skill handles it.
- Performance / load testing — correctly deferred.
- Live 3rd-party integration tests — correctly deferred (cost + flakiness).

---

## Summary table

| # | Verdict | Headline change |
|---|---|---|
| 1. 99/95/100 threshold | RE-SCOPE | 90/80 default, 95/90 for security hot paths, 80/70 for UI. Drop the "99" branding; reframe as flow-coverage-first. |
| 2. Exemption policy | BLOCK | Tighten pure-type to 0 runtime stmts; remove configs from exempt; promote plugin examples to in-denominator or replace lifecycle fixture. |
| 3. CI duration | BLOCK | Add G0 (measure --coverage-only cost) + G6.5 (embedded-pg fixture spike). Accept 25 min P95, not 20. |
| 4. G12 effort | RE-SCOPE | 1-3 weeks range with bug-severity distribution + stop-rule at 20+ bugs. |
| 5. One-way doors | BLOCK | Add 4 more: G2 ratchet-from-baseline, test-writer behavior change, v8-vs-istanbul ADR, embedded-pg version pin. |
| 6. Per-item triage | mixed | Drop G8 (MCP) or shrink to 1 day. Split G6 by adapter family. Promote G11 ahead of G3-G6. Re-scope G3/G4 effort honestly. |
| 7. Missing items | ADD | G14 mutation testing; G15 fuzz on parsers; G5.5 security-flow Playwright; G5.6 axe-core. |

---

## Process recommendations

1. **Do not commit this goal as-is.** Pull it back, apply the re-scoping above, run `/council` with Gemini + Codex on the revised version. Solo critique (this doc) is one perspective; the test-infra commitment is large enough that two more model perspectives are cheap insurance.

2. **G0 (new) must run before any commitment.** Measuring "current CI duration with --coverage added" is a 2-hour task and a hard input to whether the entire goal is feasible at 20 min P95. If --coverage alone takes the suite from 10 → 18 min, the goal needs to be re-scoped to 25 min P95 or to drop coverage-everywhere in favor of coverage-on-changed-files.

3. **Pre-commit verification (you wouldn't claim work is complete without this elsewhere):** every threshold number in the revised goal must be backed by either (a) the measured baseline from G1, or (b) an explicit acknowledgment that it's a target to be revised post-measurement. No more invented percentages.

4. **The root `vitest.config.ts` does not list all packages** — `anthropic-api`, `openai-api`, `pi-local`, `mcp-server`, `templates`, `adapter-utils`, `openclaw-gateway`, `cursor-local`, `gemini-local` are missing from the `projects` array (verified at `/Users/vinamr/Projects/founderos/vitest.config.ts`). G1 baseline will silently miss these packages unless the root config is fixed first. **Flag as G0.5: fix root vitest.config.ts projects array** before running G1 measurements, or the baseline understates the gap.

---

## Honest uncertainty disclosures

- **CI duration projection (§3):** I did not run `vitest --coverage` against the current 400-test suite to measure the actual instrumentation overhead. The 10-30% v8 overhead figure is from the public Vitest benchmarks, not from this codebase. **Real measurement required before locking thresholds.**
- **Bug surface rate extrapolation (§4):** The 8% surface rate is one data point (13 tests, 1 bug, runner package only). The 50/30/15/5 distribution is industry-experience-derived, not measured for FounderOS. Could be wrong by 2x in either direction.
- **Mutation testing effort (§7.1):** Stryker on a 17-package pnpm monorepo has known integration friction. The "3-5 days to wire" estimate assumes no surprises. If pnpm workspaces + vitest + Stryker have a sharp edge (likely), add 3-5 days.
- **G8 drop recommendation (§6):** I'm assuming MCP server is not a $4k-buyer-blocking surface. If the buyer's pitch deck featured "IDE integration via MCP," this is wrong and G8 stays.
- **No Gemini/Codex consensus.** This is solo Opus critique. Treat verdicts as **one strong opinion**, not a council convergence. Real `/council` invocation (with Multi-CLI) recommended before acting on the BLOCK verdicts on §2 and §3.
