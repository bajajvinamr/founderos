# S8 P0.1 — Phased Implementation Plan

_Date: 2026-05-10_
_Council R1 verdict: PASS_WITH_CONDITIONS. Phase 1 must land conditions C1-C5 + C7. C6 + C8 by end of Phase 2._

---

## Conventions

- Conventional commits: `feat(s8): ...`, `chore(s8): ...`, `test(s8): ...`. Sprint marker `s8` per ROADMAP §1.
- Branch base: `main` (current HEAD `0483ab1`).
- One PR per agent. Squash-merge into `main`. No agent merges into another agent's branch.
- All PRs require: `ci (all checks)` aggregate green + at least one human reviewer + council verdict link in PR body.
- Council link: PR body must reference `.planning/PHASE-S8-P01/COUNCIL-R1.md` and confirm which conditions are addressed.
- All file paths absolute from repo root.
- TDD: tests written before implementation. Min coverage 80% on changed files.

---

## Phase 1 — Foundation (4 parallel agents)

All four agents start from `main`. No inter-agent dependencies in Phase 1; Phase 2 stitches them together.

### Agent 1A — Dockerfile + fly.toml hardening

**Branch:** `feat/s8-p01-fly-hosted-machine`
**Conditions addressed:** C3, C4
**Files to touch:**
- `/Users/vinamr/Projects/founderos/fly.toml`
- `/Users/vinamr/Projects/founderos/Dockerfile` (verify only — already has claude CLI)
- `/Users/vinamr/Projects/founderos/scripts/docker-entrypoint.sh` (only if needed for workdir bootstrap)

**Changes:**
1. `fly.toml:55` — add `FOUNDEROS_HOSTED_AGENTS_ENABLED = "0"` (default off; flipped post-smoke).
2. `fly.toml:70` — `min_machines_running = 1` (was 0).
3. `fly.toml:104-107` — VM bump:
   - `size = "shared-cpu-2x"` (was 1x)
   - `memory = "2gb"` (was 1gb)
   - `cpus = 2` (was 1)
4. `fly.toml:18-19` — `kill_timeout = "30s"` (was 5s) so in-flight claude jobs get a SIGINT graceful shutdown window. Test: kill a running job mid-stream and confirm it logs "received SIGINT, shutting down" before SIGKILL.
5. `Dockerfile` — verify (no changes if `@anthropic-ai/claude-code` is current). Add per-job workdir parent at line 92: `mkdir -p /founderos/agents` with correct ownership.

**Tests to write:**
- `server/src/__tests__/fly-config.test.ts` — parse fly.toml, assert `min_machines_running === 1`, `memory === "2gb"`, `kill_timeout === "30s"`. Catches accidental regressions.
- Manual smoke (Phase 3): deploy to staging, confirm machine stays warm across 5 minutes idle.

**PR title:** `feat(s8): bump Fly machine to 2gb + min_machines_running=1 for hosted agent execution`
**Commit:** `feat(s8): scale Fly machine for hosted claude execution`
**Success criteria:**
- `fly.toml` validates (CI gate).
- Test asserts new values.
- Cost calculator update in PR body: `+$X/mo for warm machine`.

---

### Agent 1B — Per-call key injection (no global env mutation)

**Branch:** `feat/s8-p01-key-vault-per-call`
**Conditions addressed:** C2
**Files to touch:**
- `/Users/vinamr/Projects/founderos/server/src/services/instance-api-keys.ts`
- `/Users/vinamr/Projects/founderos/server/src/services/index.ts` (re-exports)
- `/Users/vinamr/Projects/founderos/server/src/__tests__/instance-api-keys.test.ts` (existing — adapt)

**Changes:**
1. `instance-api-keys.ts:54-75` — DELETE `originalEnv`, `applyKeyToEnv`, `restoreOriginalEnv`. They are the global mutation surface.
2. `instance-api-keys.ts` `setKey()` and `deleteKey()` — remove the `applyKeyToEnv` / `restoreOriginalEnv` calls. Storage path stays unchanged.
3. ADD `getDecrypted(family, executionMode = 'api'): Promise<string | null>` — returns the decrypted plaintext or null. This is the new authoritative path for spawn-time key resolution.
4. `getDecrypted` MUST NOT log the plaintext, MUST timing-safe compare its absence (no enumeration of which family is configured via timing).
5. Audit any consumers of `process.env.ANTHROPIC_API_KEY` set by this service. Three places to check:
   - `server/src/services/agents/finance-scenario.ts:364` — `throw new Error("no_anthropic_key")` happens if env not set. Update to call `getDecrypted` instead.
   - Anywhere else `grep -rn "process.env.ANTHROPIC_API_KEY" server/` returns. Each call site decides: read-from-env (if it's a request-scoped operation) or read-from-vault (if it's a per-job operation).
6. Update tests to assert `process.env.ANTHROPIC_API_KEY` is NOT mutated by `setKey()`.

**Tests to write:**
- `setKey('anthropic', 'api', 'sk-ant-test')` → `process.env.ANTHROPIC_API_KEY` unchanged
- `getDecrypted('anthropic', 'api')` → returns the same value
- `deleteKey()` after `setKey()` → `getDecrypted()` returns null
- Concurrent setKey calls do not corrupt the encrypted blob
- The decrypted value is never logged by any test (assertion via log spy)

**PR title:** `feat(s8): drop global env mutation from instance-api-keys; add per-call getDecrypted`
**Commit:** `feat(s8): per-call key injection replacing global process.env mutation`
**Success criteria:**
- All existing tests pass after refactor.
- New test for `getDecrypted` returning correct decrypted value.
- `grep -rn "applyKeyToEnv" server/` returns zero hits.

---

### Agent 1C — Server-side claude handler hardening

**Branch:** `feat/s8-p01-claude-server-hardening`
**Conditions addressed:** C1, C5, C7, C8
**Files to touch:**
- `/Users/vinamr/Projects/founderos/packages/adapters/claude-local/src/server/execute.ts`
- `/Users/vinamr/Projects/founderos/packages/adapters/claude-local/src/server/__tests__/execute.test.ts` (new or extend existing)
- `/Users/vinamr/Projects/founderos/packages/adapters/claude-local/src/server/workdir.ts` (NEW — workdir helper)

**Changes:**
1. NEW: `workdir.ts` — `buildJobWorkdir({ companyId, runId }) -> { home, cache, cwd, root }`. Creates the dirs with mode `0700`. Returns absolute paths under `/founderos/agents/<companyId>/<runId>/`.
2. `execute.ts` — `buildClaudeRuntimeConfig`:
   - Pull `companyId`, `runId` from input.
   - Call `buildJobWorkdir`.
   - In `env`: set `HOME=<workdir>/home`, `CLAUDE_CONFIG_DIR=<workdir>/home/.claude`, `CLAUDE_PROMPT_CACHE_DIR=<workdir>/cache`. Override any inherited values from parent env.
   - Set `cwd = <workdir>/cwd`.
   - Resolve `ANTHROPIC_API_KEY`: call `instanceApiKeysService.getDecrypted('anthropic', 'api')`. If null → return `{ exitCode: null, errorCode: "no_api_key", errorMessage: "Anthropic API key not configured for this instance" }` BEFORE spawning. Fail fast.
   - Inject the decrypted value into the spawn `env` only.
3. `execute.ts:286` — `dangerouslySkipPermissions` default. Change to `false` for hosted runs (detected via `FOUNDEROS_HOSTED_AGENTS_ENABLED === "1"`). Existing local-dev path keeps `true`.
4. `execute.ts` final-result handling — wrap `cost_usd` extraction in `try/catch` returning `null` on parse failure (Council Gemini P3).
5. `execute.ts` end of `execute()` — `try { ...spawn... } finally { fs.rm(workdir.root, { recursive: true, force: true }).catch(() => {}) }`. Best-effort cleanup; orphans handled by Phase 2A boot sweep.

**Tests to write:**
- `buildJobWorkdir` creates `home`, `cache`, `cwd` subdirs with mode 0700
- `execute()` with no key configured returns clean error (no spawn)
- `execute()` with key configured spawns with `ANTHROPIC_API_KEY` in env
- `execute()` env does NOT include the parent process's `HOME=/founderos`
- `execute()` cleanup deletes the workdir on success
- `execute()` cleanup deletes the workdir on subprocess error
- `cost_usd` extraction returns null when claude emits no `result.cost_usd`

**PR title:** `feat(s8): per-job HOME + key injection + cleanup for server-side claude execution`
**Commit:** `feat(s8): harden claude-local server handler for multi-tenant hosted execution`
**Success criteria:**
- Workdir is created and cleaned per run.
- No spawn fires without a configured key.
- Existing claude_local tests still green (regression baseline).

---

### Agent 1D — Onboarding UI: simplify to "paste your Anthropic key"

**Branch:** `feat/s8-p01-onboarding-anthropic-default`
**Conditions addressed:** UX promise alignment (audit P0 #1, #4)
**Files to touch:**
- `/Users/vinamr/Projects/founderos/server/src/services/onboarding-bootstrap.ts` (line 287-308)
- `/Users/vinamr/Projects/founderos/ui/src/components/onboarding/` (adapter chooser step)
- `/Users/vinamr/Projects/founderos/server/src/routes/onboarding.ts` (validation flow already exists at line 286-292; verify hosted path)

**Changes:**
1. `onboarding-bootstrap.ts:289-308` — replace the hardcoded `byo_runner` collapse with hosted-aware logic:
   ```ts
   const HOSTED_ENABLED = process.env.FOUNDEROS_HOSTED_AGENTS_ENABLED === "1";
   const BYO_ENABLED = isByoRunnerEnabled();
   let adapterType: AgentAdapterType;
   if (HOSTED_ENABLED && input.adapterChoice === "anthropic_api") {
     adapterType = "claude_local"; // server-side, hardened path (Phase 1C)
   } else if (BYO_ENABLED) {
     adapterType = "byo_runner"; // legacy laptop-runner path
   } else {
     adapterType = mapOnboardingChoiceToAdapter(input.adapterChoice);
   }
   ```
2. `routes/onboarding.ts:286-292` — already validates `anthropicKey` length and calls `validateAnthropicKey`. After validate, ALSO call `instanceApiKeysService.setKey('anthropic', 'api', key)` so the key is in the vault BEFORE the bootstrap's first heartbeat fires. This consolidates from `company_secrets` to `instance_api_keys` for hosted users.
3. UI adapter chooser — for `FOUNDEROS_HOSTED_AGENTS_ENABLED=1` builds, default-select "I have an Anthropic API key" tile. The other tiles (Gemini, OpenAI, Codex, Cursor) keep "coming soon" badging from PR #135. The `claude_local` tile gets a "for developers — requires CLI on your laptop" hint.
4. UI: remove BYO Runner from the default visible options on hosted; surface it under "Advanced / Self-hosted" disclosure. (Existing customers already on `byo_runner` are unaffected — this is wizard chrome only.)

**Tests to write:**
- Bootstrap test: with `FOUNDEROS_HOSTED_AGENTS_ENABLED=1` and `adapterChoice='anthropic_api'` → agent rows have `adapterType='claude_local'`.
- Bootstrap test: with `FOUNDEROS_HOSTED_AGENTS_ENABLED=0` and `FOUNDEROS_BYO_RUNNER_ENABLED=1` → agent rows have `adapterType='byo_runner'` (no regression).
- Bootstrap test: with both flags off → agent rows have `mapOnboardingChoiceToAdapter(choice)` (dev path).
- Onboarding route test: posting a valid Anthropic key writes to `instance_api_keys` table.
- UI snapshot test for adapter chooser default selection.

**PR title:** `feat(s8): hosted-aware onboarding routes anthropic_api to server-side execution`
**Commit:** `feat(s8): unwind byo_runner collapse for hosted Anthropic-key onboarding`
**Success criteria:**
- All three flag combinations have explicit tests.
- Existing `onboarding-adapter-type.test.ts` still passes.
- Anthropic key posted in onboarding lands in `instance_api_keys`.

---

## Phase 2 — Wire-through (3 parallel agents)

Phase 2 starts after Phase 1's four PRs are all merged.

### Agent 2A — Per-founder workdir + boot-time orphan sweep

**Branch:** `feat/s8-p01-workdir-orphan-sweep`
**Conditions addressed:** C6
**Files to touch:**
- `/Users/vinamr/Projects/founderos/server/src/index.ts` (boot path)
- `/Users/vinamr/Projects/founderos/server/src/services/orphaned-workdir-sweep.ts` (NEW)
- `/Users/vinamr/Projects/founderos/server/src/__tests__/orphaned-workdir-sweep.test.ts` (NEW)

**Changes:**
1. NEW service `orphaned-workdir-sweep.ts`: `sweepOrphanedWorkdirs({ rootDir = "/founderos/agents", maxAgeMs = 24h })`. Walks `<rootDir>/<companyId>/<runId>/`, deletes any whose `mtime > maxAgeMs ago`. Logs deleted count via pino.
2. Wire into `server/src/index.ts` boot path AFTER `ensureMigrations` and BEFORE `app.listen`. Run async; do not block boot.
3. ALSO run on a 6-hour interval via `setInterval` in case the server stays up for days.

**Tests to write:**
- Sweep deletes a workdir mtime'd 25h ago
- Sweep keeps a workdir mtime'd 1h ago
- Sweep handles missing root dir gracefully (no error)
- Sweep handles a mid-flight runId workdir whose touch-time is recent
- Sweep logs the count of deleted dirs

**PR title:** `feat(s8): boot-time + interval sweep of orphaned agent workdirs`
**Commit:** `feat(s8): orphaned-workdir cleanup to keep /founderos volume from filling`
**Success criteria:**
- New service is wired into boot.
- Test asserts files older than 24h are deleted.
- No false-positive deletion of in-flight workdirs.

---

### Agent 2B — Job queue plumbing for adapter-type-aware dispatch

**Branch:** `feat/s8-p01-runner-jobs-bypass-when-hosted`
**Conditions addressed:** correctness (no laptop-runner accidentally claims a hosted job)
**Files to touch:**
- `/Users/vinamr/Projects/founderos/server/src/routes/runner-routes.ts` (job claim endpoint)
- `/Users/vinamr/Projects/founderos/server/src/adapters/byo-runner/index.ts` (already-correct: writes adapter_type to runner_jobs row — verify)
- `/Users/vinamr/Projects/founderos/packages/db/src/schema/runner.ts` (no schema change — exists)

**Changes:**
1. `runner_jobs.adapter_type` is already on the row (default `claude_local`). When the bootstrap writes `adapterType='claude_local'` for a hosted agent, the heartbeat fires `claude_local.execute()` directly via `server/src/adapters/registry.ts`. No `runner_jobs` row is created — this path bypasses the queue entirely. Verify this with a code-trace test.
2. The `byo_runner` adapter writes `adapter_type` to the row (verified at `byo-runner/index.ts:147`). The laptop runner's `/api/runner/jobs/next` endpoint should ONLY return rows where `adapter_type IN ('byo_runner', ...laptop-targeted types...)`. Add a defensive WHERE filter at the claim endpoint: never serve a `claude_local`-typed row to a laptop runner. (In hosted mode, `claude_local` jobs aren't enqueued anyway — but defense in depth.)
3. UI agent-row display: when `agent.adapter_type === 'claude_local'` AND `FOUNDEROS_HOSTED_AGENTS_ENABLED=1`, show "Hosted on FounderOS" badge instead of "Connect runner".

**Tests to write:**
- Heartbeat fires for hosted-claude agent → calls `claude_local.execute()`, no `runner_jobs` row written.
- Heartbeat fires for `byo_runner` agent → `runner_jobs` row written with `adapter_type='byo_runner'`.
- Laptop runner POSTing `/api/runner/jobs/next` never receives a `claude_local`-typed row (filter assertion).
- UI displays correct badge for each adapter type.

**PR title:** `feat(s8): defensive runner-job claim filter + hosted badge for claude_local agents`
**Commit:** `feat(s8): segregate hosted vs laptop-runner job claims`
**Success criteria:**
- Test verifies hosted execution does not enqueue `runner_jobs`.
- Test verifies laptop runner can never claim a hosted-typed row.

---

### Agent 2C — Migration smoke + byo_runner regression baseline

**Branch:** `feat/s8-p01-byo-runner-regression-baseline`
**Conditions addressed:** R1 (no regression)
**Files to touch:**
- `/Users/vinamr/Projects/founderos/server/src/__tests__/byo-runner-baseline.test.ts` (NEW)
- `/Users/vinamr/Projects/founderos/docs/runbooks/byo-runner-smoke.md` (extend)

**Changes:**
1. NEW test suite: `byo-runner-baseline.test.ts` — covers the four core scenarios that MUST not regress:
   - Issuing a runner token works
   - `runner_jobs` row written when heartbeat fires for `byo_runner` agent
   - Laptop runner can claim and complete a job
   - `runner_tokens.lastSeenAt` updates on every claim
2. Extend `byo-runner-smoke.md` with a "regression checkpoint after S8 P0.1" section: pre-merge run-through that validates byo_runner works on a feature-branch deploy.

**Tests to write:** see above.

**PR title:** `test(s8): regression baseline for byo_runner adapter (S8 P0.1 safety net)`
**Commit:** `test(s8): byo_runner baseline tests to prevent regression during hosted rollout`
**Success criteria:**
- 4 new tests added and passing.
- Runbook updated.

---

## Phase 3 — Integration test + smoke (1 QA agent)

### Agent 3A — End-to-end smoke on staging Fly app

**Branch:** `chore/s8-p01-staging-smoke`
**Files to touch:**
- `/Users/vinamr/Projects/founderos/scripts/s8-p01-smoke.sh` (NEW)
- `/Users/vinamr/Projects/founderos/.planning/PHASE-S8-P01/SMOKE-RESULTS.md` (NEW — populated post-run)

**Steps:**
1. Provision a staging Fly app `founderos-s8smoke` from `feat/s8-p01-*` branches (after Phase 1 + Phase 2 merged into a release branch `release/s8-p01`).
2. Set `FOUNDEROS_HOSTED_AGENTS_ENABLED=1` on staging.
3. Run a programmatic onboarding: POST `/api/onboarding/bootstrap` with a real Anthropic test key.
4. Trigger a heartbeat for the CoS agent.
5. Assert: `/api/agents/<id>/runs/latest` reaches `status='completed'` within 90 seconds.
6. Assert: `runner_jobs` table has zero new rows for this run.
7. Assert: `cost_micros` is non-null.
8. Assert: `/founderos/agents/<companyId>/<runId>/` is cleaned up post-run (SSH check).
9. Repeat with `FOUNDEROS_HOSTED_AGENTS_ENABLED=0` (legacy path) → confirms regression baseline.
10. Memory probe: during the run, `fly status -m` confirms peak RSS < 1.6gb.
11. Document each assertion's pass/fail in `SMOKE-RESULTS.md`.

**PR title:** `chore(s8): staging smoke for hosted agent execution`
**Success criteria:**
- All 8 assertions pass on staging.
- Memory peak documented.
- SMOKE-RESULTS.md committed with timestamps + Fly logs link.

---

## Phase 4 — Final PR + deploy

### Agent 4A — Integration PR + Fly flag flip

**Branch:** `release/s8-p01-hosted-execution`
**Files to touch:** all four Phase 1 branches + Phase 2 branches + Phase 3 smoke results merged.

**Steps:**
1. Cut `release/s8-p01-hosted-execution` from `main` after all Phase 1+2 PRs are merged.
2. Final PR: `feat(s8): server-side hosted agent execution (P0.1)` — body links all child PRs and smoke results.
3. After merge: `fly secrets set FOUNDEROS_HOSTED_AGENTS_ENABLED=1 -a founderos`.
4. Watch `fly logs -a founderos | grep s8-p01` for first hosted heartbeat.
5. Post-deploy probe: synthetic onboarding → first agent run → smoke that the production `cost_micros` is non-null.
6. ROADMAP update: mark S8 P0.1 status `done` with PR link + completed date. Last touched stamp updated.
7. Run `/vanta-sync` to extract learnings into invariants.

**Success criteria:**
- Flag flipped on prod.
- Synthetic smoke passes against prod.
- ROADMAP updated.
- No regression on byo_runner customers (verified via `byo-runner-baseline.test.ts` running in CI on every commit).

---

## Risk + rollback

If Phase 4 deploy reveals an issue:
- `fly secrets set FOUNDEROS_HOSTED_AGENTS_ENABLED=0 -a founderos` — immediate rollback. New onboardings fall through to `byo_runner`. Existing agents (post-S8-P01-onboard) re-bootstrap on their next heartbeat? **NO** — their `agents.adapter_type='claude_local'` is sticky. Rollback ALSO requires a one-time SQL: `UPDATE agents SET adapter_type='byo_runner' WHERE adapter_type='claude_local' AND created_at > '2026-05-10';`. Document this in the deploy runbook.
- Memory crisis: `fly scale memory 4096 -a founderos` (one-line bump from 2gb → 4gb).
- Mid-job kill on machine restart: extend `kill_timeout` further (currently 30s in 1A).

---

## Success metric for the entire phase

A non-technical design partner pasting their Anthropic API key into the onboarding wizard sees their first agent run reach `completed` status — without installing anything, opening a terminal, or asking a developer for help — within 90 seconds of clicking "Finish onboarding."
