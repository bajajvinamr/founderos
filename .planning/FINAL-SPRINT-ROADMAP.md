# FounderOS — Final Sprint Roadmap (S7 → Handover)

_Created: 2026-05-09 · Authoritative scope after PM+EM consultation_
_Companion: `.planning/FINAL-SPRINT-PRD.md` (user-value lens) · This doc: engineering lens._

## Decisions locked in (2026-05-09)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | MVP CLI scope | **6-tile chooser**: Claude Code, Anthropic API, Gemini CLI, Google API, Codex CLI, OpenAI API | Buyer-named providers + the 3 CLIs founders are most likely to have. Drops Cursor/OpenCode/Pi/Hermes from MVP. |
| D2 | Hermes policy | **Defer entirely (Option C)** | Type slot stays registered, existing `hermes-paperclip-adapter` server dep stays. Post-handover ticket. |
| D3 | Council gate | **Skip on roadmap**, keep on S7.1 implementation | PM+EM converged independently on most points. Save council for code-time on the dispatcher keystone. |
| D4 | Sequencing | Solo-sequential default; **Phase 4 adapter handlers parallel-safe** in one Task dispatch | Honors discipline reset. Each handler = 1 new file + 1 line in registry — touch-isolated. |
| D5 | Wall-clock | **21-25 calendar days from today** (≈ handover Mon 2026-06-01) | Includes 7-day fixed soak floor. Best case 21, realistic 25. |

## 6-tile chooser → adapter implementation map

| # | Tile | Adapter | Auth mode | State today |
|---|---|---|---|---|
| 1 | Claude Code CLI | `claude_local` | `cli` | ✅ ships today (existing runner spawn) |
| 2 | Anthropic API | `anthropic_api` | `api` | ✅ validate-key endpoint shipped via #96 |
| 3 | Gemini CLI | `gemini_local` | `cli` | ⏳ package exists at `packages/adapters/gemini-local/`, handler not wired |
| 4 | Google API (Gemini API) | `google_api` | `api` | ❌ **does NOT exist yet — NEW package + handler** |
| 5 | Codex CLI | `codex_local` | `cli` | ⏳ package exists, handler not wired |
| 6 | OpenAI API | `openai_api` | `api` | ⏳ package scaffolded in #101 (in queue), handler not implemented |

**Net engineering work: 4 adapter handlers** (gemini-cli, codex-cli, openai-api impl, google-api new package).

## Sprint phases — milestones

| Phase | Wall-clock | Gate |
|---|---|---|
| 0 — Drain current 10-PR queue | 2–3 days | CI bottleneck, mechanical churn |
| 1 — S7.0 prereqs (migrations + Zod widening) | 1 day | After queue drains |
| 2 — S7.1 dispatcher keystone (split a/b/c) | 2 days | **/council gate at S7.1.b before merge** |
| 3 — S7.2 executionTransport migration + callsite migration | 1.5 days | After S7.1 lands |
| 4 — S7.B adapter handlers (4 in parallel) | 2 days | Worktree-isolated, single Task dispatch |
| 5 — S7.C 6-tile chooser UI | 1.5 days | Sequential after #100 lands |
| 6 — S7.5 E2E for Claude + Gemini (fixture-based) | 1 day | Manual smoke runbook for other 4 |
| 7 — **SOAK GATE** | **7 calendar days FIXED** | Cannot compress; clock starts when S7.5 lands |
| 8 — Handover prep + founder-action gates | 1 day | After soak passes |

## Detailed ticket breakdown

### Phase 0 — Drain queue (mechanical, no new tickets)

10 PRs in flight: #87 #88 #90 #93 #94 #99 #100 #101 #102 + rebase of #91 (DIRTY).
Each lands → others go BEHIND → `update-branch` cascade. ~10 min CI per cycle.
After all 10 land + #91 rebased and merged, main has migrations 0103→0104→0105→0106 contiguous and dispatcher v2 flag is live.

### Phase 1 — S7.0 prereqs

```
[S7.0.1] feat(db): add adapter_type column to runner_jobs
  Files: packages/db/src/migrations/0107_runner_jobs_adapter_type.sql + meta
         packages/db/src/schema/runner.ts
         server/src/adapters/byo-runner/index.ts
  Effort: M  Depends: queue drained, #91 merged
  Risk: Drizzle journal hand-write (vinamr-invariants — DO NOT auto-regen snapshot)

[S7.0.2] feat(api): widen onboarding adapter Zod enum to 4 adapters + auth_mode
  Files: server/src/routes/onboarding.ts
         ui/src/components/onboarding/onboarding-types.ts
         server/src/services/adapter-resolver.ts
         server/src/routes/__tests__/onboarding.test.ts
  Effort: S  Depends: S7.0.1

[S7.0.4] refactor: normalize cursor → cursor_local (foundation cleanup, even though Cursor is out of MVP)
  Files: packages/adapters/cursor-local/src/index.ts
         packages/shared/src/constants.ts
         packages/adapter-utils/src/session-compaction.ts
  Effort: S  Depends: S7.0.1 (CHECK constraint in same migration)
```

(S7.0.3 Hermes decision **resolved**: Option C — defer. No ADR needed for non-decision.)

### Phase 2 — S7.1 dispatcher keystone (split per EM recommendation)

```
[S7.1.a] refactor(runner): extract Claude logic into adapters/claude.ts (NO dispatcher)
  Files: packages/runner/src/spawn.ts (split — extract claude pieces)
         packages/runner/src/adapters/claude.ts (NEW)
         packages/runner/src/__tests__/adapters/claude.test.ts (NEW)
  Effort: M  Depends: S7.0.1, S7.0.4
  Risk: Test-fragility — preserve scripted-stream test fixtures bit-for-bit
  No behavior change. Pure refactor to prove the seam.

[S7.1.b] feat(runner): ADAPTER_HANDLERS registry + runAdapter dispatcher  ← /council gate
  Files: packages/runner/src/adapters/index.ts (NEW — registry)
         packages/runner/src/dispatcher.ts (NEW)
         packages/runner/src/__tests__/dispatcher.test.ts (NEW)
  Effort: M  Depends: S7.1.a
  Risk: Interface shape ships forever. /council before merge (30-min pass).
  Council surface: AdapterSpawnHandler interface (setupEnvironment, promptTransport, interpretExitCode)

[S7.1.c] refactor(runner): main.ts swap to dispatcher
  Files: packages/runner/src/main.ts:21
  Effort: S  Depends: S7.1.b
  Behavior preserved: missing-handler error path tested.
```

### Phase 3 — S7.2 executionTransport

```
[S7.2.a] feat(db): add agents.execution_transport column + backfill
  Files: packages/db/src/migrations/0108_execution_transport.sql + meta
         packages/db/src/schema/{agents,runner}.ts
  Effort: M  Depends: S7.1.c on main
  Risk: Drizzle journal — land 0107 fully on main before 0108 even branches.

[S7.2.b] refactor: migrate byo_runner literal callsites to executionTransport
  Files: ui/src/pages/Agents.tsx
         server/src/lib/byo-runner-flag.ts
         server/src/services/adapter-resolver.ts
         server/src/services/onboarding-bootstrap.ts:307  ← reverse the bug
  Effort: M  Depends: S7.2.a
  Risk: Behavior-preserving regression tests at every callsite or UI badges silently flip.

[S7.2.c] docs(adr): 015-execution-transport-vs-adapter-type
  Files: docs/adr/015-execution-transport-vs-adapter-type.md
  Effort: S  Depends: S7.2.b
```

### Phase 4 — S7.B adapter handlers (parallel-safe batch)

**Single Task dispatch with 4 worktree-isolated agents.** Each handler is touch-isolated: 1 new file + 1 registry line. The only conflict surface is `packages/runner/src/adapters/index.ts` — resolved by serializing the 4 final commits or accepting trivial 4-line registry merges.

```
[S7.B.gemini] feat(runner): gemini_local adapter handler
  Files: packages/runner/src/adapters/gemini.ts (NEW)
         packages/runner/src/adapters/index.ts (+1 line)
         packages/runner/src/__tests__/adapters/gemini.test.ts (NEW)
         packages/runner/src/__tests__/fixtures/gemini-stream-json-PINNED.txt (NEW)
  Effort: M  Depends: S7.1.c
  Risk: GEMINI_CLI_TRUST_WORKSPACE invariant + ~/.gemini/skills/ symlink cleanup test.

[S7.B.codex] feat(runner): codex_local adapter handler
  Files: packages/runner/src/adapters/codex.ts (NEW)
         packages/runner/src/adapters/index.ts (+1 line)
         packages/runner/src/__tests__/adapters/codex.test.ts (NEW)
         packages/runner/src/__tests__/fixtures/codex-stream-json-PINNED.txt (NEW)
  Effort: M  Depends: S7.1.c
  Risk: Optional --approval-policy / --sandbox params — vinamr-invariants flags arg-parse failure on these.

[S7.B.openai_api] feat(runner): openai_api adapter handler (implementation, package shipped via #101)
  Files: packages/adapters/openai-api/src/index.ts (FILL IN — was empty in #101)
         packages/adapters/openai-api/src/handler.ts (NEW)
         packages/runner/src/adapters/openai-api.ts (NEW — proxy/wrapper to package)
         packages/runner/src/adapters/index.ts (+1 line)
         packages/adapters/openai-api/src/__tests__/handler.test.ts (NEW)
  Effort: M  Depends: S7.1.c, #101 merged
  Risk: API rate limit handling (429 vs 529 ≠ Anthropic semantics). Streaming-vs-batch defaults.

[S7.B.google_api] feat(adapters): create google_api package + handler (NEW PACKAGE)
  Files: packages/adapters/google-api/package.json (NEW)
         packages/adapters/google-api/tsconfig.json (NEW)
         packages/adapters/google-api/src/index.ts (NEW)
         packages/adapters/google-api/src/handler.ts (NEW)
         packages/runner/src/adapters/google-api.ts (NEW — proxy/wrapper)
         packages/runner/src/adapters/index.ts (+1 line)
         packages/adapter-utils/src/session-compaction.ts (register type slot)
         packages/shared/src/constants.ts (add to AGENT_ADAPTER_TYPES)
         pnpm-lock.yaml
  Effort: L → split into [B.google_api.scaffold] (S) + [B.google_api.handler] (M)
  Depends: S7.1.c
  Risk: NEW package — touches lockfile + shared constants. Most cross-file risk of the four.
  Note: Use packages/adapters/openai-api/ as the template (just shipped via #101).
```

**Dispatch shape:** Single message with 4 Task tool calls (subagent_type: general-purpose, isolation: worktree). Each agent gets a self-contained brief with the exact files + the council-vetted AdapterSpawnHandler interface from S7.1.b. They run in parallel (~30-45 min), each commits to its own branch, opens its own PR. The 4 PRs land sequentially with trivial registry merges.

### Phase 5 — S7.C 6-tile chooser UI

```
[S7.C.1] feat(ui): provider chooser tile grid (6 tiles → 4 adapters + auth_mode)
  Files: ui/src/components/onboarding/ProviderChooser.tsx (already in worktree agent-a95f1a4...)
         ui/src/components/onboarding/ProviderTile.tsx (already in worktree)
         ui/src/components/__tests__/ProviderChooser.test.tsx (already in worktree)
         ui/src/components/onboarding/FounderOnboardingWizard.tsx
  Effort: M  Depends: #100 merged (rebase worktree onto post-#100 main first)

[S7.C.2] feat(ui): per-tile install/auth hint copy
  Files: ui/src/components/onboarding/ProviderTile.tsx (extend)
         ui/src/copy/provider-tiles.ts (NEW — single-source label/install/auth-hint per tile)
         ui/src/components/onboarding/__tests__/ProviderTile.test.tsx
  Effort: S  Depends: S7.C.1
  Note: CLI tiles show "install command" + "minimum version"; API tiles show "where to paste key" + link to vendor key page.

[S7.C.3] feat(ui): wizard step machine wires chooser → onboarding bootstrap
  Files: ui/src/components/onboarding/FounderOnboardingWizard.tsx
         ui/src/components/onboarding/steps/Step4Plugin.tsx (extend from #100)
         server/src/services/onboarding-bootstrap.ts
         server/src/routes/__tests__/onboarding-bootstrap.test.ts
  Effort: M  Depends: S7.C.1, S7.C.2, S7.2.b
```

### Phase 6 — S7.5 E2E (gates the soak clock)

```
[S7.5.a] test(e2e): multi-cli.spec.ts — Claude+Gemini fixture-based
  Files: e2e/tests/multi-cli.spec.ts (NEW)
         e2e/fixtures/cli-streams/{claude,gemini}-stream-json-PINNED.txt (NEW)
  Effort: M  Depends: S7.B.gemini, S7.C.3
  Risk: CI cannot install real Gemini CLI. Fixtures only. Capture from pinned versions; encode version in filename.

[S7.5.b] docs(runbook): multi-cli-smoke.md
  Files: docs/runbooks/multi-cli-smoke.md (NEW)
  Effort: S  Depends: S7.5.a
  Manual smoke procedure for Codex CLI / OpenAI API / Google API / Anthropic API. NOT in CI; lives as the buyer-handover check.
```

### Phase 7 — SOAK GATE (7 calendar days fixed)

No tickets. Observation-only. Must run with at least one design partner using non-Claude in production. Clock starts the moment S7.5.a lands on main with green CI.

### Phase 8 — Handover

```
[S7.D.6] revert: drop migration 0110 trigger after 7-day soak
  Files: packages/db/src/migrations/0111_drop_dispatcher_legacy_trigger.sql (NEW)
  Effort: S  Depends: 7-day soak passed

[S7.D.7] feat: remove FOUNDEROS_MULTICLI_BETA flag
  Files: ui/src/components/onboarding/FounderOnboardingWizard.tsx
         server/src/lib/env-validation.ts
         packages/runner/src/config.ts
  Effort: S  Depends: S7.D.6

[S7.D.8] docs: update design-partner-onboarding-kit.md with final 6-tile UX
  Files: docs/ops/design-partner-onboarding-kit.md
  Effort: S  Depends: S7.D.7
```

## Risk hot-spots

| # | Risk | Mitigation |
|---|---|---|
| 1 | S7.1.b interface ships forever (one-way door) | /council gate before merge. Ship S7.1.a first (claude extraction, no behavior change) to prove the seam. Bisects the risk. |
| 2 | Drizzle migration journal merge (0107, 0108) | Land 0107 fully on main before 0108 branches. Hand-write journal entries; don't let drizzle-kit auto-regen snapshots. |
| 3 | CI cannot install Gemini/Codex CLIs | S7.5.a is fixture-based. Real-CLI smokes go to `docs/runbooks/multi-cli-smoke.md` (manual, NOT CI). Capture fixtures from pinned CLI versions; quarterly re-capture cadence. |
| 4 | Soak gate is calendar-bound (cannot compress) | Start the clock the moment S7.5.a lands. Don't wait for S7.D.7/D.8 polish to begin soak. |
| 5 | google_api is the only NEW package — most cross-file risk | Use openai-api/ (shipped via #101) as the template. Split into scaffold ticket + handler ticket so PR-1 is small. |
| 6 | Embedded-pg singleton + parallel test runs | Per CLAUDE.md gotcha: tests touching event-ingest must call `initEventIngest(mockDb)` in beforeEach. Apply to S7.0.1 and S7.2.a test fixtures. |

## Sequencing rules

- **Default**: solo-agent-per-ticket, sequential landing. Each ticket ≤2h.
- **Exception**: Phase 4 (S7.B adapter handlers) — single message Task dispatch with 4 worktree-isolated agents. Genuinely safe because each handler creates 1 new file in `packages/runner/src/adapters/<cli>.ts` + 1 line in `index.ts`. Registry conflicts are trivial 4-way merges.
- **Council gate**: S7.1.b before merge (the dispatcher interface is the one-way door).
- **Worktree leak hygiene**: Per `vinamr-invariants.md`, `Agent({isolation: "worktree"})` does NOT 100% partition writes. Always `git diff --name-only HEAD` in main checkout before staging; `git restore` phantom changes; integration via PR not local file copy.

## Calendar plan

Working days only (excludes Sat/Sun for engineering — soak runs through weekends).

| Day | Date | Phase | Milestone |
|---|---|---|---|
| 1-3 | Sat 2026-05-09 → Mon 2026-05-11 | 0 | Drain queue + rebase #91 |
| 4 | Tue 2026-05-12 | 1 | S7.0.1 + S7.0.2 + S7.0.4 |
| 5-7 | Wed → Fri 2026-05-13/14/15 | 2 | S7.1.a → S7.1.b (council Thu) → S7.1.c |
| 8-9 | Mon → Tue 2026-05-18/19 | 3 | S7.2.a + S7.2.b + S7.2.c |
| 10-11 | Wed → Thu 2026-05-20/21 | 4 | 4 adapter handlers in parallel |
| 12-13 | Fri 2026-05-22 + Mon 2026-05-25 | 5 | S7.C.1 + S7.C.2 + S7.C.3 |
| 14 | Tue 2026-05-26 | 6 | S7.5.a + S7.5.b — soak clock starts |
| 15-21 | Wed 2026-05-27 → Tue 2026-06-02 | 7 | **SOAK GATE** (7 calendar days) |
| 22 | Wed 2026-06-03 | 8 | S7.D.6 + S7.D.7 + S7.D.8 + founder-action gates |

**Handover-ready: Wed 2026-06-03.** Practical buyer walkthrough: Mon 2026-06-08.

## Founder-action checklist (NOT engineering — Vinamr's hand on keyboard)

- [ ] Stripe live keys flip (one-way door per `docs/ops/design-partner-onboarding-kit.md`)
- [ ] `FOUNDEROS_BILLING_GATE_ENABLED=1` in prod via `fly secrets set`
- [ ] Branch protection (5 toggles per `docs/ops/branch-protection.md`)
- [ ] Resend paid tier
- [ ] DELETE production orphan `instance_admin` row (issue #66)
- [ ] Production smoke against handover URL with each of the 6 tiles
- [ ] DoubtBuddy walkthrough call

## Out of MVP scope (post-handover follow-up)

| CLI/feature | Why deferred | Re-add cost |
|---|---|---|
| Cursor CLI | Paid Cursor accounts, low ICP overlap | 1 day (handler only — package exists) |
| OpenCode CLI | Niche, research-driven (low confidence) | 1-2 days |
| Pi CLI | Niche | 1 day |
| Hermes adapter | Already works as built-in dependency; AGENTS.md compliance is technical debt | 0 days for status quo; 2 days if extracted to plugin (Option B) |
| S7.13 per-agent post-onboarding swap UI | "Recreate agent with different CLI" works for handover | 1 day |
| Full 7-CLI chooser polish | Only relevant if niche CLIs come back | 0.5 day |

## Companion artifacts

- `.planning/FINAL-SPRINT-PRD.md` — PM-side user stories, P0/P1/P2 cuts (paired with this doc)
- `.planning/PHASES/PHASE-S7-multi-cli-runner.md` (in PR #88) — original 35-ticket phase doc; this roadmap supersedes the scope decisions
- `docs/adr/012-mvp-cutover-doubtbuddy.md` — S6 cutover decision (predecessor)
- `docs/ops/design-partner-onboarding-kit.md` — buyer-facing handover surface
