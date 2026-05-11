# S8 P0.1 — Server-Side Agent Execution: Architecture

_Date: 2026-05-10_
_Status: Council R1 PASS_WITH_CONDITIONS_
_Adapter scope tonight: `anthropic_api` only. OpenAI/Gemini/Codex remain "coming soon" (already shipped honestly in PR #135)._

---

## 1. Goal & success criteria

### Goal
Close the gap between the marketing promise ("5-minute setup, zero code, AI executive team in one workspace") and the product reality ("install `@founderos/runner` on your laptop and keep a process alive"). The hosted plan must run agents on Fly with **only** an Anthropic API key from the founder.

### Success criteria
A non-technical design partner with no developer present can: complete onboarding by pasting an Anthropic API key, see their first agent run go from `queued → streaming → completed` in the UI within 60 seconds, and have it execute inside the Fly container — without installing anything. `byo_runner` continues to work for existing customers and self-hosted deployments. **No regression** for the 100% of current production traffic on `byo_runner`.

---

## 2. Current state (summary)

See `CURRENT-STATE.md` for the full read. Highlights:

- **80% of the infrastructure already exists.** `claude` CLI is installed in the Docker image (Dockerfile:91), `claude_local` server-side execute path is implemented (`packages/adapters/claude-local/src/server/execute.ts`) and registered in the adapter registry, encrypted key storage exists (`instance_api_keys`), validation endpoint exists (`POST /api/providers/validate-key`), persistent volume exists (`/founderos`).
- **Two blockers prevent it from working today.** (1) `onboarding-bootstrap.ts:307` collapses every adapter choice to `byo_runner` when `FOUNDEROS_BYO_RUNNER_ENABLED=1` (set in fly.toml). (2) The `claude_local` execute path is not multi-tenant safe — `HOME=/founderos` is shared across all jobs, prompt cache lives in a global location, and `instance-api-keys.ts` mutates global `process.env`.
- **Council R1 PASS_WITH_CONDITIONS.** No architectural BLOCK. Phase 1 must address 6 hardening items (C1-C5, C7) before any production traffic.

---

## 3. Target architecture

```
                     ┌────────────────────────────────────────────────────────────┐
                     │  FOUNDER (browser)                                          │
                     │  Onboarding → pastes Anthropic API key → POST /onboarding   │
                     └────────────────────────────┬───────────────────────────────┘
                                                  │
                                                  ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  Fly machine (founderos.fly.dev) — shared-cpu-2x, 2gb RAM, min_machines_running=1         │
│                                                                                           │
│  ┌────────────────────────────────────────────────────────────────────────────────────┐ │
│  │  server/src/routes/onboarding.ts                                                    │ │
│  │   1. validateAnthropicKey(input.anthropicKey)            ← already exists           │ │
│  │   2. instanceApiKeysService.setKey('anthropic', 'api', key)  ← stop mutating env    │ │
│  │   3. onboardingBootstrap(...)                                                       │ │
│  └────────────────────────────────────┬───────────────────────────────────────────────┘ │
│                                       │                                                   │
│                                       ▼                                                   │
│  ┌────────────────────────────────────────────────────────────────────────────────────┐ │
│  │  onboarding-bootstrap.ts (HOSTED-AWARE)                                              │ │
│  │   if FOUNDEROS_HOSTED_AGENTS_ENABLED && choice == anthropic_api:                    │ │
│  │       adapterType = 'claude_local'        ← server-side execution                    │ │
│  │   else if isByoRunnerEnabled():                                                      │ │
│  │       adapterType = 'byo_runner'          ← LEGACY: laptop runner                    │ │
│  │   else:                                                                              │ │
│  │       adapterType = 'claude_local'        ← LEGACY: dev/local                        │ │
│  └────────────────────────────────────┬───────────────────────────────────────────────┘ │
│                                       │                                                   │
│                                       ▼                                                   │
│  ┌────────────────────────────────────────────────────────────────────────────────────┐ │
│  │  Heartbeat fires → server/src/adapters/registry.ts → claude_local.execute()          │ │
│  │                                                                                       │ │
│  │  packages/adapters/claude-local/src/server/execute.ts (HARDENED)                     │ │
│  │   1. Build per-job workdir: /founderos/agents/<companyId>/<runId>/                  │ │
│  │   2. mkdir -p workdir/home, workdir/cache, workdir/cwd                              │ │
│  │   3. Resolve key: key = instanceApiKeysService.getDecrypted('anthropic', 'api')     │ │
│  │      ── fail fast if missing/revoked                                                  │ │
│  │   4. env = { ...buildFounderOSEnv(),                                                  │ │
│  │              ANTHROPIC_API_KEY: key,           ← per-call only, never global         │ │
│  │              HOME: workdir/home,               ← per-job HOME isolation              │ │
│  │              CLAUDE_CONFIG_DIR: workdir/home/.claude,                                  │ │
│  │              CLAUDE_PROMPT_CACHE_DIR: workdir/cache }                                  │ │
│  │   5. cwd = workdir/cwd (NOT /founderos root)                                          │ │
│  │   6. spawn `claude --print -` with stdin = prompt, stream-json output                │ │
│  │      ── --dangerously-skip-permissions scoped to workdir only (or removed for V1)    │ │
│  │   7. Stream events to heartbeat_run_events                                           │ │
│  │   8. On terminal: parse cost_usd → cost_micros, sessionId → sessionIdAfter           │ │
│  │   9. Cleanup workdir (best-effort; boot-time sweep handles orphans)                  │ │
│  └────────────────────────────────────┬───────────────────────────────────────────────┘ │
│                                       │                                                   │
│                                       ▼                                                   │
│  ┌────────────────────────────────────────────────────────────────────────────────────┐ │
│  │  /founderos volume (3gb persistent)                                                  │ │
│  │   ├── instances/default/config.json                                                  │ │
│  │   ├── secrets/master-key                  ← envelope encryption master              │ │
│  │   ├── companies/<companyId>/...           ← legacy claude prompt cache (deprecated) │ │
│  │   └── agents/<companyId>/<runId>/         ← NEW per-job workdir                     │ │
│  │       ├── home/.claude/                   ← isolated CLAUDE_CONFIG_DIR              │ │
│  │       ├── cache/                          ← isolated prompt cache                    │ │
│  │       └── cwd/                            ← isolated cwd                             │ │
│  └────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                           │
│  ┌────────────────────────────────────────────────────────────────────────────────────┐ │
│  │  Boot-time worker (NEW): orphaned-workdir sweep                                      │ │
│  │   On server boot: rm -rf /founderos/agents/*/runId older than 24h                   │ │
│  └────────────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────────┘

LEGACY PATH (unchanged for migration):
   onboarding-bootstrap → adapterType=byo_runner → byo_runner.execute() →
   INSERT runner_jobs → @founderos/runner on laptop polls → spawns local claude CLI
```

---

## 4. Components

### 4.1 API key storage
Reuse `instance_api_keys` (already encrypted-at-rest). One change: **stop mutating `process.env` from `applyKeyToEnv()`** — instead, expose `instanceApiKeysService.getDecrypted(family, mode)` and inject only into per-call subprocess `env`. This eliminates the global-state race condition (Council Gemini P2) and the per-tenant key collision (Council Codex P1) preemptively. The `originalEnv` snapshot machinery in `instance-api-keys.ts:54-58` becomes dead code and is deleted.

For tonight's scope (single-tenant per Fly app), instance-scoped storage is fine. When we go multi-tenant in a later sprint, the storage migrates to `company_api_keys` and the same getter pattern applies. No public-API change needed for that future migration.

### 4.2 Adapter resolver
No code change. `mapOnboardingChoiceToAdapter()` already returns `claude_local` for `anthropic_api` (resolver.ts:293-296). The bug is downstream in `onboarding-bootstrap.ts`.

### 4.3 Server-side handler (existing, hardened)
`packages/adapters/claude-local/src/server/execute.ts` is the handler. Changes:
1. **Per-job workdir.** New helper `buildJobWorkdir({ companyId, runId })` returns paths and creates dirs.
2. **Per-job env.** Inject `ANTHROPIC_API_KEY` from `instanceApiKeysService.getDecrypted()` (fail-fast if absent), set `HOME=<workdir>/home`, `CLAUDE_CONFIG_DIR=<workdir>/home/.claude`, `CLAUDE_PROMPT_CACHE_DIR=<workdir>/cache`, `cwd=<workdir>/cwd`.
3. **Permissions scope.** Default `dangerouslySkipPermissions=false` for hosted runs; if true, restrict via `--allowed-tools` + `--add-dir <workdir>` only. The flag default lives at execute.ts:286.
4. **Cleanup.** `try { ... } finally { fs.rm(workdir, { recursive: true, force: true }) }`. Hard kills are caught by the boot-time sweeper.

### 4.4 Workdir + Volume
3gb existing volume is enough for V1 (~30k runs at typical 100KB/run prompt+cache). Boot-time sweep handles orphans.

### 4.5 Resource caps
- VM bumped to `shared-cpu-2x`, `memory = "2gb"` (Council Gemini P2 + Codex P3).
- Dispatcher concurrency cap = 1 for hosted V1 (one active claude job at a time per machine). `claude` is heavy (~400MB RSS); 2gb leaves headroom for the express server + DB connections + a single subprocess.
- `min_machines_running = 1` (Council Gemini P1) — eliminates auto-stop-mid-job class of bug. Cost: ~$6.79/mo. Acceptable at $299+/mo product price.

### 4.6 Cost tracking
Already extracted in `execute.ts` from claude stream-json `result.cost_usd`. Persisted as `runner_jobs.costMicros` (1e-6 USD). Add: per-company aggregate via existing `cost_events` table (already in schema). Gracefully no-op if `cost_usd` is absent (Council Gemini P3 — Bedrock/future paths).

### 4.7 Migration
No DB migration. Two flag-gated code paths:
- `FOUNDEROS_HOSTED_AGENTS_ENABLED=1` (NEW) → server-side path for `anthropic_api` choice
- `FOUNDEROS_BYO_RUNNER_ENABLED=1` (EXISTING) → laptop runner for everything else

Both flags can be on simultaneously. The bootstrap-time decision is: hosted-and-anthropic_api → `claude_local`, otherwise → `byo_runner` (or `claude_local` for dev). This means:
- Existing prod customers → all on `byo_runner` already → unchanged.
- New customers signing up after the flip → `anthropic_api` → server-side claude_local.
- Self-hosted customers → can flip the flag in their own Fly toml.

---

## 5. Council findings → resolution map

| # | Finding | Severity | Resolution | Phase |
|---|---|---|---|---|
| C1 | Shared `HOME=/founderos` + shared `~/.claude` → cross-tenant leak | P1 (both) | Per-job HOME + CLAUDE_CONFIG_DIR + CLAUDE_PROMPT_CACHE_DIR | 1C |
| C2 | `applyKeyToEnv` mutates global process.env | P1 (Codex) / P2 (Gemini) | Delete `applyKeyToEnv`; inject via per-call env arg only | 1B |
| C3 | Auto-stop kills mid-job claude process | P1 (Gemini) | `min_machines_running = 1` | 1A |
| C4 | OOM at 1gb with concurrent jobs | P2 (Gemini) / P3 (Codex) | Bump to 2gb + concurrency cap = 1 | 1A |
| C5 | Key rotation while job queued → undefined | P2 (Codex) | V1: fail-fast at spawn if key missing/revoked. V2: per-job version pin | 1C |
| C6 | Orphaned workdir → volume fills | P3 (Gemini) | Boot-time sweep of `/founderos/agents/*` older than 24h | 2A |
| C7 | `--dangerously-skip-permissions` is too wide | P1 (Codex) | Default false for hosted; if true, restrict to workdir via `--add-dir` | 1C |
| C8 | Cost extraction crashes on absent `cost_usd` | P3 (Gemini) | Graceful null handling | 1C |

---

## 6. Out of scope (explicitly)

- **OpenAI / Gemini / Codex / Cursor adapters as server-side hosted.** They remain "coming soon" tiles in the onboarding wizard. Tonight's surface is `anthropic_api` only. Each future provider needs its own hardening pass (different CLI, different state dir, different cost extraction).
- **Horizontal scaling beyond a single Fly machine.** V1 is one machine, concurrency cap = 1. The PR-side dispatcher and the `runner_jobs` table can already scale to multiple workers — but the multi-machine concurrency story (job claim races, machine selection, cost-aware load balancing) is its own sprint.
- **Per-job version-pinned key snapshot.** V1 fetches the live key at spawn and fails fast on missing/revoked. V2 snapshots `credentialVersion` onto `runner_jobs` for replay-safe behavior.
- **Per-job cgroup isolation.** Fly machine-level limits + concurrency cap = 1 is enough for V1. cgroups land if/when concurrency > 1.
- **Multi-tenant per-Fly-app collapse.** Hosted V1 is one Fly app per customer (matches current `fly-provision.sh`). Multi-tenant single-app is a separate ADR.
- **Anthropic Console / API console redirect for buyers without an account.** Onboarding asks for a key the founder already has. "I don't have one" surfaces a link to console.anthropic.com and a copy-paste guide.
- **`byo_runner` deprecation.** It stays in the codebase indefinitely as the self-hosted / privacy-first option. We do NOT migrate existing customers off it.

---

## 7. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Existing prod customers regress when we flip the new path | Low | High | Flag-gated. `FOUNDEROS_HOSTED_AGENTS_ENABLED=0` default in V1 PR. Flip after smoke-test on staging. |
| R2 | OOM on first hosted run despite 2gb bump | Med | High | Pre-merge load test with claude running 60s job + express server + 50 active connections. Memory ceiling = 1.6gb total. |
| R3 | Per-job HOME isolation breaks claude OAuth flow (e.g. claude expects `~/.claude/.credentials.json`) | Med | Med | Hosted is API-key-only by design; OAuth is for `claude_local` developer mode. Document explicitly. Test: spawn claude with API key in env + isolated HOME → must complete a one-turn run. |
| R4 | `--dangerously-skip-permissions=false` breaks claude tool calls (file ops, shell) that templates rely on | Med | Med | Phase 3 smoke test with a real prompt template. If breaks, restrict via `--allowed-tools` + `--add-dir` instead of removing the flag. |
| R5 | Boot-time workdir sweep deletes an in-flight job's dir on restart | Low | High | Sweep filters by mtime > 24h. Active claude jobs are < 5min. |
| R6 | Anthropic key rotation during active job → mid-stream auth failure | Low | Med | Tolerable failure mode in V1: job fails with clean error, founder re-runs. V2: version pin. |
| R7 | Fly auto-suspend / proxy idle disconnect even with `min_machines_running=1` | Low | High | Verify with a 60-second sleep test in staging before merge. Fly docs: `min_machines_running=1` means at least one machine is always running (not idle-allowed). |
| R8 | Master key (`/founderos/secrets/master-key`) backup gap | Med | High (one-way door) | Out of scope for P0.1 itself; flag as a follow-up — losing the master key bricks every founder's stored API key. ADR-013 candidate. |
| R9 | `instance_api_keys` is single-row-per-family — concurrent founder onboarding could overwrite | Low | High | Post-V1 only when we go multi-tenant single-app. V1 is one app per customer. |
| R10 | Smoke test on staging Fly app diverges from prod (different secrets, different DB) | Med | Med | Phase 3 includes a final probe against actual prod after deploy with a feature-flagged smoke account. |

P1 risks (R2, R3, R4, R7, R8) all have explicit mitigation in Phase 1-3. R8 is an ADR follow-up and does not block this sprint.
