# Phase 2 — OpenHuman Port Plan

**Author:** Opus sub-planner (dispatched by Maestro Opus 4.7)
**Date:** 2026-05-16
**Project:** FounderOS (`/Users/vinamr/Projects/founderos`)
**Source repo (concepts only — not cloned):** https://github.com/tinyhumansai/openhuman

## TL;DR

Maestro suggested `TokenJuice → Routing → Memory Tree → MCP memory → Auto-fetch`. After codebase audit, **the recommended order is `Routing (P2) → TokenJuice (P1) → Auto-fetch (P5) → Memory Tree (P3) → MCP memory (P4)`** — routing must land first because every other port plugs into it. Two of the five ports need `/council` review before any code: **TokenJuice (silent-failure risk)** and **Memory Tree (architecture-touching, overlaps with existing `company_memory` table)**. **Port 4 (MCP memory server)** is recommended to be **descoped or merged into Port 3** — FounderOS already ships an MCP server at `packages/mcp-server/`, and a parallel memory-only MCP server is a poor fit.

---

## Current State (evidence)

### LLM call sites — 9 hardcoded model strings, zero routing layer
- `server/src/services/yesterday-summary.ts:51` → `claude-haiku-4-5-20251001` (cheap, lossy-OK summarisation)
- `server/src/services/conversation-extractor.ts:27` → `claude-sonnet-4-6`
- `server/src/services/onboarding-decisions.ts:21` → `claude-sonnet-4-6`
- `server/src/services/weekly-wrap-generator.ts:48` → `claude-sonnet-4-6`
- `server/src/services/agents/finance-scenario.ts:44` → `claude-sonnet-4-6`
- `server/src/services/agents/growth-suggester.ts:72` → `claude-sonnet-4-6`
- `server/src/services/agents/content-generator.ts:59` → `claude-sonnet-4-6`
- `server/src/services/cos/brief-prompt.ts:48` → `claude-sonnet-4-6`
- `server/src/jobs/daily-founder-brief.ts:559` → uses anthropic key directly

All 9 hit `https://api.anthropic.com/v1/messages` via raw `fetch` — no SDK, no abstraction layer. **This is the high-leverage hook for both Routing and TokenJuice.**

### Adapter contract (already shipped)
- `server/src/adapters/types.ts` → `ServerAdapterModule` interface
- `server/src/adapters/registry.ts:227` → `adaptersByType: Map<string, ServerAdapterModule>`
- Existing adapters: `claude-local`, `codex-local`, `cursor-local`, `gemini-local`, `gemini-api`, `openai-api`, `openclaw-gateway`, `opencode-local`, `pi-local`, `hermes-local`
- Routing strategy primitive: `server/src/services/adapter-resolver.ts:159` defines `DEFAULT_PREFERENCE` with `families: ["anthropic", "openai", "google"]` + per-family suggested models
- **Key insight:** adapters are oriented toward *agent execution* (long-running, session-based, run logs). The 9 service-level LLM calls (above) bypass the adapter system entirely. There is **no routing surface for service-level one-shot calls today.**

### Memory layer — already present, sophisticated
- `packages/db/src/schema/company_memory.ts`: pgvector(1536), `kind` enum (`weekly_summary | experiment_outcome | founder_note | milestone`), `category` enum (`decision | pattern | context | outcome`), TTL via `expiresAt`, CHECK-constrained at DB level (per CLAUDE.md note)
- `server/src/services/company-memory.ts`: full CRUD + idempotent weekly summary generation
- `server/src/__tests__/company-memory-agent-recall.test.ts`: agent recall path already shipped
- **Conclusion:** Memory Tree port must extend this surface (rollup levels: session → day → week → month), not replace it.

### MCP server — already shipped
- `packages/mcp-server/`: stdio MCP server exposing FounderOS API as MCP tools
- `packages/mcp-server/src/tools.ts`: tool definitions for issues, approvals, documents, goals
- **No memory tools yet.** A "memory MCP server" would either duplicate this server or extend it. Extending is the correct path.

### Refresh / polling — established pattern, lazy
- `server/src/services/cron.ts`: cron parser
- `server/src/lib/cron-tick.ts`: tick orchestrator
- Existing cron services: `daily-digest-cron.ts`, `decision-followup-cron.ts`, `slack-sync-cron.ts`, `linkedin-sync-cron.ts`, `notion-sync-cron.ts`, `hubspot-sync-cron.ts`, `weekly-wrap-delivery-cron.ts`, `posthog-poll.ts`
- Composio state pulled lazily on action — confirmed via `composio-connection-resolver.ts`
- **Auto-fetch loop port has a clean architectural fit:** new `composio-refresh-cron.ts` + `briefs-refresh-cron.ts` slot into the existing pattern.

### No existing token compression
- `grep tokenJuice|compressPrompt|context.*compress` returns zero hits. Greenfield.

---

## Port 1 (re-sequenced #2): TokenJuice — pre-LLM context compression

**Scope (in):** A single `compressContext(input: { messages, model, budget })` utility that runs before any of the 9 LLM call sites. Output: a compressed `messages[]` plus a `compressionMetrics` object (`{ inputTokens, outputTokens, compressionRatio, latencyMs }`). Mode: lossy summarisation of older turns + retention of recent turns; configurable `keepRecentTurns: number`.

**Scope (out):** No LLM-side caching (Anthropic prompt cache is a separate optimisation). No semantic deduplication beyond what summarisation naturally produces. No streaming compression — only batch.

**Acceptance criteria:**
1. `compressContext` returns ≥40% reduction in tokens on a 30K-token synthetic conversation (target: 80% per OpenHuman; minimum 40% to declare port a win).
2. End-to-end test: feed `compressContext` output into `yesterday-summary` Haiku call → output is semantically equivalent to uncompressed within a Levenshtein-distance / LLM-judged threshold (`/codex` adversarial check).
3. Disabling via env flag `TOKENJUICE_ENABLED=0` falls back to passthrough — bit-exact uncompressed messages, no overhead in hot path.
4. `compressionMetrics` written to a new `cost_events.metadata.compression` field for every call — enables ROI tracking.
5. Compression failure (LLM error, timeout) MUST passthrough uncompressed, not block. Logged as `tokenjuice_fallback`. Test: kill the upstream compressor mid-call → original request still completes.

**Files to create:**
- `server/src/services/token-juice/compress.ts` — the `compressContext` utility
- `server/src/services/token-juice/budget.ts` — token-counting + budget allocation (tiktoken or claude-tokenizer)
- `server/src/services/token-juice/index.ts` — public API
- `server/src/services/token-juice/__tests__/compress.test.ts`
- `server/src/services/token-juice/__tests__/passthrough.test.ts`

**Files to modify:**
- All 9 service call sites listed above — wrap their `messages` build with `compressContext({ messages, model, budget })`
- `packages/db/src/schema/cost_events.ts` — add `compression` jsonb field to `metadata`
- `server/src/middleware/security-headers.ts` — no change (still calling `api.anthropic.com`)

**Integration point:** wrap message-build in each service. Reference: `server/src/services/yesterday-summary.ts:80-120` (the `buildHaikuPrompt` site). Same pattern for all 8 others.

**Open questions (require user / council answer):**
- Q1: **Compression model**: Use Haiku for compression upstream of Sonnet? Or use a cheap model (gpt-4o-mini, gemini-flash) — risks cross-provider quality drift but cheaper. **Council Y/N needed before implementation.**
- Q2: OpenHuman's "80% cost cut" claim — is that net of the compression call itself? Need to verify before claiming the same in product copy.
- Q3: Should `keepRecentTurns` be model-aware (Sonnet gets 6 recent turns, Haiku gets 3)?

**Effort:** **M** (1-2 days). Touching 9 call sites is the bulk.
**Executor context budget:** ~80K tokens (must read all 9 call sites + cost_events schema + write 2 utility files + tests).
**Dependencies:** Routing (Port 2) **strongly recommended first** — TokenJuice should plug into the routing layer, not 9 individual call sites.

---

## Port 2 (re-sequenced #1, critical path): Model routing — task-based dispatch

**Scope (in):** A `routeLLMCall(task: TaskKind, input)` abstraction that maps task-class → model:
- `reasoning` → `claude-sonnet-4-6` (or `o3`)
- `fast` → `claude-haiku-4-5` (or `gpt-4o-mini`)
- `vision` → `claude-sonnet-4-6` with image content
- `cheap_summary` → `claude-haiku-4-5` (yesterday-summary)
- `narrative` → `claude-sonnet-4-6` (weekly-wrap, growth-suggester)

The 9 service-level call sites import `routeLLMCall(taskKind, { messages, ...})` instead of hand-rolling `fetch` to `api.anthropic.com`. Internally it dispatches via the existing `instanceApiKeysService` to pick the right family + key.

**Scope (out):** No replacement of the `ServerAdapterModule` system (which handles agent execution, not service calls). Routing is **service-call-only** — adapters keep their current role.

**Acceptance criteria:**
1. All 9 LLM call sites use `routeLLMCall(taskKind, …)` — `grep "api.anthropic.com" server/src/services/` returns 0 hits outside the routing module.
2. Routing decision is fully testable in isolation: `route('cheap_summary', input)` returns `{ family: 'anthropic', model: 'claude-haiku-4-5-20251001' }` deterministically given the default preference.
3. Per-task override via env (`FOUNDEROS_ROUTE_<TASK>_MODEL`) — useful for canarying gpt-4o-mini against haiku.
4. `cost_events` gets a `taskKind` field so dashboards can break spend down by task.
5. Failure mode: provider down → fall back through ordered family list (`anthropic → openai → google` per `DEFAULT_PREFERENCE`). Test: simulate 503 from Anthropic, assert OpenAI fallback fires.

**Files to create:**
- `server/src/services/llm-router/route.ts` — `routeLLMCall` + `TaskKind` enum
- `server/src/services/llm-router/providers/anthropic.ts` — extracted from current 9 call sites' shared code
- `server/src/services/llm-router/providers/openai.ts` — uses `@founderos/adapter-openai-api` underlying primitives
- `server/src/services/llm-router/providers/google.ts` — uses `@founderos/gemini-api` underlying primitives
- `server/src/services/llm-router/index.ts`
- `server/src/services/llm-router/__tests__/*` — routing, failover, override tests

**Files to modify:**
- All 9 LLM service files — replace ad-hoc fetch with `routeLLMCall`
- `packages/db/src/schema/cost_events.ts` — add `taskKind` column + migration
- `server/src/services/adapter-resolver.ts:159` — extend `DEFAULT_PREFERENCE` with per-`TaskKind` overrides

**Integration point:** `server/src/services/yesterday-summary.ts:51` (and 8 others). The Anthropic-fetch primitive is duplicated across all 9 files — extraction into the router is a refactor win independent of routing semantics.

**Open questions:**
- Q1: Should `routeLLMCall` go through `@founderos/adapter-openai-api`'s `execute` (designed for agent runs) or call OpenAI HTTP directly? Adapter `execute` is session-aware; service calls are stateless. **Strong recommendation: direct HTTP, mirroring current Anthropic pattern.**
- Q2: Cost accounting — `cost_events` per call or per task? **Council: per call, taskKind as tag.**

**Effort:** **M** (1-2 days). Refactor of 9 files + new utility + tests.
**Executor context budget:** ~100K tokens (read all 9 services + write 4 provider modules + router + tests).
**Dependencies:** None. **This is the critical path; everything else benefits from a stable LLM surface.**

---

## Port 3 (re-sequenced #4): Memory Tree — hierarchical summarisation

**Scope (in):** Extend `company_memory` with rollup levels: `level` enum (`session | day | week | month | quarter`). Daily cron rolls up sessions → day; weekly cron rolls up days → week; monthly cron rolls up weeks → month. Recent detail (last 7 days) preserved verbatim; older detail compressed via `routeLLMCall('narrative', ...)`.

**Scope (out):** No replacement of existing `kind` enum (`weekly_summary | experiment_outcome | founder_note | milestone`) — `level` is orthogonal. No retroactive backfill of historic memory rows on first deploy; cron picks up forward from the day it's enabled.

**Acceptance criteria:**
1. New `level` column on `company_memory`, NOT NULL with default `'session'`. Migration adds it + a CHECK constraint per the existing pattern (see CLAUDE.md note on `company_memory.category` CHECK).
2. Daily cron at 02:00 UTC: for every company with `level='session'` rows from the previous day, generate a `level='day'` rollup. Idempotent on (companyId, occurredAt date).
3. Agent recall ranks `level='session'` > `level='day'` > `level='week'` for the last 7 days; inverts for older windows. Falsifiable test: write 30 days of synthetic memory, query "what happened 3 weeks ago" → returns week-level rollup, not session detail.
4. Rollup compression metrics (count rolled up, tokens before/after) logged.
5. TTL preserved: when a session-level row has `expiresAt`, the day-level rollup keeps the earliest non-null `expiresAt` from its members.

**Files to create:**
- `server/src/services/memory-tree/rollup.ts` — the rollup primitives (day/week/month)
- `server/src/services/memory-tree/cron.ts` — daily/weekly/monthly tick
- `server/src/services/memory-tree/__tests__/rollup.test.ts`
- `server/src/services/memory-tree/__tests__/recall-precedence.test.ts`
- `packages/db/src/migrations/00XX_memory_tree_level.sql` — adds `level` column + CHECK

**Files to modify:**
- `packages/db/src/schema/company_memory.ts` — add `level` field
- `server/src/services/company-memory.ts` — extend recall to be level-aware
- `server/src/app.ts` — wire new cron alongside daily-digest-cron

**Integration point:** `server/src/services/company-memory.ts:57` is the service factory. Memory tree extends, not replaces.

**Open questions:**
- Q1: Does `level` make sense for `kind='founder_note'`? Founder notes are manual; rolling them up loses the user's voice. **Recommend: only roll up `kind IN ('weekly_summary', 'experiment_outcome', 'milestone')`** — `founder_note` always stays `level='session'`.
- Q2: Should rollup write a new row OR update an existing one? **Recommend new row** (immutable audit trail; old session rows can be soft-deleted via TTL).
- Q3: How does rollup interact with the existing `idx_company_memory_company_occurred` index? Need partial index `WHERE level = 'session'` to avoid 10x growth in index size.

**Effort:** **L** (multi-day). Migration + cron + recall changes + agent-recall tests.
**Executor context budget:** ~120K tokens.
**Dependencies:** Routing (Port 2) — uses `routeLLMCall('narrative', ...)`. Memory Tree without routing forces another hardcoded `claude-sonnet-4-6` site.
**`/council` required:** **YES.** Touches a CHECK-constrained schema, a CRDT-like accumulation flow, and the agent-recall path. Hard to reverse.

---

## Port 4 (re-sequenced #5, recommended SKIP-or-FOLD): MCP memory server (agentmemory)

**Recommendation: FOLD INTO Port 3.** Do NOT ship a separate MCP server.

**Rationale:**
- FounderOS already runs `packages/mcp-server/` (`stdio.ts` + `tools.ts`). Adding a second memory-only server doubles the operational footprint (two stdio processes, two configs, two auth surfaces).
- The right move: extend `packages/mcp-server/src/tools.ts` with 3 memory tools — `memory_recall`, `memory_remember`, `memory_forget`. They proxy to the existing `companyMemoryService` from Port 3.
- OpenHuman's `agentmemory` MCP server is a research-grade single-purpose process. FounderOS has a multi-tenant, auth-scoped MCP surface — the abstractions don't match.

**If folded, scope:** 3 new tools in `packages/mcp-server/src/tools.ts` + tests.

**Acceptance criteria (if folded):**
1. `memory_recall({ query, companyId, level? })` returns top-K memory rows.
2. `memory_remember({ companyId, body, category })` writes to `company_memory` via the existing service (NOT bypassing pgvector or CHECK constraints).
3. `memory_forget({ memoryId })` soft-deletes (sets `expiresAt = now()`).
4. All 3 tools tenant-scoped (companyId required, validated against caller's auth).
5. MCP tool definitions surface in the MCP schema dump (`stdio --list-tools`).

**Effort:** **S** (folded — half a day on top of Port 3).
**Executor context budget:** ~30K tokens.
**Dependencies:** Port 3.
**`/council` required:** **NO** (folded into Port 3, which is council-reviewed already).

---

## Port 5 (re-sequenced #3): Adaptive auto-fetch loop

**Scope (in):** New cron services that periodically refresh:
- `composio-refresh-cron.ts` — every 20 min, refreshes connection status for active Composio integrations (slack, gmail, github, googlecalendar) → writes to `composio_connections.lastCheckedAt`
- `briefs-refresh-cron.ts` — every 4 hours during work hours, regenerates `daily_briefs` for active founders (replaces lazy on-load generation)
- `okrs-refresh-cron.ts` — every 1 hour, recomputes OKR snapshots from underlying issue/metric state

**Scope (out):** No replacement of the existing `posthog-poll.ts`, `slack-sync-cron.ts`, etc. — they remain authoritative for their domains. This port adds **derived state refresh** (cached summaries, snapshots, status pings), not raw data sync.

**Acceptance criteria:**
1. Three new cron services registered in `server/src/app.ts` alongside `daily-digest-cron`.
2. Each follows the existing pattern: `start()`, `stop()`, `tick()` exposed for tests; bounded in-flight guard; idempotent.
3. Composio refresh: for each active connection in `composio_connections`, hit `/api/v3/connected_accounts/{id}` and update `lastCheckedAt + status`. Failure on one connection doesn't block others.
4. Brief refresh: only fires if the cached brief is >2 hours old AND the company has activity in the window. Avoids regenerating identical briefs.
5. Cost accounting: each refresh emits `cost_events` rows tagged `kind='auto_refresh'` so spend can be capped.

**Files to create:**
- `server/src/services/composio-refresh-cron.ts`
- `server/src/services/briefs-refresh-cron.ts`
- `server/src/services/okrs-refresh-cron.ts`
- Tests for each (`__tests__/`)

**Files to modify:**
- `server/src/app.ts` — wire the 3 new crons
- `packages/db/src/schema/composio_connections.ts` — add `lastCheckedAt` if missing
- `packages/db/src/schema/daily_briefs.ts` — add `refreshedAt`

**Integration point:** `server/src/services/daily-digest-cron.ts` is the reference implementation pattern. New crons clone its structure.

**Open questions:**
- Q1: 20 min is OpenHuman's cadence. For Composio it's appropriate (OAuth tokens expire). For briefs, 4 hours feels right; for OKRs, 1 hour. **Confirm cadence with user — these are product decisions.**
- Q2: Should auto-refresh be per-company opt-in (a setting toggle), or instance-wide? **Recommend per-company opt-in** to avoid surprise spend; default OFF for the soft rollout.
- Q3: Composio API rate limits? Need to confirm before turning a 20-min loop loose across N companies.

**Effort:** **M** (1-2 days). Three crons + tests + 2 schema migrations.
**Executor context budget:** ~70K tokens.
**Dependencies:** Routing (Port 2) — `briefs-refresh-cron` calls into `routeLLMCall('narrative', ...)`. **Memory Tree NOT a dependency** — brief refresh writes its own `daily_briefs` rows independently.

---

## Recommended sequencing (re-ordered from Maestro's input)

```
P2 (Routing)  ──►  P1 (TokenJuice)  ──►  P5 (Auto-fetch)  ──►  P3 (Memory Tree, with P4 folded in)
   M, 1-2d         M, 1-2d                M, 1-2d                L, 3-4d
```

**Rationale for re-ordering vs. Maestro's `1→2→3→4→5`:**

1. **Routing first.** Maestro put TokenJuice first because it's highest ROI. Correct on ROI, wrong on order. TokenJuice modifies all 9 LLM call sites; if Routing follows, those 9 sites get touched twice. Doing Routing first means TokenJuice plugs into one routing layer, not 9 hand-rolled fetches. Net saved effort: ~30% on TokenJuice.

2. **TokenJuice second.** Highest cost-saving impact, lands cleanly on top of routing.

3. **Auto-fetch third.** Independent of memory work. Touches different files (cron-tick.ts, app.ts). Gives the user a visible "fresh data" win while bigger memory work lands.

4. **Memory Tree fourth, with MCP memory folded in.** Largest, most architecture-touching, requires `/council`. Park it for last so earlier ports inform what the memory layer needs (e.g., do TokenJuice metrics get stored as memory? Yes — informs the schema).

5. **Skip standalone MCP server.** Fold 3 tools into the existing `packages/mcp-server/`. Reduces operational surface; respects the multi-tenant auth model already in place.

---

## Council-review-required ports

| Port | Reason |
|---|---|
| **P1 (TokenJuice)** | Silent-failure risk (compression upstream of every LLM call). Need adversarial review of fallback path before any service uses it. |
| **P3 (Memory Tree)** | Architecture-touching: schema migration with CHECK, agent-recall semantic change, cross-cron-tick coordination. Hard to reverse. |

P2, P5 are mechanical refactors over established patterns — no council needed (but `/review` before merge as standard).

---

## Bad-fit assessment

| Port | Verdict | Why |
|---|---|---|
| TokenJuice | **Good fit** | Greenfield; 9 call sites are crying for a shared layer; cost savings real if claims hold. |
| Routing | **Good fit, foundational** | Existing adapter resolver has the primitives; just needs the service-call layer. |
| Memory Tree | **Good fit, extend not replace** | Existing `company_memory` is more sophisticated than OpenHuman's. Port = level enum + rollup crons. |
| MCP memory server | **BAD FIT — fold into existing MCP server** | FounderOS already has a multi-tenant MCP server; second one duplicates auth/process/config. |
| Auto-fetch | **Good fit** | Existing cron pattern; lazy Composio refresh is a real staleness pain. Per-company opt-in keeps spend bounded. |

---

## Summary table

| # | Port | Effort | Context | Deps | Council? | Verdict |
|---|---|---|---|---|---|---|
| P2 | Routing | M | 100K | — | No | **Land first** |
| P1 | TokenJuice | M | 80K | P2 | **Yes** | High ROI, gate on council |
| P5 | Auto-fetch | M | 70K | P2 | No | Independent, fast win |
| P3 | Memory Tree | L | 120K | P2 | **Yes** | Largest scope |
| P4 | MCP memory | S (folded) | 30K | P3 | No | **Fold into P3, don't ship standalone** |

Total executor budget if all four shipped: ~400K tokens — fits comfortably in 4 Sonnet sessions with `/compact` between each.

---

## Open questions for user (consolidated)

1. **TokenJuice compression model** — Haiku (same-provider), or gpt-4o-mini / gemini-flash (cross-provider, cheaper, drift risk)?
2. **TokenJuice ROI verification** — Is OpenHuman's 80% claim net of compression cost? Need source to validate.
3. **Routing per-task overrides via env** — OK to ship `FOUNDEROS_ROUTE_<TASK>_MODEL` as a runtime knob, or keep model selection compile-time?
4. **Memory Tree rollup of `founder_note`** — Confirm: skip rollup for `founder_note`, only roll up `weekly_summary | experiment_outcome | milestone`?
5. **Memory Tree rollup write semantic** — New row per rollup level (recommended) OR mutate existing rows (more compact)?
6. **Auto-fetch cadences** — 20 min for Composio, 4 hr for briefs, 1 hr for OKRs — confirm or adjust?
7. **Auto-fetch opt-in default** — Per-company opt-in (default OFF) for soft rollout, OR instance-wide ON?
8. **MCP memory server** — Confirm fold into existing `packages/mcp-server/` rather than shipping a separate process?
