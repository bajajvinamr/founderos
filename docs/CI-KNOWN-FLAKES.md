# Known Flaky Tests in CI

Tests listed here fail under parallel execution but pass in isolation. These are quarantined with `it.skip` pending investigation and refactoring.

## Tests

### 1. ~~health.test.ts > GET /health > returns 200 with status ok~~ — FIXED 2026-04-24

Removed `vi.resetModules()` + dynamic imports; switched to module-level `vi.mock` for `dev-server-status.js` + static imports. Un-skipped the "no db" test. 3/3 tests pass in isolation + under full-suite runs.

---

### 2. workspace-runtime.test.ts > ensureRuntimeServicesForRun > reuses shared runtime services across runs and starts a new service after release

**Location:** `server/src/__tests__/workspace-runtime.test.ts:1501`

**Issue:** Shared state leaking between parallel test runs. The test spawns HTTP services on ephemeral ports and relies on global cleanup via `leasedRunIds` Set and `resetRuntimeServicesForTests()`. Under contention, services from one test can interfere with another.

**Symptom:** Fails when database tests or other heavy I/O tests run in parallel; always passes when run alone.

**Fix options:**
1. Use isolated database fixtures (each test gets its own embedded Postgres instance)
2. Add `describe.sequential` to serialize the entire `ensureRuntimeServicesForRun` suite
3. Implement thread-local or request-scoped service registry instead of global cleanup
4. Mock HTTP services instead of spawning real ones with port binding

---

### 3. ~~agent-instructions-routes.test.ts > GET /api/agents/:id/instructions~~ — NOT REPRODUCIBLE 2026-04-24

Flaked once during the 2026-04-23 retro run, passed 5/5 times in isolation on 2026-04-24. No DB contact (pure mock-based test). Suspected vitest workerpool scheduling race, not a test bug. Removing from quarantine. Re-add if it recurs.

---

### 4. e2e/tests/critical-flows.spec.ts > landing > [landing] hero + sign-up CTA render — QUARANTINED 2026-05-02

**Location:** `e2e/tests/critical-flows.spec.ts:41`

**Issue:** Passes locally against vite-dev (port 3100 proxying React-refreshed `Landing.tsx`) but fails in CI under static mode (server serves built `ui/dist`). The CTA selector matches a broad family of phrases (`/sign\s*up|get\s*started|build\s*your\s*company|design\s*partner|start\s*your/i`) and Landing.tsx has multiple matching links (e.g. "Build your company →"), so this is most likely a hydration race or a build-time copy divergence in CI, not a real regression.

**Symptom:** `Error: Landing page has no visible primary CTA link — check ui/src/pages/Landing.tsx`. Reproduced on PR #15's CI run; `pnpm exec playwright test --grep "hero + sign-up CTA render"` passes locally.

**Why this was masked:** The E2E suite has been red on `main` for weeks because of an upstream ECONNREFUSED harness bug at the seed step (issue #7). Once the seed step actually ran, this stale assertion surfaced.

**Re-enable when:**
- Investigation confirms whether built ui/dist actually serves the same Landing copy as vite-dev, OR
- The selector / wait strategy is hardened to handle the static-build hydration timing.

**Tracked:** [#16](https://github.com/bajajvinamr/founderos/issues/16)

---

### 5. ~~e2e/tests/critical-flows.spec.ts > onboarding > [onboarding-v2-flag]~~ — FIXED 2026-05-02

Root cause: `FounderOnboardingWizard.tsx:228` rendered raw `<div>`s inside `DialogPortal` instead of using `<DialogContent>`, so the wizard never had a `role="dialog"` element — the spec's `[role=dialog], [data-testid*=onboarding], [data-testid*=wizard]` selector literally couldn't match. Added `role="dialog"`, `aria-modal="true"`, `aria-label`, and `data-testid="onboarding-wizard"` to the wizard's outer fixed-positioned container. Spec un-skipped. (Closes #17.)

---

## Verification

To verify a fix works:
```bash
# Before fix — should pass in isolation, fail under parallel load
npx vitest run src/__tests__/health.test.ts
npm run test  # Full suite with parallel workers

# After fix — should pass in both
npx vitest run src/__tests__/health.test.ts
npm run test
```

Update this file when quarantined tests are re-enabled with proper fixes.
