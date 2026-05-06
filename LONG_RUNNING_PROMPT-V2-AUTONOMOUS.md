# LRP V2 — Autonomous push-through to Sprint 6 + E2E + bug-fix

**Issued:** 2026-05-06 14:11 UTC by Vinamr (going away for a few hours).
**Authorisation:** "You have my permission for everything."
**Supersedes:** LONG_RUNNING_PROMPT-7DAY.md (original 7-day LRP) for the duration of this session.

---

## Mandate

> "Ensure the LRP works. Write new LRPs if needed. Ensure product completion till Sprint 6. Stop for NO blockers. Ask my advice at the end. Run E2E testing. Resolve all bugs."

The original 7-day LRP halted on irreversible one-way doors. THIS LRP narrows the halt criteria to a much tighter list and authorises everything else.

## Halt criteria (the ONLY stops)

Halt the loop ONLY for:

1. **Live Stripe key flip** — toggling `FOUNDEROS_BILLING_GATE_ENABLED=1` in prod. Charges real cards.
2. **Force-push to `main`** — explicit named CLAUDE.md guardrail; user permission still requires explicit override per name.
3. **`--no-verify` git commit** — explicit named CLAUDE.md guardrail.
4. **Real customer data destruction** — `DELETE FROM <table>` against prod, `DROP TABLE`, etc. Test DB drops are fine.
5. **DNS / domain transfer** — would require redirecting `founderos.fly.dev` traffic.
6. **Truly impossible blocker** — e.g., a required prod secret is missing AND no test/capture-mode fallback exists. In this case: log to MORNING-REPORT, schedule a wake to retry in 30min in case the env arrives, continue with the next ticket.

Everything else is GREEN-LIGHT. Specifically authorised:

- ✅ `git push origin <branch>` — pushing the working branch to remote
- ✅ `gh pr create` — opening pull requests
- ✅ `fly deploy --strategy immediate` — deploying to prod (CI is broken globally per CLAUDE.md, so direct deploy is the only path)
- ✅ Running E2E suites against staging or prod
- ✅ Installing packages with `pnpm add` when needed (mention in commit message)
- ✅ Generating new migrations for the prereqs / Sprint 5 / Sprint 6
- ✅ Pushing schema changes via `prisma migrate deploy` style flows
- ✅ Reverting bad commits via `git revert` (atomic per-commit reverts only)
- ✅ Editing config files including `vercel.json`, `fly.toml`, `Dockerfile`, `package.json`

## Scope to complete (in order)

### Phase A — Finish S4.8 prereqs (1 of 8 done)

#196 customer email suppression ✅ DONE (5 commits this session, 88 tests pass)

Remaining 7 prereqs from council 2026-05-06 #4 finding:

| # | Title | Touch |
|---|---|---|
| 197 | Email-wrapper at transport layer | New `services/transports/email-wrapper.ts`; per-tenant physical address; uneditable footer. |
| 198 | Typed `connectedAccountId` for churn-rescue | Tighten `composio-skill-bridge.ts` signature for the churn template path. |
| 199 | Per-tenant rate limit (50 runs/day) | New table or use existing `rate_limits`; gate workflow_run creation. |
| 194 | Approval state machine | `approveWorkflowRun` lifecycle: pending → approved/rejected → terminal. |
| 195 | Recipient materialization | Pre-compute recipient list at run-creation; reject empty / cross-tenant. |
| 192 | Idempotency keys | `workflow_runs.idempotency_key` migration + dedup. |
| 193 | PII allowlist | Cancellation-category allowlist for churn-rescue prompt. |

### Phase B — S4.8 churn-rescue implementation

`server/src/services/workflows/templates/churn-rescue.ts`. Atomic commits:
- Schema (workflow.config shape)
- Generation (LLM call with allowlisted categories only)
- Approval payload + connectedAccountId persistence
- Pre-send isSuppressed gate (uses #196)
- Email-wrapper integration (uses #197)
- Stripe coupon link generation
- Tests (template + state machine + cross-tenant)

### Phase C — Sprint 5 (Finance) — 10 tickets

Per `.planning/PHASE-S5-finance.md` (read at the start of phase). Likely tickets:
- Stripe webhook expansion (subscription updates, invoice events)
- Invoice ingest service
- Revenue dashboard surface
- Cost tracking (LLM tokens by tenant)
- MRR / ARR calculation
- Churn metric
- Refund handling
- Tax line items
- Currency handling
- Founder-facing finance UI

### Phase D — Sprint 6 (Ops + Polish) — 10 tickets

Per `.planning/PHASE-S6-*.md`. Likely:
- Sentry integration polish
- Health endpoint hardening
- Background job observability
- Founder-facing Inbox polish
- Goals UI
- Projects UI
- Settings UI consolidation
- Onboarding flow polish
- Empty-state handling
- 404 / error boundary surfaces

### Phase E — E2E testing

- `pnpm --filter @founderos/server exec vitest run` — full server suite
- `pnpm --filter @founderos/ui run test` — UI test suite
- E2E smoke against staging or `npm run dev` local origin
- Existing Playwright suites at `e2e/` and `tests/e2e/`
- Onboarding round-trip
- Auth round-trip
- Workflow create → run → approve → send (with capture transport)

### Phase F — Bug-fix resolution

For every E2E failure or test failure surfaced in Phase E:
- Root-cause to file:line
- Atomic fix commit
- Re-run the failing test
- If pre-existing breakage (e.g., commit `2db3d17` that I already flagged), document in MORNING-REPORT and either fix-forward or revert per minimal-diff principle

### Phase G — Final summary

Single end-of-session report with:
- All commits shipped
- All tests passing / failing (with reasons for any failing)
- Production deploy status
- Any decisions Vinamr should make (e.g., live Stripe flip, branch protection toggle)

## Pacing

- **Active chaining (mid-feature)**: ScheduleWakeup at 270s — keeps prompt cache warm, maximizes throughput.
- **Idle / waiting on external**: 1500s — reasonable cache miss with long-enough amortization.
- **Deploy / E2E run in progress**: 270s polling.
- **Truly nothing to do until external state changes**: 1800s with note in reason field.

## Memory hygiene per wake

Each wake should:
1. Append progress to MORNING-REPORT-2026-05-06.md (1-line per commit, batched if many)
2. Update this V2 doc with phase progress (✅ DONE markers)
3. Push commits to `origin/feat/s4.3-content-attribution` periodically (every 5-10 commits) so progress survives if the loop dies

## Exit conditions

Loop ends when ANY of:
- Phase G summary is written and posted (success path)
- 6 hours wall-clock elapsed (Vinamr's "few hours" upper bound; suggest he resume from MORNING-REPORT)
- An item from Halt Criteria is hit (rare; logged + summarised)

## Next-action (for THIS session, immediately on V2 commit)

1. Commit V2 mandate doc (this file)
2. Start #197 email-wrapper — design + impl + tests + commit
3. Push to remote
4. Schedule next wake (270s) for #198/#199 chain

---
**Authority footer:** This V2 mandate is in force until explicitly revoked. The cancellation phrases (per Vanta) "stop", "pause", "halt", "abort", "nevermind", "cancel that" still halt the loop.
