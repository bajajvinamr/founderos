# FINAL-SPRINT-PRD — FounderOS to Handover-Ready

_Authored: 2026-05-09. Authoritative scope definition for S7 MVP. Sources: PHASE-S7-multi-cli-runner.md (council PASS WITH CONDITIONS 2026-05-07), ADR-012, design-partner-onboarding-kit.md, CONTINUE.md._

---

## 1. Top-Line User Value — What a Founder Does on Day 1

These are the 5 things a founder must be able to do end-to-end before handover is credible. Everything in this PRD maps back to one of them.

- **Sign up with Claude Code** — complete the onboarding wizard, have agents created with `adapter_type='claude_local'` and `execution_transport='local-runner'`, install the runner package, see the first agent task complete and appear in the inbox. This is the core retention path for the US/Anthropic-subscriber segment.
- **Sign up with Gemini CLI** — same onboarding flow, but pick Gemini. Free tier. No credit card required for the CLI. This unlocks the India wedge and every founder who won't pay Claude Pro. The buyer explicitly named this as the ICP-expansion lever.
- **Be told honestly what each CLI costs** — the UI renders friction-honest copy per CLI tile: price tier, install command, known limitations. Founders should not start onboarding on a CLI they can't afford or haven't installed.
- **Switch CLI per agent after onboarding** — a founder who started on Claude can move one agent to Gemini to cut costs, without re-onboarding. This is the ongoing retention mechanism once multi-CLI is live.
- **Know when their runner is connected** — the runner token liveness pill confirms the BYO runner is online before the founder triggers their first task. No silent "why isn't my agent running" confusion.

---

## 2. P0 / P1 / P2 Priority Cut

### P0 — Must ship pre-handover (every item is load-bearing for 1,000 founder signups)

**Story 1: Founder picks Claude Code → onboarding completes → first agent task runs → result in inbox.**

This is today's path. The S7.0 prerequisites (S7.0.1 `runner_jobs.adapter_type` column, S7.0.2 schema unlock, S7.0.4 cursor normalization) tighten the scaffolding without breaking existing behavior. S7.2 (executionTransport) reverses the `byo_runner` collapse safely. S7.1 (dispatcher) makes Claude the first explicit adapter instead of the hardcoded default. All of this must work before any launch.

CLIs required: `claude_local`. Adapters: `packages/adapters/claude-local` (already live), runner `packages/runner/src/adapters/claude.ts` (extracted from spawn.ts in S7.1).

**Story 2: Founder picks Gemini CLI → onboarding completes → first agent task runs → result in inbox.**

This is the new path. It requires S7.0.2 (onboarding API accepts `gemini_local`), S7.1 (dispatcher), S7.2 (executionTransport), S7.3 (gemini adapter wire), and S7.4 (onboarding UI shows Gemini tile). Without this story, the buyer cannot pitch the India/free-tier wedge. This is the single highest-ROI ticket in the sprint for the 1,000-founder goal.

CLIs required: `gemini_local`. Adapter: `packages/runner/src/adapters/gemini.ts` (new).

**Story 3: Onboarding UI shows honest friction per CLI tile.**

Two tiles for MVP: Claude Code ($20/mo Pro, most popular) and Gemini CLI (free tier, `npm install -g @google/generative-ai-cli`). All other CLIs hidden behind `FOUNDEROS_MULTICLI_BETA=1`. Founders who see wrong friction copy drop out; founders who see right copy self-select. This is S7.4.

**Story 4: Runner liveness pill visible before first agent task.**

The `runner_tokens.lastSeenAt` mechanism is live. The P0 requirement is that the onboarding wizard surface confirms runner connectivity before completion (via #100 validate-key into V2 wizard). PR #100 is already in CI — this ticket may already be done; verify on merge.

**Story 5: Fixture-based CI guard for both Claude and Gemini.**

If a future commit breaks either dispatch path, CI catches it before it reaches the buyer's production instance. S7.5. No real binary in CI — fixture-based as specified in the phase doc.

### P1 — Ship within 2 weeks of handover

- **S7.6 (Codex)** — OpenAI-subscriber segment. Second-highest market size after Claude+Gemini. Adapter package exists; wire it.
- **S7.7 (Cursor)** — Cursor-subscriber segment. Adapter package exists; cursor type normalization (S7.0.4) is P0 prerequisite for this.
- **S7.12 — Onboarding UI surfaces all 7 CLIs** — ungate `FOUNDEROS_MULTICLI_BETA` once S7.B ships. Required for "1,000 founders" from the full funnel; deferred from P0 because the India/US wedge (Claude+Gemini) is sufficient for the launch cohort.
- **S7.13 — Per-agent CLI swap** — post-onboarding adapter change. Required for the ongoing retention loop (founders switch CLIs based on cost/performance). Deferred from P0 because it doesn't block signup; it blocks week-2 retention.
- **6 deferred consumer wires from ADR-012 S6** — S6.6 UI bell + WS push, S6.6 Slack daily summary, S6.7 magic-link email, S6.7 /brief route consumption, S6.8 wizard rewiring, S6.4 embedder. Each is ~half-day; none require new schema.

### P2 — Ship within 6-8 weeks of handover

- **S7.8 (OpenCode)** — niche segment; adapter package exists.
- **S7.14 — Full smoke test suite + Claude-only gate removal** — good hygiene; not blocking 1,000 signups.
- **S7.0.3 Hermes policy ADR** — write the ADR (30 minutes); skip S7.15 unless buyer has partners using Hermes (they don't — cut for now).
- **"Help me choose" CLI modal (S7.12 optional feature)** — nice UX; not launch-critical.

---

## 3. Small-Ticket Breakdown for P0 Stories

Cross-referenced to existing phase tickets. New tickets marked **[NEW]**.

---

### S7.0.1 — `runner_jobs.adapter_type` column (EXISTING TICKET)

Already fully specified in the phase doc. No re-derivation needed.

Title: `feat(db): add adapter_type column to runner_jobs + enqueue + claim payload`
Founder-visible value: dispatching on the right CLI becomes structurally possible; Claude's current behavior unchanged.
Files: `packages/db/src/migrations/0105_runner_jobs_adapter_type.sql`, `packages/db/src/schema/runner.ts:129`, `server/src/adapters/byo-runner/index.ts:132`, `server/src/routes/runner.ts:303`, `packages/runner/src/api.ts:26`.
DoD: Migration applies clean, existing claim tests pass with adapter_type in fixture, round-trip assertion added.

---

### S7.0.2 — Extend onboarding schemas to all CLI choices (EXISTING TICKET)

Title: `feat(onboarding): extend API + UI schemas to accept all 7 CLI choices`
Founder-visible value: Gemini and other CLIs can be submitted through the onboarding flow without a 400 error.
Files: `server/src/routes/onboarding.ts:82`, `ui/src/components/onboarding/onboarding-types.ts:127`, `server/src/services/adapter-resolver.ts`.
DoD: POST with `adapterChoice: "gemini_local"` succeeds; POST with unknown value 400s; all 7 + skip accepted.

---

### S7.0.4 — Normalize Cursor adapter type to `cursor_local` (EXISTING TICKET)

Title: `chore(adapters): normalize cursor adapter type from "cursor" to "cursor_local"`
Founder-visible value: Internal cleanup; no direct founder impact. Prevents type mismatch bugs in S7.B.
Files: `packages/adapters/cursor-local/src/index.ts:1`, `packages/shared/src/constants.ts`, `packages/adapter-utils/src/session-compaction.ts:42`, `ui/src/adapters/adapter-display-registry.ts`.
DoD: `pnpm typecheck` clean; `pnpm -w run test` clean; no DB row migration needed (no prod cursor agents exist).

---

### S7.1 — Adapter dispatcher (EXISTING TICKET — KEYSTONE)

Title: `refactor(runner): extract adapter dispatcher + AdapterSpawnHandler interface`
Founder-visible value: Claude still works identically. Dispatcher is now the correct abstraction for all future CLIs.
Files: Refactor `packages/runner/src/spawn.ts`; new `packages/runner/src/adapters/claude.ts`, `packages/runner/src/adapters/index.ts`; edit `packages/runner/src/main.ts:21`.
DoD: Existing Claude E2E pins green; unknown adapter_type produces clear error in `runner_jobs.error_message`; council PASS before merge (as specified in phase doc).

---

### S7.2 — `executionTransport` signal + reverse `byo_runner` collapse (EXISTING TICKET)

Title: `feat(db): introduce execution_transport field + reverse byo_runner adapter collapse`
Founder-visible value: New onboarding correctly records which CLI the founder chose. Existing agents with `adapter_type='byo_runner'` continue to run.
Files: New migration `0106_execution_transport.sql`, `packages/db/src/schema/agents.ts`, `ui/src/pages/Agents.tsx:212`, `server/src/lib/byo-runner-flag.ts`, `server/src/services/adapter-resolver.ts`, `server/src/services/onboarding-bootstrap.ts:307`.
DoD: New onboarding with `adapterChoice: "gemini_local"` produces `adapter_type='gemini_local'` AND `execution_transport='local-runner'`; existing `byo_runner` agents run via legacy-fallback; `FOUNDEROS_BYO_RUNNER_ENABLED=0` path routes to `server-spawn`.

---

### S7.3 — Wire `gemini_local` adapter (EXISTING TICKET)

Title: `feat(runner): gemini adapter — dispatch, skill injection, exit-55 error, cleanup`
Founder-visible value: A founder with `npm install -g @google/generative-ai-cli` and a GEMINI_API_KEY can run their first agent task.
Files: New `packages/runner/src/adapters/gemini.ts`; edit `packages/runner/src/adapters/index.ts`; new `packages/runner/src/__tests__/adapters/gemini.test.ts` + fixture + skill-symlink test.
DoD: Fixture-based unit test green; skill symlinks created and cleaned up in test; exit code 55 maps to clear error message; registered in ADAPTER_HANDLERS.

---

### S7.4 — Onboarding UI: show Claude + Gemini tiles (EXISTING TICKET)

This overlaps with the currently held worktree `feat/s7-c1-provider-chooser-grid` and PRs #100 and #102.

Title: `feat(onboarding): surface Claude + Gemini tiles with friction-honest copy + hide others behind flag`
Founder-visible value: Founders see exactly what each CLI costs and how to install it before committing to a choice.
Files: `ui/src/pages/onboarding/*` (adapter-choice step), `ui/src/adapters/adapter-display-registry.ts`.
DoD: Claude tile shows "$20/mo Pro · most popular"; Gemini tile shows "free tier · India-friendly · `npm install -g @google/generative-ai-cli`"; other 5 hidden unless `FOUNDEROS_MULTICLI_BETA=1`; Playwright assertion that `adapterChoice: "gemini_local"` appears in onboarding POST body.

---

### S7.5 — E2E fixture-based CI guard (EXISTING TICKET)

Title: `test(e2e): add fixture-based multi-cli dispatch guard for Claude + Gemini`
Founder-visible value: CI catches regressions before they reach production. No founder impact until it saves them from a broken deploy.
Files: `e2e/tests/multi-cli.spec.ts` (new) or extend `critical-flows.spec.ts`; new `docs/runbooks/multi-cli-smoke.md`.
DoD: Test asserts dispatcher routes `gemini_local` to gemini handler (not claude); test asserts missing handler produces typed error; CI green; smoke runbook complete.

---

### [NEW] S7.N1 — Verify PR #100 onboarding validate-key wire (runner liveness in wizard)

PR #100 ("S7.A.0 onboarding wires validate-key into V2 wizard") is racing in CI. This is a QA ticket, not a code ticket.

Title: `qa: verify runner liveness pill surfaces in onboarding wizard post-#100 merge`
Founder-visible value: Founder knows their runner is connected before triggering first task. No silent "why isn't my agent running" confusion.
Files: `ui/src/components/onboarding/FounderOnboardingWizard.tsx` (read-only verify after #100 merges).
DoD: Playwright screenshot shows runner liveness state in the final wizard step; if #100 is missing this UI, add a single-line status indicator referencing `runner_tokens.lastSeenAt`.

---

### [NEW] S7.N2 — Resolve #91 rebase (S7.0 prereqs DIRTY)

PR #91 is flagged DIRTY — needs rebase before the S7.0 prerequisite chain can progress.

Title: `chore: rebase #91 (S7.0 prereqs) onto current main`
Founder-visible value: Unblocks the S7.0 ticket chain. No direct founder impact.
Files: Depends on conflict surface — likely `packages/db/src/migrations/` journal.
DoD: PR #91 CI green; no snapshot collisions per the Drizzle invariant (two feature branches adding migrations must preserve both `entries[]` items in `_journal.json`).

---

### [NEW] S7.N3 — Update design-partner-onboarding-kit.md for multi-CLI reality

The kit's Day 0 section at line 146 documents the adapter mismatch gotcha with `claude_local`. Once S7 ships, this section needs updating to reflect that Gemini is a valid path and the `byo_runner` collapse has been reversed.

Title: `docs(ops): update design-partner-onboarding-kit Day 0 section for multi-CLI`
Founder-visible value: The buyer's support team has accurate troubleshooting guidance when a design partner reports a broken Gemini run.
Files: `docs/ops/design-partner-onboarding-kit.md` (lines 140-148 specifically).
DoD: Day 0 "If it doesn't happen" section names both Claude and Gemini failure modes; references the `adapter_type` + `execution_transport` columns as the first debug signal.

---

## 4. De-scope Candidates — What to Cut from MVP

**Hermes adapter (S7.15) — CUT from MVP.**
S7.0.3 (write the ADR) is P2 work — 30 minutes to document the decision, not an engineering task. S7.15 (strip and externalize the built-in Hermes dependency) is a 3-day refactor that touches the plugin-manager surface. Zero buyer design partners are known to use Hermes CLI. Option C from the phase doc: defer to S8. The ADR should explicitly record this to keep AGENTS.md consistent with reality.

**Pi adapter (S7.9) — CUT from MVP, move to P2.**
`pi_local` is tagged "research-driven" in the S7.12 copy. No buyer partner mention. Adapter package exists; wire it when the beta flag unlocks (P2 / S7.D window). The effort is identical to Codex; the payoff is materially lower.

**OpenCode adapter (S7.8) — CUT from MVP, move to P2.**
Same reasoning as Pi. "Research-driven" per copy. No buyer mention. Package exists; defer until post-handover P2 window.

**S7.12 full 7-CLI onboarding UI — defer to P1.**
Showing all 7 CLI tiles in onboarding with the MULTICLI_BETA flag unset is a 2-hour UI change. Do it after S7.B ships (Codex + Cursor wired), not at launch. The buyer gets Claude + Gemini on day 1, which covers the primary ICP segments.

**S7.13 per-agent CLI swap UI — defer to P1.**
Load-bearing for week-2 retention but not for day-1 signup. The PATCH endpoint and agent-settings page change are independent; scope them into the first 2-week post-handover window alongside the 6 deferred S6 consumer wires.

**S7.14 full smoke test suite + Claude-only gate removal copy pass — defer to P1.**
The gate removal copy pass ("no 'Claude only' copy remaining") is 30 minutes. Bundle it with S7.12 when the full 7-CLI UI ships. The smoke test suite for Codex/Cursor/OpenCode/Pi needs those adapters wired first; it follows naturally.

**"Help me choose" modal (S7.12 optional sub-feature) — CUT entirely or P2.**
Two-question modal that recommends a CLI. Low signal: the friction copy on each tile already answers the question. If a founder can't pick between Claude and Gemini after seeing the tile copy, a 2-question modal won't convert them. This is scope creep because it adds UI complexity with uncertain conversion lift. Kill criteria: if >10% of beta signups get stuck on the CLI choice screen (measurable via drop-off analytics), add the modal.

**Codex Multi-CLI optional params guard (vinamr-invariants reference) — already handled in S7.6 spec.**
The invariant "do NOT pass `-a`/`-s` flags to Codex" is documented and the S7.6 ticket enforces it. Not a separate ticket; just ensure it's in the adapter's DoD.

---

## 5. Founder-Action Checklist (Vinamr's Hand Required)

These are one-way doors or human-gated operations. Engineering cannot execute them autonomously.

1. **Resolve PR #91 rebase (S7.0 prereqs DIRTY)** — the S7.0 ticket chain is blocked until this rebases clean. Required before any S7.0 ticket can merge. One-time git operation but must be done before the sprint makes progress.

2. **Branch protection switches** — 5 toggles in GitHub UI per `docs/ops/branch-protection.md` (post PR #65). Required so no accidental force-push to `main` after handover. Must be done before handing the repo to the buyer.

3. **Delete orphan `instance_admin` row in production DB** (Issue #66) — the synthetic `LOCAL_BOARD_USER_ID` row in `instance_user_roles` will silently report the instance as bootstrapped and block the first-admin-wins flow for design partners. One SQL DELETE via `fly ssh console`. One-way door: confirm you're deleting the right row before executing.

4. **Stripe live key flip** — full procedure in `docs/ops/design-partner-onboarding-kit.md §2`. Pre-flight checklist → `fly secrets set STRIPE_SECRET_KEY=sk_live_<...> STRIPE_WEBHOOK_SECRET=whsec_<...>` → verify webhook 200 → fire test charge + refund → enable billing gate. ONE-WAY DOOR. Buyer or Vinamr executes; not autonomous.

5. **`FOUNDEROS_BILLING_GATE_ENABLED=1` in prod** — `fly secrets set -a founderos FOUNDEROS_BILLING_GATE_ENABLED=1`. Do this AFTER 24h of clean test-mode Stripe webhook telemetry post-live-key flip. Flips behavior from soft-fail to hard-402 for all inactive subscriptions — one-way door on user experience.

6. **Resend paid tier upgrade** — the magic-link daily brief email (S6.7 consumer wire) and any outbound transactional email will hit Resend free tier limits at ~50 design partners/day. Upgrade before launch wave. Not blocking MVP; blocking at scale.

7. **GitHub Actions billing restoration** — CI has been broken since 2026-05-02 per ADR-012 standing decision #3. S7 requires CI gates for every PR in the 10-PR queue and all subsequent S7 tickets. The buyer's 1,000-founder wave will generate ongoing PRs; broken CI at handover means every subsequent commit ships without a safety net. Restore billing before handing over the repo.

8. **Rotate `SENTRY_AUTH_TOKEN`, `FLY_API_TOKEN`, `VERCEL_TOKEN` as GitHub secrets** — per CONTINUE.md standing decisions. Required for `release-main.yml` to deploy on merge. Without these secrets in GitHub, the CD pipeline fails silently and the buyer is stuck with manual deploys.

9. **S7.D.6 — 1-week production soak of migration 0110** — this is a calendar floor, not an action item. Once migration 0110 (`DROP TRIGGER` migration) lands in production, it cannot be dropped until 7 days of clean production data confirm the trigger is unused. Do not compress this window. Plan the handover timeline so the soak completes before the buyer's first design partner wave.

10. **Production smoke verification (manual)** — after S7.A merges and deploys, run the `docs/runbooks/multi-cli-smoke.md` runbook against `founderos.fly.dev` with a real Gemini CLI install. Confirm a real agent task completes end-to-end in production, not just in the fixture-based CI. Wire ≠ working.

---

## Success Criterion

Handover is ready when: (a) a founder can sign up, pick Gemini, install the runner, and see an agent result in the inbox without touching a terminal beyond `npm install -g @google/generative-ai-cli`; (b) the same path works for Claude Code; (c) the CI guard catches a regression if either path breaks; (d) the Stripe live key flip procedure has been executed and the billing gate is active; (e) the 1-week soak gate for migration 0110 has cleared.

The 1,000-founder goal depends primarily on (a) — Claude-only limits the addressable pool to Claude Pro subscribers. Gemini free tier is the unlock.

---

_This PRD is the scope contract for the S7 final sprint. Anything not in P0 above is explicitly not required for handover. Scope creep from P1/P2 into P0 delays the fixed calendar floor at S7.D.6._
