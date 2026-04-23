# Ticket 003 — CI file-size gate

**Milestone:** M1 · **Owner:** unassigned · **Created:** 2026-04-23

## Problem

Three files have grown past all reasonable thresholds:
- `server/src/services/heartbeat.ts` — 4866 lines (doubled since wave-18)
- `server/src/services/company-portability.ts` — 4415 lines
- `ui/src/pages/AgentDetail.tsx` — 4134 lines

No gate warns when files cross a threshold, so they grow 1 line at a time until a refactor takes an engineering week. Per the 2026-04-23 forward plan, the stated output standard is "no new file authored >2500 lines, warning at 1500."

## Success

- A CI job `file-size-check` runs on every PR.
- Warns (comments on PR, does not block) when any changed file is **1500–2499 lines**.
- **Fails** when any changed file is **≥2500 lines**.
- The 3 existing offenders are grandfathered via `.github/file-size-allowlist.txt` and each has a linked refactor ticket (004–006, created when this ticket lands).
- Generated artifacts (`packages/shared/dist/**`, `ui/dist/**`), migration SQL, and test fixtures are exempted.

## Out of scope

- Actually refactoring `heartbeat.ts` / `company-portability.ts` / `AgentDetail.tsx`. Each gets its own ticket (004, 005, 006).
- Inline refactor suggestions — the gate just flags; tickets drive the work.

## Edge cases

- Pure rename operations (file moved but unchanged) should not double-count. Use `git diff --numstat` to check additions, not raw line count of renamed file in isolation.
- Generated files — respect `.gitattributes linguist-generated` where set.
- Test fixtures with large JSON (snapshot tests) — glob-exempt via allowlist.
- CI performance: run only on changed files, not the full repo on every push.

## Approach

1. New job in `.github/workflows/ci.yml` named `file-size-check`, depends on `install`.
2. Script at `scripts/ci/file-size-check.ts` — reads changed files from `git diff --name-only origin/main...HEAD`, applies glob allowlist, emits GitHub annotations, exits 1 on hard failure.
3. Update `.github/workflows/README.md` to document the job.
4. Create tickets 004–006 (refactor stubs) so each allowlisted file has an owner.

## Verification

- Open a test PR that adds a 2501-line file → CI fails with a clear message pointing at the file and the 2500-line threshold.
- Open a test PR that adds a 1600-line file → CI passes, but posts a warning comment linking to the file-size gate docs.
- Baseline PR (no changed files over threshold) → CI passes silently, no false positives.
- Existing `heartbeat.ts`-touching PR → CI does not fail (grandfathered).

## Dependencies

- `ci.yml`'s install job provides Node 24 + pnpm (already wired).
- Glob library: `micromatch` (already a transitive dep via vitest) or `minimatch`.

## Rollback

Remove the `file-size-check` job from `ci.yml`. No data/state to revert.
