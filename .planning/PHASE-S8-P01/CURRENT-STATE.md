# S8 P0.1 — Current State Map (read-only)

_Date: 2026-05-10_
_Branch: `docs/s8-p01-architecture-plan`_
_Source: direct read of `main` HEAD via worktree at `0483ab1`._

---

## 1. How does `adapter-resolver.ts` route an `anthropic_api` adapter?

**It doesn't reach a real handler.** Two hops:

- `mapOnboardingChoiceToAdapter()` at `server/src/services/adapter-resolver.ts:289-322` collapses `anthropic_api` → `claude_local`:
  ```ts
  case "claude_local":
  case "anthropic_api":
  case "skip":
    return "claude_local";
  ```
  The comment on line 271 explicitly says: _`anthropic_api` collapses to `claude_local` because no `claude_api` adapter exists in the codebase._

- The runtime resolver `resolveAgentAdapter()` (lines 66-127) then picks `claude_local` from `ADAPTER_MAP.anthropic.cli` (line 184). There is no `ADAPTER_MAP.anthropic.api` slot.

**But — bootstrap overrides both.** `server/src/services/onboarding-bootstrap.ts:307` then forces ALL choices to `byo_runner`:
```ts
const adapterType = isByoRunnerEnabled() ? "byo_runner" : "claude_local";
```
`FOUNDEROS_BYO_RUNNER_ENABLED=1` is set in `fly.toml:55`. So in production, the user's pick is irrelevant — every agent is provisioned with `adapter_type = "byo_runner"`.

## 2. `runner_jobs` queue + execution path

**Schema** — `packages/db/src/schema/runner.ts:128-220`. Notable columns:
- `id`, `companyId` (FK companies), `agentId` (FK agents, same-tenant invariant), `heartbeatRunId` (FK heartbeat_runs)
- `prompt` (text), `promptHash` (sha256), `runtimeConfig` (JSON-encoded)
- `adapterType` text — defaults to `claude_local`, CHECK-constrained per migration 0105
- `status` enum: `queued | claimed | streaming | completed | failed | cancelled`
- `claimedByTokenId`, `claimedAt`, `completedAt`, `exitCode`, `signal`, `elapsedMs`, `costMicros`, `sessionIdAfter`, `cliVersion`, `errorMessage`

**Producer** — `server/src/adapters/byo-runner/index.ts:78-170`. The `byo_runner.execute()` function:
1. Renders prompt template (`renderTemplate`)
2. Inserts a `runner_jobs` row with `adapter_type = agent.adapterType ?? "claude_local"`
3. Polls every `POLL_INTERVAL_MS` until terminal status

**Consumer** — `packages/runner/src/main.ts` + `packages/runner/src/dispatcher.ts`. Runs OUTSIDE Fly. The runner authenticates with a `runner_token` (sha256-hashed at rest, plaintext shown once via `RunnerInstallDialog`), polls `/api/runner/jobs/next`, claims atomically, dispatches to a per-adapter handler in `packages/runner/src/adapters/` (claude.ts, codex.ts, gemini.ts), spawns the local CLI binary, streams events back via `/api/runner/jobs/:id/events`, and POSTs completion.

**Heartbeat liveness** — `runner_tokens.lastSeenAt` is touched on every authenticated request (per CLAUDE.md). Pill turns offline when `lastSeenAt > 30s ago`.

## 3. Where is the founder's Anthropic API key stored?

**Encrypted at rest in `instance_api_keys`** — `packages/db/src/schema/instance_api_keys.ts:11-32`. Schema:
- `id` (composite slug `${family}:${executionMode}` — e.g. `anthropic:api`)
- `family` text — `"anthropic" | "openai" | "google"`
- `executionMode` text — `"api" | "cli_oauth"`
- `encryptedValue` text — JSON-serialized envelope from `local-encrypted-provider.ts` (iv/tag/ciphertext, AES-256-GCM)
- `keyHint` text — last 4 chars only, never full value

**Master key** — lives at `/founderos/secrets/master-key` on the persistent volume, set via `FOUNDEROS_SECRETS_MASTER_KEY` Fly secret at provisioning.

**Service** — `server/src/services/instance-api-keys.ts:78-180`. `setKey()` upserts encrypted value AND populates `process.env.ANTHROPIC_API_KEY` so subprocess inheritance works (`applyKeyToEnv` at line 60-62). `deleteKey()` restores the original env.

**Secondary path** — `onboarding-bootstrap.ts:93` defines `ANTHROPIC_SECRET_NAME = "ANTHROPIC_API_KEY"` and stores the wizard-supplied key as a `company_secret`. The `buildAgentAdapterConfig()` helper (lines 142-156) wires `secret_ref` into the agent's `adapter_config.env`. So we have TWO key stores: `instance_api_keys` (instance-scoped, env-injected) and `company_secrets` (company-scoped, ref-resolved at execute time). Hosted plan should consolidate on the company-scoped path.

**Validation endpoint** — `POST /api/providers/validate-key` at `server/src/routes/providers.ts:152-187`. Already wired and rate-limited (10/5min per IP).

## 4. Dockerfile audit

`/Users/vinamr/Projects/founderos/Dockerfile`:
- Base: `node:lts-trixie-slim` + `gosu curl git wget ripgrep python3` + corepack (line 1-7)
- `pnpm` enabled via corepack
- **Line 91 — already installs `@anthropic-ai/claude-code@latest` globally** (also `@openai/codex@latest` and `opencode-ai`). So claude CLI is on the production image PATH.
- `HOME=/founderos` (line 99) — a SHARED home for all jobs. Council R1 P1: this is the cross-tenant leak vector.
- `VOLUME ["/founderos"]` (line 112)

Room for additions: yes. The `npm install --global` line is the right place to add other CLIs as we widen support. We can also add a per-job HOME fixup in `docker-entrypoint.sh`.

## 5. fly.toml machine config

- VM: `shared-cpu-1x`, `memory = "1gb"`, `cpus = 1` (lines 104-108)
- Single machine (`min_machines_running = 0`, auto-stop on idle)
- Volume `founderos_data` mounted at `/founderos`, `initial_size = "3gb"` (lines 60-62)
- Region `lhr`
- `release_command = "node /app/packages/db/dist/migrate.js"` for migrations
- HTTP checks: `/api/healthz` (5s) and `/api/readyz` (30s)
- `kill_signal = "SIGINT"`, `kill_timeout = "5s"` — concerning; in-flight claude job gets only 5s grace.

## 6. Env vars exposed to subprocesses

Subprocess spawn flow: `runChildProcess` (in `packages/adapter-utils/server-utils`) inherits `process.env` by default, plus a per-call `env` override (claude execute.ts:286 builds it via `buildFounderOSEnv`). Currently inherited:
- `NODE_ENV`, `HOST`, `PORT`, `HOME=/founderos`, `FOUNDEROS_HOME=/founderos`, `FOUNDEROS_INSTANCE_ID=default`, `FOUNDEROS_CONFIG=/founderos/instances/default/config.json`, `FOUNDEROS_DEPLOYMENT_MODE=authenticated`, `FOUNDEROS_DEPLOYMENT_EXPOSURE=public`, `FOUNDEROS_AUTH_PROVIDER=supabase`, `FOUNDEROS_BYO_RUNNER_ENABLED=1`, `OPENCODE_ALLOW_ALL_MODELS=true`
- `ANTHROPIC_API_KEY` (when `instanceApiKeysService.setKey()` was called — sticky in process.env)
- `DATABASE_URL`, `FOUNDEROS_SECRETS_MASTER_KEY`, `SUPABASE_*`, etc. via Fly secrets

**Threat:** if `dangerouslySkipPermissions=true` (default in execute.ts:286) AND HOME is shared, a prompt-injected claude job could read `instance_api_keys.encryptedValue` direct from Postgres via `DATABASE_URL`, exfiltrate the master key from `/founderos/secrets/`, and decrypt every founder's key. Council R1 P1.

## 7. Existing claude_local server-side execution path

**`packages/adapters/claude-local/src/server/execute.ts`** (~340 lines) ALREADY runs `claude` server-side via `runChildProcess`. It handles:
- Per-call env build (`buildFounderOSEnv`)
- Prompt-cache prep (`prepareClaudePromptBundle`)
- Skill resolution (`resolveClaudeDesiredSkillNames`)
- Stream-json parsing (`parseClaudeStreamJson`)
- Final result extraction (cost, sessionId, exit code)
- Bedrock vs API vs subscription billing detection (`resolveClaudeBillingType`)
- Login-required detection (`detectClaudeLoginRequired`)
- Workspace cwd resolution (`workspaceContext.cwd`)

**It is registered** in `server/src/adapters/registry.ts:91-97` as `claude_local`. The bypass is upstream — `byo_runner` enqueues to `runner_jobs` instead of calling this path. To enable hosted execution we don't need a NEW handler; we need to (a) NOT collapse to `byo_runner` in onboarding-bootstrap when hosted is enabled, (b) ensure the resolver actually picks `claude_local`, (c) harden execute.ts for multi-tenant safety (per-job HOME, per-job CLAUDE_CONFIG_DIR, narrower permissions).

This is materially smaller scope than "build a new handler from scratch."

---

## Summary verdict for architecture doc

The infrastructure to run claude server-side is 80% already in place:
- Server-side execute path: ✓ (`claude-local/server/execute.ts`)
- Encrypted key storage: ✓ (`instance_api_keys`)
- Dockerfile has the CLI: ✓
- Validation endpoint: ✓
- Persistent volume: ✓

The work is primarily **(1)** plumb the resolver/onboarding-bootstrap to NOT collapse to `byo_runner`, **(2)** harden execute.ts for multi-tenancy (per-job HOME + CLAUDE_CONFIG_DIR + narrower `--dangerously-skip-permissions` scope), **(3)** flip the company-scoped key into the env at spawn time only (not global `process.env`), **(4)** address the auto-stop-mid-job and OOM risks at the Fly layer (memory bump + min_machines or wake-on-enqueue), **(5)** UI: simplify onboarding to ask only for the Anthropic key.

No greenfield. Surgical re-routing + multi-tenant hardening.
