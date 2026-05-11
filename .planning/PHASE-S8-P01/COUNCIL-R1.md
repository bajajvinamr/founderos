# S8 P0.1 — Council R1 (full council mode)

_Date: 2026-05-10_
_Mode: FULL — Codex + Gemini both responded._
_Verdict: **PASS_WITH_CONDITIONS** — no architectural BLOCK; multiple P1 hardening items must land in Phase 1._

---

## Prompt sent to both reviewers

> FounderOS server-side agent execution — architecture review.
>
> Current state:
> - Laptop runner via `@founderos/runner`. `byo_runner` is the default on Fly because `FOUNDEROS_BYO_RUNNER_ENABLED=1` (fly.toml).
> - `onboarding-bootstrap.ts:307` collapses ALL adapter choices (including `anthropic_api`) to `byo_runner`.
> - Dockerfile already installs `@anthropic-ai/claude-code` globally (line 91).
> - `packages/adapters/claude-local/src/server/execute.ts` exists — server-side claude CLI subprocess. Registered in adapter registry but `byo_runner` override bypasses it.
> - `instance_api_keys` table — encrypted-at-rest envelope encryption via `local-encrypted-provider` master key on `/founderos` volume. `instance-api-keys.ts` syncs keys into `process.env` on set/delete.
> - Fly: `shared-cpu-1x`, 1gb RAM, single machine, `auto_stop_machines=stop`, `min_machines_running=0`, 3gb volume at `/founderos`.
>
> Goal: Anthropic API key → server-side claude-code CLI inside Fly container as DEFAULT for hosted plan. `byo_runner` stays for self-hosted. ONE adapter tonight: `anthropic_api`. OpenAI/Gemini/Codex remain "coming soon".
>
> Proposed architecture: (1) stop overriding to `byo_runner` when `FOUNDEROS_HOSTED_AGENTS_ENABLED=1` AND choice is `anthropic_api`; route to a server-side handler enforcing `ANTHROPIC_API_KEY` from `instance_api_keys` (not OAuth subscription). (2) per-job workdir `/founderos/agents/<companyId>/<runId>/`. (3) Fly machine-level resource caps; concurrency cap = ~3 at dispatcher. (4) parse `result.cost_usd`. (5) auto-stop interaction → consider `min_machines_running=1` or wake-via-API. (6) `byo_runner` unchanged for migration.
>
> Critique for: (a) security (b) isolation (c) scaling (d) cost (e) failure modes. P1/P2/P3/P4 format. Under 500 words.

---

## Codex output (gpt-5.4 / powerful tier)

> **[P1] Global key scope is incompatible with a shared hosted plan** — `packages/db/src/schema/instance_api_keys.ts:4` + `server/src/services/instance-api-keys.ts:43` — `"Scope: instance. One instance = one customer"` and `"process.env[envVar] = value"` mean one Anthropic key per app process, not per founder/company. On a single Fly machine serving many founders, concurrent jobs cannot safely use different keys. Specific fix: either keep one Fly app per customer, or move hosted Anthropic creds to a company-scoped store and inject the decrypted key only into that job's child env, never into global `process.env`.
>
> **[P1] Per-job workdirs do not provide isolation while Claude is unsandboxed on a shared `/founderos` volume** — `packages/adapters/claude-local/src/server/execute.ts:286` + `Dockerfile:98` — `"const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true)"`, `"args.push(\"--dangerously-skip-permissions\")"`, and `"HOME=/founderos"` let prompt-injected tool use read/write outside `/founderos/agents/<companyId>/<runId>`, including other tenants' prompt caches, session state, and the secrets volume. Specific fix: default hosted runs to permissioned/sandboxed mode, mount a per-job `HOME`/`CLAUDE_CONFIG_DIR`, and deny access above the job root.
>
> **[P2] Shared Claude state will leak across founders unless you isolate `HOME` and config dirs per run** — `provider-credentials.ts:60` + `claude-local/src/server/prompt-cache.ts:24` — `"~/.claude/.credentials.json"` and `companies/<companyId>/claude-prompt-cache` show the CLI still uses shared homedir state even if you isolate `cwd`. Specific fix: set per-job `HOME=/founderos/agents/<companyId>/<runId>/home` and `CLAUDE_CONFIG_DIR` there too; clean both on terminal status.
>
> **[P2] Key rotation/revocation semantics are undefined for queued jobs** — `instance-api-keys.ts:121` — `"Sync into process.env so adapter subprocesses inherit the new key"` and delete restoring env mean a queued job may run with the rotated key, fail after revocation, or pick up a different founder's key if you ever multiplex tenants. Specific fix: snapshot `credential_id/version` onto the job row at enqueue, resolve that exact key at spawn, and cancel queued jobs when that version is revoked.
>
> **[P3] `shared-cpu-1x` / `1gb` is not a 10-concurrent design** — `fly.toml:104` + `packages/runner/src/main.ts:4` — `"memory = \"1gb\""` and `"v0.1 is single-threaded"` show the current system was shaped around one active CLI run, not many. First contention will be RAM/OOM from multiple Claude subprocesses, not DB. Specific fix: start at concurrency `1-2`, measure per-run RSS, and only raise it after real load data or a larger VM/worker split.
>
> **Cost note:** if you keep one warm LHR machine, Fly lists `shared-cpu-1x`/`1GB` at about `$6.79/mo` plus `3GB` volume at about `$0.45/mo`; if scale-to-zero works, infra is near-zero and Anthropic dominates. Anthropic Sonnet 4 API is `$3/MTok` input and `$15/MTok` output, so pass-through needs budget enforcement, not just monitoring. Sources: https://fly.io/docs/about/pricing/ , https://docs.anthropic.com/en/docs/about-claude/pricing

## Gemini output (gemini-3-pro-preview / powerful tier)

> ### P1 (Block-Merge)
> *   **Fly Proxy Auto-Stop Kills In-Flight Runs:** In `fly.toml`, `auto_stop_machines = "stop"` is set. Fly's edge proxy relies on active HTTP connections to keep the machine awake. Background `claude` subprocesses will not hold the proxy open. If no HTTP requests are active, Fly will `SIGINT` the machine mid-job. **Fix:** Either set `min_machines_running = 1` or have the dispatcher wake the machine via the Fly Machines API and hold a dummy HTTP request open for the duration of the job.
> *   **Shared SQLite State Corruption (`~/.claude`):** The `claude` CLI maintains local state (e.g., prompt cache, SQLite DB) in its config directory. The current `execute.ts` passes `HOME` and `CLAUDE_CONFIG_DIR` down into `runChildProcess`. If 3 concurrent jobs run under the same shared `/founderos` directory, SQLite locks will collide, causing `claude` to crash or corrupt its history. **Fix:** Point `CLAUDE_CONFIG_DIR` to the per-job isolated workdir (`/founderos/agents/<companyId>/<runId>/`) so each run has a pristine, isolated cache.
>
> ### P2 (Must-Fix-Before-Prod)
> *   **OOM on 1GB Memory with Concurrency:** `fly.toml` provisions `memory = "1gb"`. The `claude` CLI is a heavy Node process. At a concurrency cap of 3, three `claude` processes plus the main `founderos` server will exceed 1GB and trigger OOM kills. **Fix:** Increase Fly machine memory to `2gb` or drop the dispatcher concurrency cap to `1` for the entry-level hosted tier.
> *   **Global `process.env` Mutation Race Conditions:** `instance-api-keys.ts` (`applyKeyToEnv`) mutates the global `process.env`. While the deployment is single-tenant, mutating globals introduces race conditions if a founder rotates an API key while jobs are queued. **Fix:** Remove `applyKeyToEnv`. Instead, inject the decrypted API key strictly into the `env` record passed to `runChildProcess` in `execute.ts`.
>
> ### P3 (Should-Fix)
> *   **Orphaned Workdirs on Hard Crash:** The proposal states "/founderos/... cleanup on terminal". If the Fly machine OOM-kills or `SIGKILL`s the `claude` process, the Node cleanup trap won't fire. Over time, the 3GB persistent volume will fill up. **Fix:** Add a boot-time TTL cleanup sweep for `/founderos/agents/*` in the server startup lifecycle.
> *   **Cost Parsing Unreliability:** Parsing `result.cost_usd` in `execute.ts` works well for direct Anthropic API keys. However, if Bedrock (`isBedrockAuth`) or other billing paths are configured later, the CLI might report `$0`. Ensure telemetry degrades gracefully without crashing the run if costs are absent.
>
> ### P4 (Nice-to-Have)
> *   **Prompt-Template Injection:** You are safely passing the user prompt via `stdin` (`execute.ts:311`), which mitigates `argv` shell injection threats. However, keep `dangerouslySkipPermissions` scoped strictly to the `/founderos/agents/...` workdir so a prompt jailbreak cannot command the CLI to read the instance's `instance_api_keys.ts` env vars from the parent process.

---

## Synthesis (my verdict)

### Both-confirmed P1 (highest confidence — must land in Phase 1)

1. **Per-job HOME + CLAUDE_CONFIG_DIR isolation.** Codex P1 + Gemini P1.
   - Without this: cross-tenant prompt-cache leak, SQLite lock collisions, and a path for prompt-injection escape via `~/.claude/.credentials.json`.
   - Fix lands in `packages/adapters/claude-local/src/server/execute.ts` — set `HOME=/founderos/agents/<companyId>/<runId>/home` AND `CLAUDE_CONFIG_DIR` there, AND scope `--dangerously-skip-permissions` (or replace with explicit allowlist) to that subtree only.

2. **Stop mutating global `process.env` for keys.** Codex P1 (per-tenant) + Gemini P2 (race condition). Same root cause.
   - Fix: `instance-api-keys.ts` MUST stop calling `applyKeyToEnv()`. The decrypted key is passed via `env` arg into `runChildProcess` per call. Existing `buildFounderOSEnv` is the right injection point.
   - Bonus: eliminates Codex's "concurrent jobs cannot use different keys" concern preemptively even though hosted is currently single-instance.

### Single-reviewer P1 (still must address)

3. **Fly auto-stop kills mid-job.** Gemini P1 only — Codex did not raise it but cost-noted scale-to-zero is desirable.
   - Verdict: real issue. The dispatcher does NOT hold an HTTP request open for the duration of a 60-second claude job. Fix: `min_machines_running = 1` for hosted plan in V1. Wake-via-API is V2. Cost tradeoff: $6.79/mo for the warm machine vs scale-to-zero. Acceptable for a paid product at $299+/mo.

### Both-confirmed P2

4. **OOM at 1gb with concurrency.** Codex P3 + Gemini P2. Bump VM to `2gb` AND cap concurrency at `1` initially. Real load measurement decides if it goes higher.

### Single-reviewer P2

5. **Key rotation/revocation undefined for queued jobs.** Codex P2.
   - Snapshot `credentialVersion` (or the encrypted blob's `versionId`) onto `runner_jobs` at enqueue. At spawn, decrypt that exact version. If the operator-side rotation observably revoked it, the spawn fails fast with a clean error vs running with stale-and-still-valid key.
   - V1: simpler — at spawn time, fetch the live key. If absent or revoked, fail. Defer per-job version pinning to V2.

### Both-confirmed P3

6. **Orphaned workdir cleanup.** Gemini P3 only but Codex implicit (`/founderos` is shared). Boot-time sweep for `/founderos/agents/*` older than 24h.

### Disagreements

None. Codex emphasized scope leakage across the global key/process.env model; Gemini emphasized SQLite lock collision and Fly auto-stop. Both perspectives are correct and additive.

---

## Conditions for PASS

The architecture proposal is sound but conditional. Phase 1 of the implementation plan MUST include:

| Condition | Owner | Where |
|---|---|---|
| C1. Per-job `HOME` + `CLAUDE_CONFIG_DIR` isolation | Agent 1C (server-side handler) | `claude-local/src/server/execute.ts` + workdir helper |
| C2. Stop mutating `process.env` from `instance-api-keys.ts`; inject via per-call env only | Agent 1B (key vault) | `instance-api-keys.ts:60-75` removal + spawn-time injection |
| C3. `min_machines_running = 1` on hosted plan | Agent 1A (Fly config) | `fly.toml:70` |
| C4. VM memory bump to `2gb` + dispatcher concurrency cap `= 1` for hosted V1 | Agent 1A | `fly.toml:106` + dispatcher config |
| C5. Fail-fast on missing/revoked key at spawn (V1 — no version pinning) | Agent 1C | `execute.ts` pre-spawn check |
| C6. Boot-time orphaned-workdir sweep | Agent 2A (workdir + isolation) | New service in server boot path |
| C7. `--dangerously-skip-permissions` scope reduction OR explicit allowlist scoped to per-job workdir | Agent 1C | `execute.ts:286` |
| C8. Cost extraction must not crash on absent `result.cost_usd` (Bedrock/future paths) | Agent 1C | `execute.ts` final-result handler |

If any of C1, C2, C3, C4, C5, C7 are skipped or partially shipped, **the merge is blocked** until council R2 reviews the gap.

C6 and C8 are SHOULD-FIX — can ship in Phase 2 with a tracked follow-up.

## Final verdict

**PASS_WITH_CONDITIONS.** Architecture is correct in shape. Surgical re-routing + multi-tenant hardening, not a greenfield rewrite. Phase 1 must land C1-C5 + C7 before any production traffic hits the new path.

No architectural BLOCK was raised. The structure of the proposal — keep `byo_runner` for migration, route hosted to existing `claude_local` server execute path, gate via `FOUNDEROS_HOSTED_AGENTS_ENABLED` flag, store keys encrypted in `instance_api_keys` — was endorsed implicitly by both reviewers (no objection to the structure, only to the implementation details listed above).
