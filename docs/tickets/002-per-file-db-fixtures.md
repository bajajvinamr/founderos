# Ticket 002 — Per-file DB fixtures for flaky tests — PARTIAL 2026-04-24

**Milestone:** M1 · **Owner:** Claude · **Created:** 2026-04-23 · **Resolved:** 2026-04-24

## Resolution

On investigation, the three quarantined flakes had distinct root causes, not the shared-PG-data-dir assumption in the original framing:

- **health.test.ts** — module-cache race under vitest fork parallelism. Fixed in `838fe52` (hoisted `vi.mock` + static imports). 3/3 pass in isolation and under full-suite parallel load.
- **agent-instructions-routes.test.ts** — not reproducible after the retro (5/5 in isolation on 2026-04-24). Pure mock-based, no DB contact. Removed from quarantine.
- **workspace-runtime.test.ts** — still flakes ~1/1570 under parallel load. Root cause is shared HTTP services on ephemeral ports, NOT embedded PG. Per-file DB fixtures would not fix this. Tracked as an orthogonal issue in CI-KNOWN-FLAKES.md.

Two of three flakes gone with targeted fixes. Shared-PG refactor was not needed.

## Problem

`pnpm -w run test` under parallel execution fails on 2–3 of 1569 tests per run. The failures are non-deterministic — different test files fail on each run. Root cause documented in `docs/CI-KNOWN-FLAKES.md`: embedded PGlite shares a single data directory across all test files, so table state from one file leaks into others when vitest runs them in parallel workers.

Currently quarantined:
1. `server/src/__tests__/health.test.ts` — `it.skip`'d, module-cache isolation issue.
2. `server/src/__tests__/workspace-runtime.test.ts:1501` — shared HTTP services on ephemeral ports.
3. `server/src/__tests__/agent-instructions-routes.test.ts:162` — discovered during the 2026-04-23 retro run.

Patching with quarantine doesn't scale. Count went 2→3 in one retro cycle; if it hits 5 the suite becomes unreliable for gating deploys.

## Success

- `pnpm -w run test` passes on **5 consecutive runs** (zero failures, zero skips beyond tests genuinely requiring `skip`).
- `docs/CI-KNOWN-FLAKES.md` reduces to **0 entries** attributable to shared-state.
- CI E2E job `e2e-ci.yml` completes without `flaky-tests` warnings across 3 consecutive main pushes.

## Out of scope

- Moving off PGlite to a real container-based test database (e.g., Testcontainers Postgres). That's a bigger decision — track as separate ADR if this ticket reveals PGlite is the wrong primitive.
- Refactoring `workspace-runtime.ts` beyond what's needed to isolate its test harness.

## Edge cases

- CI cache of PGlite binaries — per-file fixtures shouldn't increase cold-CI time >20%.
- Parallel workers exceeding available memory (each fixture = own PGlite instance). Measure before and after; may need `maxWorkers` tuning.
- Flaky tests that re-quarantine themselves after the fix — add a CI check that fails if `docs/CI-KNOWN-FLAKES.md` gains entries.
- Tests that intentionally share setup (e.g., schema migrations run once) — extract to a global setup hook, not per-file.

## Approach

1. Add a `createTestDb()` helper in `server/src/__tests__/helpers/db.ts` that returns a fresh PGlite instance with a unique data dir per call.
2. Migrate the 3 quarantined tests first — verify they pass in isolation AND under parallel load.
3. Re-enable `it.skip`'d tests one at a time.
4. Roll out the helper to any other test file that imports the shared DB singleton.

## Verification

- `for i in 1 2 3 4 5; do pnpm -w run test || exit 1; done` — all 5 runs pass.
- `grep -c "^### " docs/CI-KNOWN-FLAKES.md` returns 0.
- CI time delta: `(old_avg_duration - new_avg_duration) / old_avg_duration` within ±20%.

## Dependencies

- None. Self-contained.

## Rollback

Revert the helper + quarantine the newly-enabled tests with `it.skip` again. Old path works unchanged.
