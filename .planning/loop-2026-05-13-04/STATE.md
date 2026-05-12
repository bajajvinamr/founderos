# Autonomous Loop 2 — STATE (Phase 1 DONE)

_Active orchestrator: Opus 4.7. Started: 2026-05-12T22:10Z. Target: ~12h._
_Last update: 2026-05-13T04:35Z._

## Lifecycle

- status: **active** (Phase 2 dispatching)
- started_at: 2026-05-12T22:10Z
- hard_stop_at: 2026-05-13T10:10Z
- Loop 1 carryover: 12 PRs (#194-#205) awaiting human review — do not modify

## Loop 2 ticket totals

| Lane | Count | Council-gated |
|---|---|---|
| A — Adapter/runner | 12 | 2 (A03, A04) |
| B — Design | 22 | 0 |
| C — Product gaps + activation + competitive | 17 | 4 (C01, C04, C07, C10) |
| D — Smoke + E2E | 20 | 0 |
| E — Performance | 6 | 0 |
| F — Security | 4 | 1 (F02) |
| **Total** | **81** | **7** |

## Wave 1 (DONE) — 11 research outputs

All 11 returned in ~70min wall-clock. Findings consumed by Wave 1.5 synthesizer.
Original research files lost in worktree-leak sweep but summaries persist in orchestrator memory.

## Wave 1.5 (DONE) — Ticket synthesizer

Agent ac130c06a1feec558. Produced 81 tickets.

## Wave 2 Phase 1 (DONE 2026-05-13T04:30Z) — 6 unblocker PRs

All 6 PRs returned and opened:

| Agent | Ticket | Branch | PR |
|---|---|---|---|
| ad5143ebaba9faa6c | L2-F01 CSP registry.npmjs.org | loop-wave-2/l2-f01-csp-registry-npm | **#207** |
| a45c5a932b8af604e | L2-E01 mdxeditor lazy | loop-wave-2/l2-e01-mdxeditor-lazy | **#211** (-17.7KB entry, not 459KB; rollup hoists composeRefs) |
| a4eb848d81a4487d3 | L2-E03 robots/canonical | worktree-agent-a4eb848d81a4487d3 → loop-wave-2/l2-e03-robots-canonical | **#208** |
| a0519cff714e28c0c | L2-E04 viewport meta | loop-wave-2/l2-e04-viewport-scalable | **#206** |
| acba7ab51709e082f | L2-F03 ST-9 NULL audit | worktree-agent-acba7ab51709e082f → loop-wave-2/l2-f03-st9-null-semantics | **#210** |
| ae03ac136af671433 | L2-A01 DISPATCHER_V2 cleanup | loop-wave-2/l2-a01-dispatcher-v2-cleanup | **#209** |

## Wave 2 Phase 2 (DONE 2026-05-13T05:11Z) — 5 PRs landed (#212-#216)

| PR | Ticket | Notes |
|---|---|---|
| #212 | L2-D03 landing + health smoke | 4 assertions, live `founderos.fly.dev` 3.5s; Task #139 contract verified — `/api/health` returns exactly `{status, version}` |
| #213 | L2-D16 migration chain integrity | 9 assertions, 21ms; walked 106 journal entries (0→105); discovered Drizzle v7 has no `hash` at rest (runtime-stored in `__drizzle_migrations.hash`); dropped cosmetic `when`-monotonic check |
| #214 | L2-D04 unauth redirect | 6 assertions live; **architectural surface**: `/dashboard` now `<Navigate to=../today>`; BOARD_ROUTE_ROOTS = today/work/team/library; catch-all sits OUTSIDE CloudAccessGate (audit-P2) |
| #215 | L2-A02 codex environmentChecks | 3 honest-disable reasons (`codex_local_cli_not_found`, `codex_unconfigured`, `codex_missing_env`); 10 new unit tests, 22/22 adapter-package pass |
| #216 | L2-D17 tenant FK isolation | 100 tables walked; 12 user_id columns (8 FK+cascade, 4 allowlisted); **finding: no instance_id/tenant_id columns anywhere — FounderOS is single-instance today; the tenant loop is forward-guard for future multi-tenant migration** |

### Findings surfaced for follow-up
- **L2-F04 (new)**: Prod CSP missing `fonts.googleapis.com` in `style-src` — found by L2-D04's console-error filter. Single-line fix in `server/src/middleware/security-headers.ts` matching L2-F01's pattern.
- **Multi-tenant migration is unstarted**: User-FK + ON DELETE CASCADE is the current tenant-isolation mechanism. Any future tenant work needs its own ADR.

## Wave 2 Phase 3 (DONE 2026-05-13T05:32Z) — 4 PRs landed (#217-#220)

| PR | Ticket | Notes |
|---|---|---|
| #217 | L2-D20 security-headers shape | Captured prod CSP verbatim; canary correctly red-flags missing `registry.npmjs.org` until L2-F01 (PR #207) merges; spec excluded from synthetic monitor |
| #218 | L2-F04 CSP Google Fonts | Added `fonts.googleapis.com` to style-src + `fonts.gstatic.com` to font-src; discovered prod loads Inter + Instrument Serif + Fraunces + JetBrains Mono via `ui/index.html:20` |
| #219 | L2-D19 NotFound markup safety | Surfaced route-resolution-order subtlety: `:companyPrefix/*` claims single-segment unknowns before catch-all; NotFound only reachable for multi-segment paths; test armed-but-skipping, asset-failure check unconditional |
| #220 | L2-A07 adapter-registry contract | Walked 12 adapters; **found contract divergence: `gemini_api.execute` arity 2, `openai_api.execute` arity 1** (PR #198 added optional `apiKeyResolver?` to gemini but not openai); candidate for L2-A08 harmonization |

### Findings surfaced for follow-up
- **L2-A08 harmonize `apiKeyResolver?` across `*_api` adapters**: gemini/openai arity divergence is real, deliberate-or-accidental unclear; needs PR-author context
- **Adapter registry has 12 surfaces, not 4**: future contract changes must consider all 12 (claude/codex/openai/gemini/opencode/pi/cursor/gemini_local/openclaw_gateway/hermes/process/http)
- **`byo_runner` is correctly opt-in via FOUNDEROS_BYO_RUNNER_ENABLED**: registered at runtime in app.ts; default registry test correctly excludes it
- **Prod CSP captured as verbatim artifact**: includes Supabase, Sentry, Composio, Anthropic, Stripe origins; no `registry.npmjs.org` yet (pre-L2-F01 merge)

## Wave 2 Phase 4 (DONE 2026-05-13T05:55Z) — 4 PRs landed (#221-#224)

| PR | Ticket | Notes |
|---|---|---|
| #221 | L2-D24 request-context ALS pinning | 10 cases / 65ms; covers 5 scheduler boundaries (setTimeout, queueMicrotask, Promise.then, deep async chain, parallel-interleaved); ALS contract holds cleanly |
| #222 | L2-D25 events dedup_key NOT NULL | 7 assertions; disjunction `(NOT NULL) OR (NULLS NOT DISTINCT)` permits future evolution; current truth: NOT NULL is sole collision-safety mechanism |
| #223 | L2-D23 composio connectedAccountId | Type-level (4 conditional proofs in `composio-skill-bridge.contract.ts` under src/, not __tests__/ — caught by typecheck) + runtime (7 assertions); **bonus finding: `userId: ""` TODO at `content-publish-tick.ts:102`** |
| #224 | L2-D22 runner-auth lastSeenAt | 3 tests (1 positive + 2 negative regression guards); ~5ms fire-and-forget UPDATE latency observed |

### Findings surfaced for follow-up
- **L2-A10 audit composio job-caller userId for empty values** (from L2-D23) — `content-publish-tick.ts:102` passes `userId: ""` with a TODO; Composio v3 uses userId for per-user routing in OAuth/user-scoped tools

## Wave 2 Phase 5 (IN FLIGHT 2026-05-13T05:58Z) — 4 invariant-defense agents (S6 sprint canaries)

Each defends a CLAUDE.md-documented invariant from the S6.x sprint (2026-05-06).

| Ticket | Lane | Invariant defended |
|---|---|---|
| L2-D26 magic-link atomic single-use | D | `mlt_<48 hex>` tokens sha256-hashed at rest; `consume()` is a single conditional UPDATE (TOCTOU-safe under concurrent requests) |
| L2-D27 notifications dedupe behavior | D | `(user_id, kind, ref_kind, ref_id) WHERE read_at IS NULL` partial dedupe; markRead is tenant+user scoped; cross-user returns 404 not 403 |
| L2-D28 onboarding draft partial UNIQUE | D | partial UNIQUE on `(user_id) WHERE completed_at IS NULL`; permits re-onboarding after completion; `getOrCreate` handles race via try-insert → catch-on-conflict → re-read |
| L2-D29 company_memory.category CHECK | D | CHECK constraint enforces enum at DB (TS unions erase at compile time) |

## Phase 2 deferred (council-gated, dispatch only with user OK)

L2-A03, L2-A04, L2-C01, L2-C04, L2-C07, L2-C10, L2-F02

## Phase 3 candidates (post-Phase-2)

Lane B foundation L2-B02..L2-B22 (serialized 2-at-a-time to avoid package.json races)
Lane C product gaps L2-C02, C03, C05, C06, C08, C09, C11..C17 (non-council)
Lane A runner-package finishing L2-A05..A12

## Hard boundaries (carried — NON-NEGOTIABLE)

- ❌ Never push to `main`
- ❌ Never `--no-verify`, never `--skip-checks`
- ❌ Never `fly secrets set/unset`
- ❌ Never `fly deploy`
- ❌ Never modify Stripe / billing-gate flag
- ❌ Never `--admin` merge a PR with non-informational CI failures
- ❌ Never connect real OAuth from inside the loop

## Operational lessons from this loop

1. **Planning files MUST be committed**, not kept as untracked working-tree state. Worktree HEAD moves sweep untracked files.
2. **Worktree branch names are not contracts** — agents may self-rename to `worktree-agent-<id>`. Always resolve actual branch via `git worktree list` before referencing.
3. **The L2-F01 working-tree leak** is the documented vinamr-invariant about partial worktree isolation. Recovered via stash before any contamination.
4. **Subagent harness cannot persist arbitrary planning files** — synthesizer agent could not write README.md + BACKLOG.md to disk; orchestrator had to persist inline. The Wave-1.5 synthesizer's BACKLOG content lives only in the orchestrator's memory of the conversation. **This loop's 81-ticket list is therefore non-recoverable across compaction without re-running the synthesizer.**
5. **Bundle-savings estimates from ticket research are unreliable** — L2-E01 measured -17.7KB entry vs. the predicted 459KB. Rollup chunk-hoisting makes the actual graph different from the import-source visible at the file level. Validate with measured `gzip -c | wc -c` before claiming a perf win.
