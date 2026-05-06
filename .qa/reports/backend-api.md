# Agent Report: Backend/API

**Generated:** 2026-05-06
**Scope:** Backend correctness (auth, tenant isolation, agent roles, issue lifecycle, review/approval, pause/resume, billing/Stripe).
**Mode:** Read-only. No edits made. Findings are code-cited.

## Scope Reviewed

### Graph nodes
- `auth_actor_resolution`
- `tenant_isolation`
- `agent_credentials_roles`
- `issue_lifecycle`
- `review_approval`
- `pause_resume`
- `billing_stripe`

### Routes touched (representative)
- `/Users/vinamr/Projects/founderos/server/src/app.ts` (route mount + middleware chain)
- `/Users/vinamr/Projects/founderos/server/src/routes/index.ts`
- `/Users/vinamr/Projects/founderos/server/src/routes/agents.ts`
- `/Users/vinamr/Projects/founderos/server/src/routes/approvals.ts`
- `/Users/vinamr/Projects/founderos/server/src/routes/issues.ts`
- `/Users/vinamr/Projects/founderos/server/src/routes/billing.ts`
- `/Users/vinamr/Projects/founderos/server/src/routes/auth-webhook.ts`
- `/Users/vinamr/Projects/founderos/server/src/routes/resend-webhook.ts`
- `/Users/vinamr/Projects/founderos/server/src/routes/instance-invites.ts`
- `/Users/vinamr/Projects/founderos/server/src/routes/oauth.ts`
- `/Users/vinamr/Projects/founderos/server/src/routes/runner.ts`
- `/Users/vinamr/Projects/founderos/server/src/routes/workflows.ts`
- `/Users/vinamr/Projects/founderos/server/src/routes/companies.ts`
- `/Users/vinamr/Projects/founderos/server/src/routes/digest.ts`
- `/Users/vinamr/Projects/founderos/server/src/routes/secrets.ts`

### Middleware / services touched
- `server/src/middleware/auth.ts`
- `server/src/middleware/require-company-access.ts`
- `server/src/middleware/board-mutation-guard.ts`
- `server/src/middleware/runner-auth.ts`
- `server/src/middleware/error-handler.ts`
- `server/src/routes/authz.ts`
- `server/src/services/agents.ts`
- `server/src/services/approvals.ts`
- `server/src/services/subscription.ts`
- `server/src/services/magic-link.ts`
- `server/src/services/workflows.ts`
- `packages/shared/src/validators/agent.ts`
- `packages/shared/src/constants.ts`

---

## Top Findings

### Finding 1 — Agent self-PATCH bypasses pause/role/budget controls (state-machine + privilege)
- **Severity:** P0
- **Category:** Authorization / privilege escalation / state-machine bypass
- **Graph node:** `agent_credentials_roles`, `pause_resume`
- **Files (with line numbers):**
  - `server/src/routes/agents.ts:354-374` (`assertCanUpdateAgent` — lines 364: `if (actorAgent.id === targetAgent.id) return;`)
  - `server/src/routes/agents.ts:1892-2014` (`PATCH /agents/:id`)
  - `packages/shared/src/validators/agent.ts:74-83` (`updateAgentSchema` — accepts `status`, `role`, `budgetMonthlyCents`, `reportsTo`)
  - `server/src/services/agents.ts:310-381` (`updateAgent` — only blocks `terminated`/`pending_approval` transitions)
  - `packages/shared/src/constants.ts:26-34` (`AGENT_STATUSES` includes `active`/`paused`/`idle`/`running`/`error`)
- **What is wrong:** Any authenticated agent (with its own JWT or API key) can call `PATCH /api/agents/:id` against ITSELF and pass any field accepted by `updateAgentSchema`. The schema is built from `createAgentSchema.partial().extend({ status, spentMonthlyCents })`, so it accepts:
  - `status: "active"` — flips a `paused` agent back to active. The dedicated `/agents/:id/pause` and `/agents/:id/resume` routes are board-only via `assertBoard(req)` (lines 2017, 2040), but this PATCH path is wide open via the `actorAgent.id === targetAgent.id` early return at line 364.
  - `role: "ceo"` — promotes the agent to CEO role. `assertCanUpdateAgent` line 365 (`if (actorAgent.role === "ceo") return;`) then grants the same agent permission to mutate ALL OTHER agents in the same company.
  - `budgetMonthlyCents: <huge>` — unbounded budget self-grant. `spentMonthlyCents: 0` resets spend.
  - `reportsTo: <any uuid>` — re-parent itself in the org chart.
  - `adapterConfig` containing arbitrary env, instructions, etc. (some sub-keys gated by `assertCanManageInstructionsPath`, but most pass through).
  The service-layer `updateAgent` (services/agents.ts:318-328) only blocks the `terminated → *` and `pending_approval → !terminated` transitions; `paused → active` is wide open.
- **Why it matters:** The product promise (per `.qa/context-graph.json` `agent_credentials_roles.invalid_states`): "agent role = instance_admin or founder", "agent creates another agent", "credentials usable across companies". This finding allows a compromised or misbehaving agent to (a) ignore a founder's pause action — directly violating `pause_resume.critical_invariants`, (b) self-promote to `ceo` role to mutate sibling agents (council 2026-05-05/06 P1 BLOCK around autonomy was tightened on workflows but not here), (c) inflate its own spend cap, blowing the budget hard-stop.
- **User impact:** Founder pauses a runaway agent → agent un-pauses itself within 5s on next poll → continues to spend $/burn LLM credits / send customer-facing actions. Trust violation; budgetary impact; the dedicated `/pause` UI button is theatre.
- **Evidence (excerpt):**
  ```ts
  // server/src/routes/agents.ts:354-374
  async function assertCanUpdateAgent(req: Request, targetAgent: { id: string; companyId: string }) {
    assertCompanyAccess(req, targetAgent.companyId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");
    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== targetAgent.companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actorAgent.id === targetAgent.id) return;   // <-- self-PATCH always allowed
    if (actorAgent.role === "ceo") return;
    ...
  }
  ```
  ```ts
  // packages/shared/src/validators/agent.ts:74-83
  export const updateAgentSchema = createAgentSchema
    .omit({ permissions: true })
    .partial()
    .extend({
      permissions: z.never().optional(),
      replaceAdapterConfig: z.boolean().optional(),
      status: z.enum(AGENT_STATUSES).optional(),     // <-- accepts "active"
      spentMonthlyCents: z.number().int().nonnegative().optional(),
    });
  ```
- **Suggested fix:**
  1. Strip `status`, `role`, `budgetMonthlyCents`, `spentMonthlyCents`, `reportsTo`, `permissionLevel` from `req.body` when `req.actor.type === "agent"` BEFORE calling `svc.update`. Mirror the pattern at line 1901 (`if (hasOwn(req.body as object, "permissions")) { res.status(422)... }`).
  2. Better: split `updateAgentSchema` into `agentSelfPatchSchema` (no privileged fields) and `agentBoardPatchSchema` (full set), and pick the right one in the handler based on actor type.
  3. Backstop the service: in `updateAgent` (services/agents.ts:318), reject any `status` transition out of `paused` unless `actor.type === "user"` and not a self-PATCH. Reject `role` changes unless caller is board.
  4. Add a CHECK or trigger so `pausedAt IS NULL ⇔ status != 'paused'` to surface inconsistent states.
- **Test to add:**
  - `agents-self-patch-status.test.ts`: agent A paused by founder; agent A authenticates with its own key, calls `PATCH /agents/A {status:"active"}` → expect 403.
  - `agents-self-patch-role.test.ts`: agent A (role=engineer) calls `PATCH /agents/A {role:"ceo"}` → expect 403.
  - `agents-self-patch-budget.test.ts`: agent A calls `PATCH /agents/A {budgetMonthlyCents: 10_000_000}` → expect 403.
- **Logging/observability needed:** activity_log entry `agent.privilege_escalation_attempt` on every blocked self-PATCH; Sentry alert on burst.
- **Effort:** small (10–20 LOC + tests; localized to one route + one schema split).
- **Safe to fix now?** **Yes** — additive schema split is non-breaking; founder-board UI continues to work because it's not an agent actor.

---

### Finding 2 — `assertCanUpdateAgent` gives every CEO-role agent write access to every other agent in the company
- **Severity:** P1
- **Category:** Authorization scope creep
- **Graph node:** `agent_credentials_roles`, `tenant_isolation`
- **Files:**
  - `server/src/routes/agents.ts:354-374` (line 365: `if (actorAgent.role === "ceo") return;`)
  - `packages/shared/src/constants.ts:74-86` (`AGENT_ROLES` exposes `"ceo"` as an assignable agent role)
- **What is wrong:** `assertCanUpdateAgent` short-circuits when `actorAgent.role === "ceo"`. This means any agent the founder hires with role `"ceo"` (e.g. a CoS agent named "Chief of Staff" with `role: "ceo"`) can mutate ANY other agent — change its instructions, adapter, budget, even rotate its keys — without any further check. There is no tier of "I lead this department" — `role: "ceo"` is a globally-scoped agent superuser inside the company. Worse, combined with Finding 1, an agent can self-promote to `ceo` and cascade across the org chart.
- **Why it matters:** `agent_credentials_roles.critical_invariants` says "agent role cannot be promoted to admin via PATCH". This is the agent-level analogue: an agent role that grants company-wide agent-mutation rights, with no human approval gate to assign it.
- **User impact:** Single compromised CEO-role agent → instructs every other agent to leak data, rewrites every adapter config to point at attacker tooling. Blast radius == entire company's agent fleet.
- **Evidence:**
  ```ts
  // server/src/routes/agents.ts:365
  if (actorAgent.role === "ceo") return;
  ```
- **Suggested fix:** Replace the role-string check with an explicit permission grant (the `access.hasPermission(... 'agents:create')` pattern is already used on line 366 — extend it to a dedicated `agents:mutate` permission and require it explicitly). Alternatively, require both role AND `canCreateAgents` permission (currently only one is sufficient).
- **Test to add:** Two CEO agents in the same company; CEO-A calls `PATCH /agents/CEO-B {adapterConfig:{...}}` — expect 403 unless founder explicitly grants the permission.
- **Logging/observability:** Existing `agent.updated` activity log captures actor; add a flag `cross_agent_mutation: true` when actorAgent.id !== targetAgent.id.
- **Effort:** small.
- **Safe to fix now?** **No, gated** — would break any existing customer who hired a CEO-role agent expecting it to manage the team. Document migration first; ship behind a feature flag.

---

### Finding 3 — Standalone `/approvals/:id/approve` does not check that the approver is not the requester
- **Severity:** P1
- **Category:** Self-approval / four-eyes principle
- **Graph node:** `review_approval`
- **Files:**
  - `server/src/routes/approvals.ts:134-285` (`POST /approvals/:id/approve`)
  - `server/src/services/approvals.ts:102-169` (`approve` service)
- **What is wrong:** The approve route uses `assertBoard(req)` — which blocks `req.actor.type === "agent"` — but does NOT compare `req.actor.userId` to `approval.requestedByUserId` or `approval.requestedByAgentId`. A founder-board user can approve their own approval submission. More importantly, this pattern is the only route-level guard; the issue lifecycle's two-layer self-approval defense (verified in `server/src/__tests__/issue-execution-policy-self-approval.test.ts`) does NOT apply to the standalone `approvals` table (used for `hire_agent`, workflow-run gating, generic approvals).
- **Why it matters:** The product promise is human-in-the-loop oversight. For a single-founder install, founder-approves-own-ask is by-design. For a multi-board-user install (post-W2 multi-tenant), board user A cannot collude-approve their own work product. The graph node `review_approval` lists "agent cannot approve its OWN submission" as a critical invariant — at the route level this only holds because `assertBoard` blocks all agents, not because of an explicit check.
- **User impact:** In multi-board-user mode (which the codebase is wired for: `companyMemberships`, `instance_user_roles` model), one user can rubber-stamp their own hire-agent approval, bypassing co-founder review.
- **Evidence:**
  ```ts
  // server/src/routes/approvals.ts:134-145
  router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await requireApprovalAccess(req, id))) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const { approval, applied } = await svc.approve(
      id,
      req.body.decidedByUserId ?? "board",   // <-- TRUSTS req.body.decidedByUserId
      req.body.decisionNote,
    );
  ```
  Note also: `req.body.decidedByUserId` is trusted — a board user could pretend the decision was made by another user. Schema check on `resolveApprovalSchema` would fix; need to verify.
- **Suggested fix:**
  1. In approve handler: if `approval.requestedByUserId === req.actor.userId` OR `approval.requestedByAgentId` belongs to a board-user-owned agent, refuse. (Match the same logic for reject + request-revision.)
  2. Stop trusting `req.body.decidedByUserId`; use `req.actor.userId` directly.
  3. Add an instance-settings flag `requireFourEyesApproval` defaulting OFF for single-founder, ON when ≥2 board users exist.
- **Test to add:** Two board users U1 and U2 in the same company. U1 creates approval; U1 calls approve → expect 403 with `requireFourEyesApproval=true`. U2 calls approve → 200.
- **Logging/observability:** activity_log already captures `approval.approved`; add `same_user_approval: true` flag for forensic.
- **Effort:** small.
- **Safe to fix now?** Yes if behind feature flag.

---

### Finding 4 — `req.body.decidedByUserId` accepted at face value on approve/reject/request-revision
- **Severity:** P2
- **Category:** Data integrity / audit log forgery
- **Graph node:** `review_approval`, `audit_logs`
- **Files:**
  - `server/src/routes/approvals.ts:143-145, 297-298, 326-329` (decidedByUserId pulled from `req.body`)
- **What is wrong:** All three resolution endpoints (`approve`, `reject`, `request-revision`) take `decidedByUserId` from `req.body`. Schema is `resolveApprovalSchema` / `requestApprovalRevisionSchema` — would need to confirm that those schemas reject the field, but the route uses `req.body.decidedByUserId ?? "board"` so it's treated as known/trusted. A board user can claim "user-X decided this" in the audit row.
- **Why it matters:** `decided_by_user_id` is the audit field — if it's caller-attestable, the audit log is forgeable.
- **User impact:** In a multi-tenant install, a malicious board user can frame a peer for an approval decision. Audit forensics break.
- **Evidence:**
  ```ts
  const { approval, applied } = await svc.approve(
    id,
    req.body.decidedByUserId ?? "board",
    req.body.decisionNote,
  );
  ```
- **Suggested fix:** Use `req.actor.userId` directly; never accept `decidedByUserId` from the request body. Strip the field from the validator.
- **Test to add:** Board user U1 approves with `body: { decidedByUserId: "u2" }` → DB row should have `decidedByUserId = U1`.
- **Effort:** trivial.
- **Safe to fix now?** Yes.

---

### Finding 5 — Stripe webhook `companyId` is hardcoded to `FOUNDEROS_DEFAULT_COMPANY_ID` env or `"default-company"`; multi-tenant breaks silently
- **Severity:** P2 (P1 once multi-tenant ships)
- **Category:** Tenant isolation / billing
- **Graph node:** `billing_stripe`, `tenant_isolation`
- **Files:** `server/src/routes/billing.ts:206-208`
- **What is wrong:**
  ```ts
  const companyId =
    process.env.FOUNDEROS_DEFAULT_COMPANY_ID ?? "default-company";
  await ingestStripeEvent(event as unknown as StripeEventWithCreated, companyId);
  ```
  The Stripe webhook ingests every event into the canonical `events` table tagged with a single hardcoded companyId. Per the comment, "self-hosted single-tenant build" is the assumption. But MVP (per CLAUDE.md, ADR-012) is multi-tenant: each customer install has its own subscription, and Stripe events should map to the correct company via `customer.metadata.companyId` or a `stripe_customer → company` lookup. Today every Stripe event lands in one company's events stream, regardless of which tenant the customer belongs to. Tenant-A's billing events leak into Tenant-B's KPI dashboard.
- **Why it matters:** `tenant_isolation.product_promise` = "Nothing in Org A is visible, mutable, or guessable from Org B." Today, billing events from any org are reattributed to whatever `FOUNDEROS_DEFAULT_COMPANY_ID` points at.
- **User impact:** Wrong KPIs shown to founders; revenue misattribution; possible compliance issue if different orgs get to see each other's MRR.
- **Evidence:** comment at `billing.ts:65-68` confirms the limitation: "Multi-tenant builds will need to resolve via Stripe customer → company mapping."
- **Suggested fix:** Resolve companyId via a `stripe_customer_id → companyId` lookup table populated at checkout time. If lookup misses (legacy event), log a warning and skip ingest (don't fall back to default).
- **Test to add:** webhook with unknown `customer.id` should not write events to `default-company`.
- **Effort:** medium (needs schema column + checkout-flow plumbing).
- **Safe to fix now?** Yes — additive table; backfill via cron.

---

### Finding 6 — Direct `res.status(...).json({ error: ... })` responses bypass the central `requestId` envelope
- **Severity:** P3
- **Category:** Observability / error consistency
- **Graph node:** `observability_health`, `audit_logs`
- **Files:** widely (CLAUDE.md states this was closed in 2026-05-03 council Phase 0):
  - `server/src/routes/approvals.ts:62, 138, 291, 322, 348, 386, 397` (404 / "Approval not found")
  - `server/src/routes/agents.ts:55+` (55 lines per `rg -c`)
  - `server/src/routes/issues.ts` (31 occurrences)
  - `server/src/routes/issues-documents.ts` (21)
  - `server/src/routes/plugins.ts` (63)
- **What is wrong:** The central `errorHandler` (`server/src/middleware/error-handler.ts:39-42`) attaches `requestId` via `withRequestId`. Routes that return `res.status(404).json({ error: "..." })` directly bypass this — the response body has NO `requestId`, only the `x-request-id` HTTP header. CLAUDE.md says "Every API JSON error response now includes `requestId` as of 2026-05-03 council Phase 0" — this is partially true: the header is always present, but the JSON body is missing the field on direct-return paths.
- **Why it matters:** When a user pastes only the JSON body (which is what most consumers paste), the support engineer can't grep for it. The header is usually stripped by client logging.
- **User impact:** Triage friction. Not a security issue.
- **Evidence:**
  ```ts
  // server/src/routes/approvals.ts:60-66
  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });   // <-- no requestId
      return;
    }
    ...
  });
  ```
- **Suggested fix:** Replace direct returns with `throw notFound("Approval not found")` (already imported in errors.ts). Lint rule + codemod.
- **Test to add:** Hit any 404 path; assert response body includes `requestId`.
- **Effort:** medium (mass codemod across ~250 call sites).
- **Safe to fix now?** Yes — purely additive shape.

---

### Finding 7 — `instance_user_roles` membership lookup in `actorMiddleware` does NOT exclude `LOCAL_BOARD_USER_ID`
- **Severity:** P2 (risk hypothesis — hard to confirm without runtime trace)
- **Category:** Auth / first-user-wins integrity
- **Graph node:** `auth_actor_resolution`
- **Files:**
  - `server/src/middleware/auth.ts:37-54` (`fetchBoardActorRows` query)
  - `server/src/auth/post-signup-hook.ts` (LOCAL_BOARD_USER_ID definition)
- **What is wrong:** `fetchBoardActorRows(userId)` looks up `instanceUserRoles` and `companyMemberships` filtered by `eq(instanceUserRoles.userId, userId)`. The userId is the Supabase user uuid, so collision with `LOCAL_BOARD_USER_ID = "local-board"` is unlikely. CLAUDE.md states `LOCAL_BOARD_USER_ID` exclusion is enforced in `health.ts` after the 2026-05-03 fix, but `auth.ts:fetchBoardActorRows` does NOT add the same exclusion. If a Supabase install accidentally has a row with `userId = "local-board"` (e.g., a migration mistake or a test fixture polluting prod), every authenticated user who also has that row would inherit `isInstanceAdmin = true` based on it.
  This is a defense-in-depth gap rather than a confirmed bug — needs a fixture-collision audit. The graph node lists "first-user-wins promotion excludes LOCAL_BOARD_USER_ID synthetic principal" as a critical invariant.
- **Why it matters:** Privilege-escalation defense in depth. If someone seeds local-board into a hosted install (forgetting `deploymentMode === "local_trusted"` filter), every signup gets admin.
- **Evidence:**
  ```ts
  // server/src/middleware/auth.ts:38-43
  db.select({ id: instanceUserRoles.id })
    .from(instanceUserRoles)
    .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
    .then((rows) => rows[0] ?? null);
  ```
- **Suggested fix:** Add `ne(instanceUserRoles.userId, LOCAL_BOARD_USER_ID)` to every "is there an admin?" query that runs in non-local-trusted mode. Or: enforce via DB CHECK that `userId != 'local-board'` when `deployment_mode != 'local_trusted'`.
- **Test to add:** Seed `instance_user_roles {userId: 'local-board', role: 'instance_admin'}` in a non-local-trusted test; signup as a real user; assert `isInstanceAdmin: false`.
- **Effort:** small.
- **Safe to fix now?** Yes.

---

### Finding 8 — `req.actor` may be re-populated by `runner-auth.ts` AFTER `actorMiddleware` already ran, but ALS context update path differs (potential drift)
- **Severity:** P3 (code-smell / risk hypothesis)
- **Category:** Observability / correlation
- **Files:**
  - `server/src/middleware/runner-auth.ts:217-251`
  - `server/src/app.ts:208-222` (the post-actor `updateRequestContext` middleware)
- **What is wrong:** `actorMiddleware` runs FIRST on every request in app.ts, and the immediately-following inline middleware copies `req.actor` into the AsyncLocalStorage context. For runner endpoints, `runnerAuthMiddleware` then OVERWRITES `req.actor` with the runner identity — but this happens AFTER the ALS-update middleware has already fired, because `runner-auth.ts` is mounted at `app.use("/api/runner", runnerAuthMiddleware(db), ...)` (app.ts:287). The `runner-auth.ts` middleware does call `runWithRequestContext({...})` (line 243), but the comment at line 230-241 admits "if we're not running inside an existing context (test code path), open one" — it only updates `existing.actor` mutation-style, not via a fresh context. This works in practice but the actor on `req` and the actor on the ALS context could briefly disagree (e.g., for log lines emitted in pino-http after `actorMiddleware` set `type: "none"` but before runner-auth flipped it to `type: "runner"`). Not a correctness bug, an observability smell.
- **Why it matters:** Sentry breadcrumbs / pino mixin tags on early request log lines might mis-attribute. Hard to trace incidents.
- **User impact:** Low. Triage friction.
- **Suggested fix:** Move `runnerAuthMiddleware` to fire INSTEAD of `actorMiddleware` on the `/api/runner` prefix (currently both run). Or: in runner-auth, also call `updateRequestContext({ actor: ... })` to re-stamp the ALS.
- **Test to add:** Log line emitted before runner-auth runs vs after; assert actor.type matches by the time the log is flushed.
- **Effort:** small.
- **Safe to fix now?** Yes — single-file change.

---

## Things that CHECK OUT (verified clean)

For the caller's confidence, these areas were inspected and look correct:
- Magic-link `consume` (`services/magic-link.ts:167-226`) — atomic conditional UPDATE; no TOCTOU; sha256 at rest; timing-safe re-verify.
- Stripe `subscription.upserted` idempotency (`services/subscription.ts:80-117`) — correct `onConflictDoUpdate` target = `stripeSubscriptionId`; no duplicate rows on retry.
- Stripe webhook signature verification (`routes/billing.ts:165-195`) — uses captured `req.rawBody` from `express.json` verify hook before SDK construct.
- Resend webhook signature verification (`routes/resend-webhook.ts:227-259`) — Svix verify with rawBody; row-locked transaction for action update.
- Auth-webhook (Supabase) — fail-closed when secret unset; signature check before any state read; bootstrap deferred to first-authed-request (email-squatting defense).
- Runner-token auth (`middleware/runner-auth.ts`) — sha256 at rest, timing-safe compare, debounced lastSeenAt write, TTL gate.
- OAuth state — userId bound into signed state; callback enforces `req.actor.userId === payload.userId` before integration upsert.
- Workflow PATCH — `assertStrictCompanyMembership` (no instance-admin bypass for autonomy-sensitive writes).
- Issue lifecycle self-approval — two-layer defense pinned by `issue-execution-policy-self-approval.test.ts`.
- Tenant-id-from-body usages — every site (plugins.ts, access.ts) gates with `assertCompanyAccess(req, body.companyId)` before query.
- Composio cross-org leak — closed per CLAUDE.md (verified `composio-skill-bridge.ts` requires `connectedAccountId: string` per side-channel — not re-verified in this pass).

---

## Missing Tests

Beyond the per-finding tests above:

1. **Cross-actor-type matrix:** for every PATCH/POST mutation route, fire as (board-instance-admin / board-member / board-non-member / agent-same-company / agent-other-company / runner / unauthenticated). Assert each row's expected status. Today this is done ad-hoc per route.
2. **Schema-strip property test:** for every `validate(*Schema)` route that mutates a sensitive table, fuzz with extra keys (`role`, `companyId`, `pausedAt`, `decidedByUserId`, `id`, `createdAt`); assert they don't reach the DB.
3. **Activity-log integrity:** for every mutation, assert exactly one activity row is written and its `actorId === req.actor.userId` (not `req.body.decidedByUserId` or similar).
4. **State-machine pin tests on agents:** every `(currentStatus, requestedStatus, actorType, isSelfTarget)` tuple — assert allowed/denied. Currently only terminated/pending_approval are pinned.

---

## Recommended PR Slices

In priority order, smallest blast radius first:

1. **PR-1 (P0):** Strip privileged fields from agent self-PATCH (Finding 1). Tests + schema split. ~50 LOC, no migration.
2. **PR-2 (P2):** Stop trusting `req.body.decidedByUserId` on approval routes (Finding 4). ~10 LOC.
3. **PR-3 (P3):** Codemod direct `res.status(...).json({error})` to `throw httpError(...)` (Finding 6). Mass refactor, behind a single PR with grep-able diff.
4. **PR-4 (P1, gated):** Add `agents:mutate` permission and require it instead of `role === "ceo"` (Finding 2). Migration: backfill existing CEO agents with the permission.
5. **PR-5 (P1):** Four-eyes feature flag + self-approval guard on standalone approvals (Finding 3). Behind `requireFourEyesApproval` instance setting.
6. **PR-6 (P2):** Stripe `customer → company` resolution (Finding 5). Schema migration + checkout flow update.
7. **PR-7 (P2):** LOCAL_BOARD_USER_ID exclusion in `auth.ts` (Finding 7). Single-line fix + DB CHECK.
8. **PR-8 (P3):** `runner-auth` ALS re-stamp (Finding 8). Single-line fix.

---

## Summary

- **8 findings:** 1 × P0, 2 × P1, 3 × P2, 2 × P3.
- **Top concern (P0):** agent self-PATCH bypasses pause + role + budget controls (Finding 1). The dedicated `/agents/:id/pause` route is board-only, but PATCH `/agents/:id` lets an agent set `status: "active"` on itself, undoing a founder's pause action. Same path enables self-promotion to `role: "ceo"` and unbounded budget self-grant.
- **Most leverage:** PR-1 (Finding 1 fix) is small, additive, and closes the highest-impact escalation path. PR-3 (requestId codemod) closes the broadest observability gap.
- Other graph nodes (founder onboarding, frontend, deployment, audit_logs) not in scope for this report — flag for a sibling agent.
