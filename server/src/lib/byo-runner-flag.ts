/**
 * BYO Runner feature flag — ADR-011 (2026-05-04).
 *
 * Single source of truth for whether the runner architecture is active in
 * this process. Read once per call site (cheap — env access is O(1)).
 *
 * When `false`:
 *   - `byo_runner` adapter is NOT registered in adapters/registry.ts
 *   - `/api/runner/*` routes are NOT mounted (return 404)
 *   - onboarding-bootstrap.ts continues to map adapterChoice → claude_local
 *   - UI Step4Plugin renders the legacy Anthropic-key card
 *
 * When `true`:
 *   - All of the above invert. New signups default to byo_runner.
 *
 * Default OFF — set `FOUNDEROS_BYO_RUNNER_ENABLED=1` to flip on. Documented
 * in env-validation.ts (INFO severity).
 *
 * Don't cache the result at module scope — tests override env per-suite, and
 * the flag is read on cold paths (boot wiring, route mount, onboarding) where
 * the env-read cost is irrelevant.
 */
export function isByoRunnerEnabled(): boolean {
  return process.env.FOUNDEROS_BYO_RUNNER_ENABLED === "1";
}
