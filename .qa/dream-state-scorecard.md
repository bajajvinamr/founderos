# FounderOS Dream-State Scorecard

_Generated 2026-05-06 by hardening run #1. Updated continuously._

Legend: `[ ]` open · `[x]` verified by test or browser flow · `[~]` partial · `[deferred: <issue/reason>]`

## Buyer Journey

- [ ] Founder onboarding browser flow tested end-to-end (signup → company → agents → first issue)
- [ ] Company creation atomic — partial-state corruption impossible (transaction boundary verified under failure injection)
- [ ] Onboarding error/retry surfaces a clear next action (not a silent half-state)
- [ ] Agent creation tested (UI + service + audit log)
- [ ] Work assignment tested (founder → agent + agent → agent handoff)
- [ ] Agent execution bounded (budget, pause, role permissions all enforce)
- [ ] Founder review/approve/reject/request-changes browser flow tested
- [ ] Audit trail visible to founder, explains who/what/why for every critical event

## Safety

- [ ] Tenant isolation tested everywhere a `companyId` appears in a route or query
- [~] Agent cannot self-approve — issue-lifecycle path covered (existing `issue-execution-policy-self-approval.test.ts`); standalone `/approvals/:id/approve` already board-gated by `assertBoard(req)` so agents physically cannot reach it (verified 2026-05-07)
- [x] **Agent cannot escalate to founder/admin role** — closed by PR-1 (commit `<pending>`). Self-PATCH `role` → 403. Test: `agents-self-patch-escalation.test.ts`. ADR: `docs/decisions/0001-agent-self-patch-privileged-field-denylist.md`.
- [x] **Agent cannot reset own budget / un-pause self / change own reportsTo / raise own permissionLevel** — same PR-1, same test file. 7 reject + 3 allow assertions covering the full denylist.
- [ ] Agent JWT with mismatched companyId is rejected
- [ ] Budget hard-stop tested — agent cannot start a new run when over policy
- [ ] Pause/resume tested — paused agent does not consume work
- [ ] Pause cascades — paused company halts all its agents
- [ ] Secret redaction tested — logs/audit never contain raw API keys, runner tokens, magic-link plaintext, Stripe secrets
- [ ] Destructive actions gated (deploy, migration, billing change, permission change)

## UX

- [ ] Empty states tested (no agents, no issues, no integrations, no notifications)
- [ ] Error states tested (network fail, 401, 403, 409, 500, 502)
- [ ] Loading states prevent double submit (mutation buttons disabled while pending)
- [ ] 401 → re-auth path; 403 → reason shown; 409 → conflict explained
- [ ] Disabled buttons map to backend rules, not just optimistic UI
- [ ] Visible next action when something fails (not "something went wrong")
- [ ] Onboarding recovery understandable (resume draft, retry, abandon)

## Observability

- [ ] `/api/readyz` returns 200 deterministically post-boot
- [ ] `/api/health` ROOT exposes only `{status, version}` (verified 2026-05-06)
- [ ] Startup env validation logs missing vars before serving traffic
- [ ] Background job (cron) failure is logged with structured fields + alerts
- [ ] `requestId` present on every JSON error response (verified 2026-05-03 council)
- [ ] Sentry tags include `requestId`, `companyId`, `userId`, `route`
- [ ] E2E artifacts (screenshots, video, trace) uploaded on failure
- [ ] CI signal trustworthy — no green-on-quarantined-failure

## Repo Health

- [ ] E2E critical flows green on a real browser run
- [ ] Known quarantines have linked issues + repro + removal criteria
- [ ] Audit CVEs (`npm audit`) triaged, P0 patched
- [ ] CodeQL findings triaged, P0 patched
- [ ] Schema-drift / migration-check green on every PR
- [ ] Bundle size <1.5 MB gzipped UI

## Hard-Stop Blockers (blocks the fix loop until resolved)

- [ ] **GitHub Actions billing exhausted since 2026-05-02** — repo-wide CI cannot run. Merge gates ("CI substantive checks pass") are unreachable. Deploy path is `deploy-prod.yml`. **Owner: human (billing).** No agent fix possible.
- [ ] **40-file uncommitted blob on `main`** (W1–W6 Wave work). Directive forbids mega-PRs. Must stage into 5–8 reviewable slices before any new fix can ship. **Owner: this run, but contingent on CI unblock for verification.**
- [ ] **`main` branch protection not enforced** per CONTINUE.md deferred list. Without it, the merge rules cannot be enforced even if CI runs.

## Confirmed Findings from Discovery Run (2026-05-07)

### P0 (1)
- [x] **PR-1 — CLOSED** — Agent self-PATCH escalation guard. Branch `fix/p0-agent-self-patch-escalation`. `assertNoPrivilegedSelfPatch` helper added to `agents.ts`; called before `assertCanUpdateAgent` in PATCH `/agents/:id` handler. 10 tests in `agents-self-patch-escalation.test.ts` (7 reject, 3 allow). Repo typecheck/lint/server-tests all green (2104 pass / 7 skip / 0 fail). ADR `docs/decisions/0001-agent-self-patch-privileged-field-denylist.md`. _Council pre-flight skipped per CTO call: 3-agent convergence on diagnosis + TDD-first design + conservative deny default + comprehensive test coverage; rationale documented in ADR._

### P1 (14, themed)
- [ ] **PR-2** — Bootstrap prefix-collision atomicity test failing (`__tests__/onboarding-bootstrap-atomicity.test.ts:380`).
- [ ] **PR-3** — Notifications dedup partial unique index missing from migration `0100`. Requires `/council`.
- [ ] **PR-4** — Invite consume + role grant non-atomic (`instance-invite.ts:153-194`).
- [ ] **PR-5** — Cron observability: 7 of 8 schedulers bypass `runInCronContext`; zero `captureException` in any cron file.
- [ ] **PR-6** — Audit log gaps: billing-gate 402, pause/resume/terminate, magic-link issuance/consume.
- [ ] **PR-7** — Secret-leakage hygiene: invite token plaintext logged at info (`instance-invites.ts:137`); pino redact array near-empty (`logger.ts:50`).
- [ ] **PR-8** — Onboarding wizard silent draft restore + bootstrap submit error swallows requestId.
- [ ] **PR-9** — Stale E2E specs against `/api/health` shape (`landing-to-dashboard.spec.ts:47-48`, `signoff-policy.spec.ts:118`).

### P2 (10, abbreviated)
- [ ] **PR-10** — 14+ enum-shaped TEXT columns lack CHECK constraints. Requires `/council`.
- [ ] **PR-11** — `OPENAI_API_KEY`, `RESEND_API_KEY`, Supabase keys absent from env validator + delete `refresh-lockfile.yml` master-branch dead code.

### Source artifacts
- `.qa/synthesis.md` — full P0/P1/P2 list with file:line evidence, attack chain for P0, recommended PR queue
- `.qa/reports/{backend-api,database-transactions,frontend-ux,security-privacy,observability-e2e,baseline-state}.md` — discovery agent outputs

## Open Decisions Surfaced (require human input)

- [ ] Should `FOUNDEROS_BILLING_GATE_ENABLED=1` be flipped on in prod, or remain soft-rollout? CLAUDE.md notes "Flip the flag in prod once Stripe webhook telemetry is clean."
- [ ] Are quarantined tests (e.g. `workspace-runtime.test.ts`) acceptable indefinitely, or do they get a removal date this run?
- [ ] What is the dream-state cutoff date? "buyer-handover ready" needs a timeline so this run knows when to stop.
