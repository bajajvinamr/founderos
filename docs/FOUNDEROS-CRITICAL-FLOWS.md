# FounderOS Critical Flows

_Buyer-critical control map for the dream-state production-hardening run. Companion to `.qa/context-graph.json` (machine-readable) and `.qa/dream-state-scorecard.md` (progress)._

This is not exhaustive coverage. It maps the surfaces a buyer or founder touches in the first 60 minutes of using FounderOS, plus the safety invariants that keep the system from corrupting itself under hostile or buggy clients.

## Index

1. [Founder onboarding](#1-founder-onboarding)
2. [Auth / session / actor resolution](#2-auth--session--actor-resolution)
3. [Company / tenant isolation](#3-company--tenant-isolation)
4. [Agent onboarding / credentials / roles](#4-agent-onboarding--credentials--roles)
5. [Issue lifecycle](#5-issue-lifecycle)
6. [Issue checkout / execution locks](#6-issue-checkout--execution-locks)
7. [Review / approval / request-changes](#7-review--approval--request-changes)
8. [Goals · Projects · Inbox](#8-goals--projects--inbox)
9. [Agent heartbeat / run start](#9-agent-heartbeat--run-start)
10. [Budget policy / hard-stop](#10-budget-policy--hard-stop)
11. [Pause / resume controls](#11-pause--resume-controls)
12. [Audit / activity logs](#12-audit--activity-logs)
13. [Billing / Stripe](#13-billing--stripe)
14. [Frontend onboarding · dashboard · review UI](#14-frontend-surfaces)
15. [E2E critical flows](#15-e2e-critical-flows)
16. [Observability / health / diagnostics](#16-observability--health--diagnostics)
17. [Deployment / env / startup guards](#17-deployment--env--startup-guards)
18. [Security / privacy / log redaction](#18-security--privacy--log-redaction)

---

## 1. Founder onboarding

### Business logic

- Promise: a first-time founder can sign up, name their company, hire their first agent, and reach a working dashboard without leaving a half-built state behind.
- Actors: founder, system (Supabase auth + Fly bootstrap).
- Valid states: `signed_up → company_created → agents_provisioned → dashboard_first_paint`.
- Invalid states: orphan `instance_user_roles` row without a `public.user` mirror; agents provisioned but `company.id` failed to commit; founder lands on dashboard with zero agents and no recovery CTA.
- Critical invariants: post-signup mirror is idempotent; company creation + agent bootstrap is one transaction or fully reversible; first-user-wins promotion excludes the synthetic `LOCAL_BOARD_USER_ID`.

### Engineering logic

- Routes: `POST /api/onboarding/bootstrap`, `GET|PUT /api/onboarding/draft`, `POST /api/onboarding/draft/complete`, `POST /api/auth/webhook` (Supabase post-signup).
- Services: `server/src/services/onboarding-bootstrap.ts`, `onboarding-drafts.ts`, `auth/post-signup-hook.ts`.
- DB tables: `auth.users` (Supabase), `public."user"`, `instance_user_roles`, `company`, `company_membership`, `agent`, `onboarding_drafts`.
- Frontend: `ui/src/components/onboarding/FounderOnboardingWizard.tsx`, `Step1Founder` → `Step5Bootstrap`.
- Tests: `server/src/__tests__/onboarding*` (multiple); `tests/e2e/` onboarding spec.
- Activity log: `onboarding.started`, `onboarding.draft_saved`, `onboarding.completed`, `agent.hired`.
- Known issues: adapter mismatch — `onboarding-bootstrap.ts:201` hardcodes `claude_local` even when user picks `anthropic_api` (CLAUDE.md). Unrecoverable state if Supabase mirror fails mid-bootstrap (mitigated by post-signup hook + admin recovery CLI `pnpm founderos auth bootstrap-ceo`).

---

## 2. Auth / session / actor resolution

### Business logic

- Promise: every request resolves to exactly one actor (founder, agent, system, runner, or anonymous), with their tenant scope, before any query runs.
- Actors: founder (Supabase JWT), agent (per-agent JWT), runner (`fos_<32>` token, sha256-at-rest), board (`board_api_key`), system cron (`actor: { type: 'system' }`).
- Invalid states: actor resolved without companyId; agent JWT honored across companies; runner token reconstructed from DB; system cron carrying ambient request-context.
- Critical invariants: `runWithRequestContext` wraps every HTTP entry; cron-initiated work injects explicit system actor; ALS returns `undefined` outside requests (don't trust silent inheritance).

### Engineering logic

- Routes: `server/src/routes/authz.ts`, `auth-webhook.ts`, `runner.ts` (token issue/revoke).
- Middleware: `auth.ts` (Supabase JWT), `runner-auth.ts` (timing-safe compare + `lastSeenAt` heartbeat), `require-company-access.ts`, `request-id.ts` (writes `x-request-id`), `private-hostname-guard.ts`, `security-headers.ts`.
- Services: `magic-link.ts` (issue/consume `mlt_<48>` tokens; atomic single-use), `instance-api-keys.ts`, `board-auth.ts`.
- DB: `magic_link_tokens`, `runner_tokens`, `instance_api_keys`, `instance_user_roles`, `auth.users` ↔ `public."user"`.
- Risk hypotheses: agent JWT lacking companyId fingerprint; magic-link consume race between two simultaneous clicks (mitigated — single conditional UPDATE); runner token leak via `lastSeenAt` timing oracle.

---

## 3. Company / tenant isolation

### Business logic

- Promise: nothing in Org A is ever visible, mutable, or even guessable from Org B.
- Critical invariants: every query that reads or writes a tenant-scoped table includes `WHERE companyId = $1` resolved from the actor, not from the URL or body. URL companyId is checked against actor companyId, not trusted.
- Invalid states: route reads `companyId` from `req.params`, queries directly, returns 200 to a wrong-org actor; agent in Org A executes a Composio tool against Org B's connected account.

### Engineering logic

- Middleware: `require-company-access.ts` is the choke point; `board-mutation-guard.ts` blocks writes for read-only board credentials.
- Services: `composio-skill-bridge.ts:96-113` requires `connectedAccountId: string` (closed cross-org leak via PR #30). `composio-connection-resolver.ts` resolves per-org credentials before any tool invoke.
- Risk hypotheses: routes that bypass `require-company-access` (audit needed); routes that accept companyId in body without re-checking; service-to-service calls that drop the companyId scope.

---

## 4. Agent onboarding / credentials / roles

### Business logic

- Promise: founders create AI agents with bounded roles, scoped credentials, and revocable access; agents cannot exceed authority.
- Valid states: `created → provisioned → active → paused → terminated`.
- Critical invariants: agent role cannot be `instance_admin` or `founder`; agent credentials are scoped to a single `companyId`; revocation is immediate (next request rejected, in-flight work checkpointed); agent cannot create another agent.

### Engineering logic

- Routes: `agents.ts`, `agent-handoffs.ts`, `agent-reviews.ts`, `agent-permissions` indirectly via approvals.
- Services: `agent-permissions.ts`, `adapter-resolver.ts` (claude_local / anthropic_api / byo_runner branches), `agent-instructions.ts`, `default-agent-instructions.ts`, `hire-hook.ts`.
- DB: `agent`, `agent_api_keys`, `agent_config_revisions`, `agent_runtime_state`, `agent_task_sessions`, `agent_wakeup_requests`.
- Frontend: agent roster, hire wizard, agent profile view.
- Risk hypotheses: agent creating another agent through a chained Composio call; agent role-escalation via `PATCH /agents/:id` body (validate that `role` is not in the patch shape); revoked agent's existing JWT still valid until expiry.

---

## 5. Issue lifecycle

### Business logic

- Valid states: `triaged → assigned → in_progress → in_review → changes_requested → approved → done` (plus `archived`, `cancelled`).
- Critical invariants: every transition is logged; an issue cannot reach `done` without an `approved` review when policy requires it; assignment to a paused/terminated agent is rejected at write time.

### Engineering logic

- Routes: `issues.ts`, `issues-checkout-wakeup.ts`, `issues-execution.ts`, `issues-comments.ts`, `issues-attachments.ts`, `issues-feedback.ts`, `issues-documents.ts`.
- Services: `issues.ts`, `issue-approvals.ts`, `issue-assignment-wakeup.ts`, `issue-execution-policy.ts`, `issue-goal-fallback.ts`.
- DB: `issues`, `issue_*` family.
- Risk hypotheses: state machine bypass via direct PATCH to `status`; closing an issue that still has unresolved approvals; concurrent writes leaving stale state.

---

## 6. Issue checkout / execution locks

### Business logic

- Promise: only one agent can hold "active execution" on an issue at a time. Stale locks expire safely.
- Critical invariants: lock acquisition is atomic (DB-level); stale-lock takeover requires explicit timeout + heartbeat staleness check; lock release on agent crash is bounded (no permanent zombie locks).

### Engineering logic

- Routes: `issues-checkout-wakeup.ts`.
- Services: `heartbeat.ts`, `heartbeat-helpers.ts`, `heartbeat-run-summary.ts`, `local-service-supervisor.ts`.
- DB: `heartbeat_runs`, `heartbeat_run_events`, `agent_runtime_state`.
- Risk hypothesis: PID-based liveness (orphan-process detection) is unsafe across server restarts (per `vinamr-invariants.md`); Vinamr's prior failure mode applies here — verify the lock semantics use DB heartbeat lease, not pid liveness.

---

## 7. Review / approval / request-changes

### Business logic

- Promise: agents submit work; founders (or designated reviewers) approve, reject, or request changes; the work artifact does not advance without the approval decision being recorded with an immutable audit row.
- Valid states: review `pending → approved | rejected | changes_requested`.
- Critical invariants: agent cannot approve its own request (compare `approval.requestedByAgentId` vs `approval.resolvedByActor`); cross-company actor cannot review (companyId scope on read); request-changes returns the work to `in_progress` not `done`; every decision writes `activity_log` with reason and target.

### Engineering logic

- Routes: `approvals.ts` (`approve`, `reject`, `resubmit`, comments), `agent-reviews.ts`.
- Services: `approvals.ts`, `agent-reviews.ts`, `notifications.ts` (publish on decision).
- DB: `approvals`, `approval_comments`, `agent_reviews`.
- Activity events: `approval.created`, `approval.approved`, `approval.rejected`, `approval.changes_requested`, `approval.resubmitted`.

---

## 8. Goals · Projects · Inbox

### Business logic

- Promise: founders organize work into goals (outcome) and projects (scope of work). Inbox is the holding pen for unsorted actions/messages until they are converted to issues, dismissed, or archived.
- Critical invariants: cross-company filter on every list endpoint; archive is reversible; deletion is gated; converting an inbox item to an issue is idempotent (no orphan inbox row + duplicate issue).

### Engineering logic

- Routes: `goals.ts`, `projects.ts`, `inbox-dismissals.ts`, `issues.ts` (inbox-archive routes).
- Services: `goals.ts`, `projects.ts`, `inbox-dismissals.ts`.
- DB: `goals`, `projects`, `inbox_dismissals`, `issues` (inbox flag).

---

## 9. Agent heartbeat / run start

### Business logic

- Promise: agent runs are observable in real time, terminate cleanly on pause or budget exhaustion, and never orphan partial state.
- Critical invariants: heartbeat row created within ms of run start; pause signal observed within one heartbeat tick; run summary persisted on termination (success or failure).

### Engineering logic

- Routes: `issues-checkout-wakeup.ts` (wakeup endpoint), runner enqueue.
- Services: `heartbeat.ts`, `heartbeat-helpers.ts`, `heartbeat-run-summary.ts`, `issue-assignment-wakeup.ts`.
- DB: `heartbeat_runs`, `heartbeat_run_events`.
- Adapter: `byo_runner` (no-op spawn — execution in `@founderos/runner`); `claude_local`; `anthropic_api`.

---

## 10. Budget policy / hard-stop

### Business logic

- Promise: agents cannot consume LLM/API spend beyond their company's plan budget. New runs are refused at the gate; in-flight runs checkpoint and exit.
- Critical invariants: budget gate evaluated AT wake (`enqueueWakeup`) AND at the route layer (defense-in-depth, council #132); over-budget returns 402; budget incidents are auditable.

### Engineering logic

- Middleware: `billing-gate.ts` (opt-in via `FOUNDEROS_BILLING_GATE_ENABLED=1`).
- Services: `budgets.ts`, `subscription.ts`, `quota-windows.ts`, `costs.ts`, `cost_events`.
- DB: `budget_policies`, `budget_incidents`, `cost_events`, `instance_subscription` (unique on `stripeSubscriptionId`).
- Risk: gate is OPT-IN — if `FOUNDEROS_BILLING_GATE_ENABLED` not set in prod, no enforcement.

---

## 11. Pause / resume controls

### Business logic

- Promise: pausing an agent or company halts execution within one heartbeat tick. Resume restores the prior queue.
- Critical invariants: paused agent receives no new wakeups; paused company cascades to all agents; resume does NOT auto-replay missed cron windows (idempotent).

### Engineering logic

- Routes: `agents.ts` (pause/resume verbs), `companies.ts`.
- Services: `agents.ts`, `companies.ts`, `heartbeat.ts`.
- DB: `agent.pausedAt`, `company.pausedAt`.

---

## 12. Audit / activity logs

### Business logic

- Promise: every safety-relevant decision is replayable from `activity_log` with actor, target, action, result, reason, timestamp.
- Critical invariants: log writes are best-effort (do not block the user-facing operation) but durable (queue + retry on failure); secrets never present; redaction tested.

### Engineering logic

- Service: `activity-log.ts`, `activity.ts`, `audit-lineage.ts`.
- Routes: `activity.ts`, `audit-lineage.ts`.
- DB: `activity_log`, `notifications` (derived from log for some kinds).
- Events covered today: `onboarding.*`, `agent.hired/paused/resumed`, `approval.*`, `issue.*`, `integration.*`, `cost.*`, `auth.invite_consumed`. Gaps to verify: budget block, pause cascade, forbidden action attempt, runner token rotation, magic-link issuance.

---

## 13. Billing / Stripe

### Business logic

- Promise: founder's Stripe state determines plan, budget, and feature gates. Webhook events are idempotent. Plan changes are recorded with audit.
- Critical invariants: webhook signature verified BEFORE body parse (express raw body before `express.json()`); idempotency on `stripeSubscriptionId` (unique index); rotation of plan refreshes budget windows.

### Engineering logic

- Routes: `billing.ts`, `stripe-backfill.ts`.
- Services: `subscription.ts`, `stripe-client.ts`, `stripe-backfill.ts`.
- DB: `instance_subscription` (unique `stripeSubscriptionId`).
- Risks: signature verification regression if route order shifts; webhook replay creating dup rows if unique index dropped.

---

## 14. Frontend surfaces

### Onboarding wizard

- `ui/src/components/onboarding/FounderOnboardingWizard.tsx` — 5-step flow.
- States to verify: stuck-on-step network failure, draft resume, "company already exists" 409, supabase email-not-confirmed.

### Dashboard / Chief of Staff

- `ui/src/pages/Dashboard.tsx` — mounts `CapitalAllocationCard`, `CompanyPulseWidget`, `LiveCompanyHeartbeat`, `NotificationsBell` (top bar).
- States: zero agents, zero issues, zero notifications, zero integrations, all 401 (re-auth), 403 (no access).

### Issue detail / review UI

- Approve / Reject / Request changes UI maps to backend state. Disabled-state must reflect real authority (e.g., requestor cannot self-approve).

### Department consoles (Growth, Content, CRM, Finance, Ops)

- `ui/src/pages/DepartmentConsole.tsx` lazy-loads specialized consoles. Each console must handle empty/loading/error states.

### Goals · Projects · Inbox

- `ui/src/pages/Goals.tsx`, `Projects.tsx`, `Inbox.tsx`. Filter-by-owner/status/assignee on each.

---

## 15. E2E critical flows

- `e2e/playwright.config.ts` — Wave 23A critical-flows, prod-safe with `FOUNDEROS_E2E_PROFILE=public-only`.
- `tests/e2e/` — onboarding/signoff with local server.
- Critical flows the run must verify or document quarantines for:
  1. Onboard → company → first agent → first issue → approve.
  2. Magic-link daily brief consume.
  3. Approval reject/resubmit cycle.
  4. Pause cascade observed in UI within heartbeat tick.
  5. Budget hard-stop UI message when plan exhausted.

---

## 16. Observability / health / diagnostics

- `/api/health` ROOT — `{status, version}` only (closed 2026-05-06).
- `/api/health/bootstrap-state` — public, deployment + auth + bootstrap status.
- `/api/health/diagnostics` — admin-gated, deployment exposure + features + dev server.
- `/api/health/deep` — admin-gated, deep dependency probe.
- `/api/readyz` — public 200 ready.
- Sentry: every JSON error has `requestId`; tags include `requestId`, route, actor.
- `vinamr-invariants` reminder: cron ticks fall outside ALS — explicit `actor: { type: 'system' }`.

---

## 17. Deployment / env / startup guards

- Fly: `founderos.fly.dev`, region `lhr`, Managed Postgres `gjpkdonynwy0yln4`. `SERVE_UI=true` serves SPA.
- Single-origin: API + UI + WS on the same host (intentional, see CLAUDE.md).
- Env validator: must surface missing critical secrets at boot. Pre-traffic `release_command` for migrations.
- `OPENAI_API_KEY` should join the env validator (added embedder service references it; missing key falls back to local hashing — must be visible).

---

## 18. Security / privacy / log redaction

- Secrets never in logs/audit (test feasible: log-emit fixtures + redaction scrubber).
- Log-redaction scrubber covers: `Authorization` header, `x-supabase-*`, `mlt_*`, `fos_*`, `pcp_bootstrap_*`, OpenAI key prefix, Stripe `sk_live_*`, Anthropic key prefix.
- Path traversal: every route accepting filename/key params validated against allowlist.
- CSP / security headers: `security-headers.ts` middleware — must include connect-src for Supabase + Sentry + Stripe + OpenAI (when used) + Resend (webhook origin if any).
