# Known Flaky Tests in CI

Tests listed here fail under parallel execution but pass in isolation. These are quarantined with `it.skip` pending investigation and refactoring.

## Tests

### 1. health.test.ts > GET /health > returns 200 with status ok

**Location:** `server/src/__tests__/health.test.ts:16`

**Issue:** Module isolation problem in parallel test execution. The test uses `vi.resetModules()` in `beforeEach`, which interacts poorly with vitest's parallel module caching when multiple test files run simultaneously.

**Symptom:** Fails sporadically in full test suite runs (200+ concurrent test files); always passes in isolation.

**Fix options:**
1. Remove `vi.resetModules()` and pre-import modules before test block
2. Use `it.concurrent(false)` or `describe.sequential` to serialize this test
3. Refactor to avoid dynamic imports in favor of proper dependency injection

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

### 3. agent-instructions-routes.test.ts > GET /api/agents/:id/instructions

**Location:** `server/src/__tests__/agent-instructions-routes.test.ts:162`

**Issue:** Route handler returns `{}` (empty body, 200) instead of `{ mode: "managed", rootPath: "/tmp/agent-1", ... }` when tests contend on the embedded-PG data dir. Only observed under full parallel runs — passes in isolation.

**Symptom:** Reported 1 failure on `pnpm -w run test` during 2026-04-23 retro; did not appear in the preceding run (which failed `workspace-runtime` instead). Classic shared-state symptom — different failures per run.

**Fix options:**
1. Isolate the test suite's DB fixture (its own `DATABASE_URL` / fresh PGlite instance per file)
2. Serialize with `describe.sequential` while a proper fix is built
3. Audit `agent-instructions` route's startup-time memoization — it may be caching the first caller's agent row across tests

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
