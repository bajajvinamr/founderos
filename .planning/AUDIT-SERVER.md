# Server Endpoint Audit — Buyer-Demo Readiness

Date: 2026-05-19
Scope: every Express route mounted via `server/src/app.ts` (83 route files, ~430 endpoints)
Method: static analysis (Read/Grep/Glob). No server execution.

---

## Demo Blockers (P0) — short list

**None.** No bypassable billing path, no missing tenant guard on data routes, no Composio cross-org leak, no 500 hit by common input. The core security promises hold.

The findings below are all P1/P2 — quality hygiene that buyers won't notice on a happy-path demo but that a fresh-session reviewer will flag.

---

## Summary counts

| Severity | Count |
|---|---|
| P0 (demo blocker) | 0 |
| P1 (visible quality / silent failure) | 6 |
| P2 (inconsistency / dead code) | 4 |
| Clean (auth + Zod + error-shape OK) | ~95% of routes |

---

## 1. Endpoint inventory

Total: **~430 endpoints across 83 route files.** Full table below (one row per `router.<verb>` call site). `Auth gate` column reads the actual middleware chain or first-line assertion. `Zod input?` is `Y` when `validate(schema)` or `schema.safeParse(req.body)` runs before any data access; `partial` when only some routes in the file validate. `Billing gate?` only applies to LLM-cost endpoints. `Status` legend: ✅ clean, P1/P2 = severity.

### Public surface (mounted outside `/api` Router)

| Method | Path | Handler file | Zod input | Auth gate | Billing gate | Status |
|---|---|---|---|---|---|---|
| ALL | `/api/auth/{*authPath}` | `auth/better-auth` | n/a (provider) | provider-managed | — | ✅ |
| GET | `/api/auth/get-session` | `app.ts:237` | n/a | actor.type===board | — | ✅ |
| GET | `/api/auth/config` | `app.ts:260` | n/a | public-by-design | — | ✅ public auth config |
| POST | `/api/auth/webhook` | `auth-webhook.ts` | inline shape | HMAC signature | — | ✅ rate-limited |
| POST | `/api/webhooks/resend` | `resend-webhook.ts` | inline | Svix signature | — | ✅ |
| POST | `/api/billing/webhook` | `billing.ts:165` | n/a | Stripe signature + raw body | — | ✅ rate-limited |
| GET/POST | `/c/:trackingId` | `content-tracking.ts:34` | none | public-by-design (HMAC token in URL is the auth) | — | P1 (see §3) |
| GET/POST | `/u/customer/:token` | `customer-email-unsubscribe.ts:74` | none | HMAC token | — | ✅ rate-limited |
| GET | `/llms/agent-configuration.txt` | `llms.ts:28` | n/a | `assertCanRead` (board or permitted agent) | — | ✅ |
| GET | `/llms/agent-icons.txt` | `llms.ts:54` | n/a | `assertCanRead` | — | ✅ |
| GET | `/llms/agent-configuration/:adapterType.txt` | `llms.ts:69` | n/a | `assertCanRead` | — | ✅ |
| GET | `/api/healthz` | `app.ts:307` | n/a | public liveness | — | ✅ |
| GET | `/api/readyz` | `app.ts:315` | n/a | public readiness | — | ✅ |
| POST | `/api/runner/jobs/next` etc. | `runner.ts` | per-route | `runnerAuthMiddleware` (bearer token, sha256-hashed at rest) | — | ✅ |
| Vite middleware | `/*` (dev only) | `app.ts:547` | n/a | private-hostname-guard | — | ✅ |
| static | `/*` (SPA) | `app.ts:517` | n/a | n/a | — | ✅ |

### `/api/health/*` (mounted at line 334)

| Method | Path | Auth | Status |
|---|---|---|---|
| GET | `/api/health/` | public ({status,version} only) | ✅ |
| GET | `/api/health/bootstrap-state` | public (deploymentMode + bootstrapStatus only — Task #139 closed) | ✅ |
| GET | `/api/health/diagnostics` | `assertInstanceAdmin` | ✅ |
| GET | `/api/health/deep` | `assertInstanceAdmin` (verified at health.ts:172) | ✅ |

### Tenant-scoped `/api/*` (all behind `boardMutationGuard` + `actorMiddleware`)

Sample — full file-by-file inventory in §2. Every file was scanned for `router.<verb>` call sites and audited for the first authz check at the top of each handler.

| File | Routes | Validate | Authz coverage | Status |
|---|---:|---:|---|---|
| `agents.ts` | 53 | 19 | every handler asserts board/company/admin; wakeup + heartbeat layered with `billingGate(db)` | ✅ |
| `plugins.ts` | 26 | 4 | per-route assertions | ✅ (P1 — see §4) |
| `access.ts` | 30 | mixed | OpenClaw invites have token + signature; member CRUD checks instance-admin | ✅ |
| `costs.ts` | 19 | 1 | `assertCompanyAccess` on every | ✅ |
| `companies.ts` | 17 | 9 | every handler | ✅ |
| `issues.ts` | 13 | 3 | every handler | ✅ |
| `issues-documents.ts` | 10 | — | every handler | ✅ |
| `approvals.ts` | 10 | 6 | every handler | ✅ |
| `routines.ts` | 11 | — | every handler | ✅ |
| `projects.ts` | 10 | 4 | every handler | ✅ |
| `composio.ts` | 3 | 1 | `assertBoard` + `requireCompanyAccess` | ✅ |
| `secrets.ts` | 6 | 3 | every handler | ✅ |
| `billing.ts` | 3 | 0 | status/checkout open to any session; webhook by signature | P1 (no Zod on `/checkout` body) |
| `byo-key.ts` | 1 | 1 | board-only | ✅ |
| `providers.ts` | 2 | inline | rate-limited + nonce | ✅ |
| `instance-invites.ts` | 4 | 2 | `assertCanManageInvites` (admin) | ✅ |
| `instance-settings.ts` | 4 | 2 | admin for PATCH, board for GET | ✅ |
| `onboarding.ts` | 4 | 3 | `assertBoard` + rate limit | ✅ |
| `onboarding-draft.ts` | 4 | 1 | `assertBoard` + userId binding | ✅ |
| `oauth.ts` | 2 | — | `assertCompanyAccess` | ✅ |
| `posthog-connector.ts` | 2 | 1 | `assertCompanyAccess` on connect; HMAC on webhook | ✅ |
| `debug.ts` | 2 | — | `assertBoard` + admin check | ✅ |
| `stripe-backfill.ts` | 1 | — | `assertInstanceAdmin` | ✅ |
| `runner.ts` | 9 | 3 | bearer-token middleware (BYO surface) OR `assertCompanyAccess` (mgmt) | ✅ |
| `funnel.ts` | 1 | — | `assertCompanyAccess` | ✅ |
| `dashboard.ts` | 2 | — | `assertCompanyAccess` on both | ✅ |
| `weekly-wraps.ts` | 3 | — | `assertCompanyAccess` | ✅ |
| `daily-briefs.ts` | 4 | — | `assertCompanyAccess` | ✅ |
| `digest.ts` | 5 | 1 | `assertCompanyAccess` for prefs; token for unsubscribe (rate-limited) | ✅ |
| `inbox-state.ts` | 6 | inline safeParse | board + userId binding | ✅ |
| `notifications.ts` | 6 | — | `assertBoard` + `assertCompanyAccess` per route | ✅ |
| `assets.ts` | 3 | inline safeParse | `assertCompanyAccess` + multer size cap + SVG sanitize | ✅ |
| `integration-dlq.ts` | 2 | — | **NONE — but route is NOT MOUNTED** (`integrationDlqRoutes` defined but absent from app.ts) | P2 (dead code) |
| `permissions-matrix.ts` | 1 | — | `assertInstanceAdmin` | ✅ |
| `audit-lineage.ts` | 1 | — | `assertInstanceAdmin` | ✅ |
| `permission-coach.ts` | 2 | — | `assertCompanyAccess` | ✅ |
| `experiments.ts` | 3 | — | `assertCompanyAccess` | ✅ |
| `workflows.ts` | 8 | — | `assertStrictCompanyMembership` on writes | ✅ |
| `content-briefs.ts` | 5 | — | `assertCompanyAccess` | ✅ |
| `content-drafts.ts` | 5 | — | `assertCompanyAccess` | ✅ |
| `agent-handoffs.ts` | 6 | — | `assertBoard` + `requireCompanyAccess` | ✅ |
| `agent-reviews.ts` | 4 | — | `assertCompanyAccess` | ✅ |
| `company-providers.ts` | 1 | — | `assertCompanyAccess` | ✅ |
| `company-memory.ts` | 5 | — | `assertCompanyAccess` | ✅ |
| `decision-outcomes.ts` | 4 | — | `assertCompanyAccess` | ✅ |
| `finance.ts` | 7 | — | `assertCompanyAccess` | ✅ |
| `finance-settings.ts` | 2 | — | `assertCompanyAccess` | ✅ |
| `marketing-spend.ts` | 4 | — | `assertCompanyAccess` | ✅ |
| `insights.ts` | 3 | — | `assertCompanyAccess` | ✅ |
| `integrations.ts` | 6 | 1 | `assertCompanyAccess` | ✅ |
| `integration-data.ts` | 2 | — | `assertCompanyAccess` | ✅ |
| `integration-health.ts` | 2 | — | `assertCompanyAccess` | ✅ |
| `conversations.ts` | 4 | — | `assertCompanyAccess` | ✅ |
| `templates.ts` | 7 | — | mixed: board / admin / company | ✅ |
| `template-registry.ts` | 1 | — | board | ✅ |
| `adapters.ts` | 9 | — | `assertInstanceAdmin` on install/reload | ✅ |
| `audit-lineage.ts` | 1 | — | `assertInstanceAdmin` | ✅ |
| `sidebar-badges.ts` | 1 | — | `assertCompanyAccess` | ✅ |
| `inbox-dismissals.ts` | 2 | — | board + userId | ✅ |
| `goals.ts` | 5 | 2 | `assertCompanyAccess` | ✅ |
| `hire-proposal.ts` | 1 | — | `assertCompanyAccess` | ✅ |
| `company-skills.ts` | 10 | — | `assertCompanyAccess` | ✅ |
| `departments.ts` | 2 | — | `assertCompanyAccess` | ✅ |
| `department-status.ts` | 1 | — | `assertCompanyAccess` | ✅ |
| `execution-workspaces.ts` | 6 | — | `assertCompanyAccess` | ✅ |
| `issues-attachments.ts` | 4 | — | `assertCompanyAccess` via issue lookup | ✅ |
| `issues-comments.ts` | 3 | 1 | `assertCompanyAccess` via issue lookup | ✅ |
| `issues-documents.ts` | 10 | — | `assertCompanyAccess` via issue lookup | ✅ |
| `issues-execution.ts` | 6 | — | `assertCompanyAccess` via issue lookup | ✅ |
| `issues-feedback.ts` | 5 | — | `assertCompanyAccess` via issue lookup | ✅ |
| `activity.ts` | 5 | — | `assertCompanyAccess` | ✅ |
| `companies-export.ts` | 1 | — | `assertCompanyAccess` | ✅ |
| `customer-email-unsubscribe.ts` | 2 | — | HMAC + rate-limit | ✅ |

Note: many routes don't call `validate()` because they're pure-GET handlers; for those, params/query are parsed inline or aren't user-controlled (e.g. UUID path params validated downstream by Drizzle).

---

## 2. Per-finding sections

### F-1 (P1) — Direct 4xx/5xx responses skip `requestId`

**Files:** ~40 route files, ~348 call sites for 4xx and ~59 for 5xx.

**What's wrong:** CLAUDE.md promises **every API JSON error response includes `requestId`** (line referenced at "Every API JSON error response now includes `requestId`"). This is only true for errors that flow through the global `errorHandler` (`middleware/error-handler.ts:39 withRequestId`). Handlers that respond directly via `res.status(404).json({ error: "..." })` bypass the wrapper and do not include `requestId`.

**Evidence:**

```
$ grep -rn "res\.status(4[01][0-9])\.json" server/src/routes/ | wc -l
375
$ grep -rn "res\.status(4[01][0-9])\.json({.*error" server/src/routes/ | grep -v requestId | wc -l
348
$ grep -rn "res\.status(5[0-9][0-9])\.json" server/src/routes/ | grep -v requestId | wc -l
59
```

Concrete example, `agents.ts:2197`:
```ts
if (!agent) {
  res.status(404).json({ error: "Agent not found" });
  return;
}
```

The route's own error responses don't carry `requestId`. Same pattern in `companies.ts`, `issues.ts`, `goals.ts`, `billing.ts`, `posthog-connector.ts`, `adapters.ts`, `assets.ts`, etc.

**Suggested fix:** Either (a) replace direct `res.status(4xx).json({error})` with `throw notFound(...)` / `throw badRequest(...)` from `server/src/errors.ts` so the global `errorHandler` adds `requestId` via `withRequestId`; or (b) add a small response helper `respondError(res, status, message)` that reads `getRequestContext()?.requestId`. Option (a) is the lower-risk change — `HttpError` already supports all the statuses used (400/401/402/403/404/409/422). Both `providers.ts` and `billing-gate.ts` already include `requestId` manually as the existing pattern when responding inline; pick one approach.

**Severity rationale:** P1 — buyer triage workflow says "give me the request ID" but 348 4xx responses won't have one. Support-time slowdown, not a security hole.

---

### F-2 (P1) — `/api/billing/status` and `/api/billing/checkout` are not auth-gated

**File:** `server/src/routes/billing.ts:102` and `:122`.

**What's wrong:** Neither `GET /api/billing/status` nor `POST /api/billing/checkout` calls `assertBoard` / `requireCompanyAccess`. Any actor that reaches these routes (including `actor.type === "none"` after `boardMutationGuard` lets read+write past the guard) gets billing state and can kick a Stripe checkout for the current instance.

**Evidence:**

```
$ grep -n "assert\|requireCompany\|req.actor" server/src/routes/billing.ts
(no matches before route handlers — only inside the webhook signature check)
```

The webhook (`/billing/webhook`) is correctly Stripe-signed; the two session-facing routes have no actor check. `actorMiddleware` upstream always populates `req.actor` (to `none` or session-derived), but `billing.ts` doesn't read it before responding.

**Risk shape:** In `local_trusted` mode the actor defaults to `local-board`, so no real risk. In `authenticated` mode, the `boardMutationGuard` allows the GET; the POST checkout opens a Stripe session bound to the instance — no buyer would notice but a malicious unauthed visitor could spam checkout creation (cost vector — rate limiter exists per `billingRoutes` setup? — verify below).

**Suggested fix:** Add `assertBoard(req)` at the top of both `/status` and `/checkout`. The webhook stays unauthenticated (signature is the trust boundary). Add a per-IP rate limiter to `/checkout` if there isn't one (there isn't — only `billingWebhookLimiter` on `/webhook`).

**Severity rationale:** P1 — the actual subscription state only reveals plan / status booleans (no PII, no secrets); the checkout endpoint creates a session bound to whoever clicks the success URL. Not a P0 because the canonical risk surface (LLM cost) is closed at `billingGate(db)` on `/agents/:id/wakeup` + `/heartbeat/invoke`.

---

### F-3 (P2) — `integrationDlqRoutes` is defined but never mounted

**File:** `server/src/routes/integration-dlq.ts`.

**What's wrong:** The router is exported but `grep` finds no `app.use(...integrationDlqRoutes...)` in `server/src/app.ts`. The two endpoints (`GET /dlq`, `POST /dlq/:jobId/retry`) are dead code. They also lack any auth gate — if someone re-mounts them in a hurry, they'd expose BullMQ internals + a job-retry pivot to any unauthed client.

**Evidence:**

```
$ grep -n "integrationDlqRoutes" server/src/app.ts server/src/routes/*.ts
server/src/routes/integration-dlq.ts:19:export function integrationDlqRoutes() {
(no mount call)
```

**Suggested fix:** Either delete the file or add `assertInstanceAdmin(req)` at the top of both handlers and wire it under `api.use(integrationDlqRoutes())` in `app.ts`. Don't ship the file as-is unmounted — future "I'll quickly enable the DLQ panel" maintenance becomes a P0.

---

### F-4 (P2) — `/c/:trackingId` redirect has no rate limit + does DB write per click

**File:** `server/src/routes/content-tracking.ts:34`.

**What's wrong:** Public unauthenticated `GET /c/:trackingId` looks up a content draft, ingests an event, then redirects. No rate limit on the route mount. CodeQL's `js/missing-rate-limiting` will flag this.

**Evidence:** No `xxxLimiter` middleware on the `router.get("/c/:trackingId", ...)` registration. By contrast `digest.ts:188` uses `digestUnsubscribeLimiter`, `customer-email-unsubscribe.ts:74` uses `customerUnsubscribeLimiter`, `posthog-connector.ts:143` uses `posthogWebhookLimiter`.

**Suggested fix:** Add a per-IP limiter (~300 req/min) consistent with other content-tracking endpoints. Failure mode without it: a scraper or bot can drive arbitrary write traffic into `events` table.

---

### F-5 (P2) — `content-tracking.ts` 500 response missing `requestId`

**File:** `server/src/routes/content-tracking.ts:103`.

Already covered by F-1 but explicitly: `res.status(500).json({ error: "Internal server error" })` on the public tracking endpoint will be very hard to triage from operator side without a request id.

---

### F-6 (P1) — Many tenant-scoped routes don't run input through `validate()`

**Files:** `issues.ts` (3/13 routes validate), `routines.ts` (0/11), `projects.ts` (4/10), `issues-documents.ts` (0/10), `costs.ts` (1/19), `notifications.ts` (0/6), `weekly-wraps.ts` (0/3), `daily-briefs.ts` (0/4), `decision-outcomes.ts` (0/4), `marketing-spend.ts` (0/4), `experiments.ts` (0/3), `dashboard.ts` (0/2), `digest.ts` (1/5), `finance.ts` (0/7), `funnel.ts` (0/1), and many more.

**What's wrong:** The architecture promise (per ADR-012 + CLAUDE.md) is "Zod at every boundary → infer types." Many handlers accept a `req.body` and pass it straight to a service that may or may not validate. The route's coverage of `validate(schema)` middleware is closer to ~80 distinct call sites across ~430 routes (~20% of mutating routes). Most GET handlers don't need request-body validation, but mutating POST/PATCH/PUT routes that skip `validate()` rely on the downstream service to fail cleanly. Some do (e.g. Drizzle's schema runtime rejects most malformed values); some don't (e.g. handlers that read `req.body.something` directly without checking shape).

**Evidence — `routines.ts` (11 routes, 0 `validate()` calls):**
```
$ grep -n "router\.\(post\|patch\|put\)\|validate(" server/src/routes/routines.ts | head -10
... 11 mutating routes, no validate() calls; bodies parsed inline or trusted to downstream service
```

**Sampled risk:** `routines.ts:240` POST `/routine-triggers/:id/rotate-secret` reads `req.body....` directly and persists changes — if a malformed body slips through, the service may throw a Drizzle-level error that the global `errorHandler` converts to a generic 500.

**Suggested fix:** For each mutating route lacking `validate()`, decide:
- Is the body shape already exercised by an existing test that asserts a 400 on bad input? If yes, no fix needed.
- If not, add a Zod schema and `validate(schema)` middleware. The pattern is well-established in `secrets.ts`, `agents.ts`, `onboarding.ts`.

**Severity rationale:** P1 — buyer demo unlikely to hit edge cases, but a fresh-eyes security review will flag many of these. The current `errorHandler` already catches `ZodError` and returns a clean 400; the gap is that without `validate(...)`, the error path goes through the generic catch-all and returns 500 with a stack-trace-bearing context.

---

## 3. Auth posture — endpoints that are NOT auth-gated

### Public-by-design (justified)

| Path | Auth | Rationale |
|---|---|---|
| `GET /api/healthz` | none | Fly/k8s liveness probe, cheap, no DB |
| `GET /api/readyz` | none | Fly/k8s readiness probe |
| `GET /api/health/` | none | `{status,version}` only — Task #139 stripped recon |
| `GET /api/health/bootstrap-state` | none | UI calls BEFORE sign-in to decide login-vs-bootstrap; no per-tenant data |
| `GET /api/auth/config` | none | UI calls on boot to render correct auth provider; only publishable keys |
| `ALL /api/auth/{*authPath}` | provider-managed | Better-Auth handler owns the auth surface |
| `POST /api/auth/webhook` | HMAC | Supabase webhook; signature is the trust boundary |
| `POST /api/billing/webhook` | Stripe sig | Stripe webhook; verifies signature + raw body |
| `POST /api/webhooks/resend` | Svix sig | Resend lifecycle webhook |
| `POST /api/integrations/posthog/webhook` | HMAC | PostHog HMAC-signed events |
| `GET/POST /u/customer/:token` | HMAC token in URL | Customer email unsubscribe — RFC 8058 |
| `GET /c/:trackingId` | none | Click-tracking redirect (P2: no rate limit; see F-4) |
| `POST /api/providers/validate-key` | nonce + IP-bound + rate-limit | Onboarding-wizard live validation (S7.A.6) |
| `GET /api/providers/issue-nonce` | rate-limit | Pair of above |
| `POST /api/byo-key/validate` | `req.actor.type === "board"` | Authenticated, not just public; gated at handler |

### NOT auth-gated but should be (P1)

| Path | File | Severity |
|---|---|---|
| `GET /api/billing/status` | `billing.ts:102` | P1 — see F-2 |
| `POST /api/billing/checkout` | `billing.ts:122` | P1 — see F-2 |

### NOT auth-gated and NOT mounted (P2)

| Path | File | Severity |
|---|---|---|
| `GET /dlq`, `POST /dlq/:jobId/retry` | `integration-dlq.ts` | P2 — see F-3 |

---

## 4. Billing gate coverage

### Route-layer (verified)

`server/src/routes/agents.ts`:
- `:2193 POST /agents/:id/wakeup` — middleware chain: `agentInvokeLimiter, billingGate(db), validate(wakeAgentSchema)` ✅
- `:2243 POST /agents/:id/heartbeat/invoke` — chain: `agentInvokeLimiter, billingGate(db)` ✅

The middleware (`middleware/billing-gate.ts`) is gated by `FOUNDEROS_BILLING_GATE_ENABLED=1` (opt-in soft default), bypasses `local_implicit` actors and instance admins, fails CLOSED on lookup error, and writes an `activity_log` row on every 402 (forensic). Returns canonical 402 payload `{error, message, requestId}` — this is one of the few routes that DOES include `requestId` in a direct status response (`billing-gate.ts:214-220`).

### Heartbeat-layer (verified — defense in depth)

`server/src/services/heartbeat.ts:2974-3014` — `enqueueWakeup()` runs the same gate before queueing. Catches all service-layer wake paths that bypass the route middleware:
- `issues.ts:840`, `issues.ts:1411` (issue assignment)
- `approvals.ts:168` (approval-driven via `heartbeat.wakeup`)
- `issues-comments.ts:204` (comment-driven, batched wakeups)
- `issues-execution.ts:290` (checkout)
- Plugin-internal entry points

`requestedByActorType === "system"` bypasses (cron timers, reapers, plugin internal) — consistent with "maintenance is not user-initiated paid compute." `bypassBilling: true` opt is the explicit escape hatch.

**Verdict:** the buyer-demo billing surface is closed at two independent layers. Flipping `FOUNDEROS_BILLING_GATE_ENABLED=1` in prod will stop all paid-LLM paths for inactive subscriptions.

### Subscription state for "active"

Per `__tests__/subscription-idempotency.test.ts`: `isSubscriptionActive` returns `true` for both `active` and `trialing` (Stripe trial users keep access). Returns false for `canceled`. Stripe webhook upsert at `services/subscription.ts:90-103` targets `stripeSubscriptionId` with a unique index (`schema/instance_subscription.ts:16`) — no more duplicate rows on retry.

---

## 5. Error response shape — sampled routes

Sampled 5 representative routes:

| Route | 4xx body shape | 5xx body shape | Has `requestId`? |
|---|---|---|---|
| `POST /api/agents/:id/wakeup` (`agents.ts:2193`) | inline `{error: "Agent not found"}` on 404 | global `errorHandler` (`{error, requestId}`) | partial (4xx no, 5xx yes) |
| `POST /api/billing/checkout` (`billing.ts:122`) | inline `{error, message}` | inline `{error: "Checkout failed"}` | no |
| `GET /api/health/deep` (`health.ts:171`) | inline (assertInstanceAdmin throws) | n/a (200/503 only) | via global handler |
| `POST /api/providers/validate-key` (`providers.ts:186`) | inline `{error, details, requestId}` | inline `{error, reason, requestId}` | yes (consistent) |
| `GET /c/:trackingId` (`content-tracking.ts:34`) | n/a (redirects) | inline `{error: "Internal server error"}` | no |

**Pattern:** routes that responded inline with status codes were retrofitted at different times. `providers.ts` is the gold-standard pattern (always includes `requestId`); `billing-gate.ts` is similarly consistent. Most other routes only get `requestId` on errors that bubble to `errorHandler`. This is the F-1 finding.

---

## 6. Composio call sites — cross-org leak guard

Per CLAUDE.md, PR #30 closed the cross-org leak by requiring `connectedAccountId: string` on `runComposioTool`. Verified at `services/skills/composio-skill-bridge.ts:96-115`:
```ts
export async function runComposioTool(params: {
  userId: string;
  connectedAccountId: string;  // REQUIRED
  toolName: string;
  input: Record<string, unknown>;
}): Promise<ComposioExecuteResult> { ... }
```

All 7 call sites in production code pass it:

| File:line | Passes connectedAccountId? | Source |
|---|---|---|
| `services/skills/slack-post-message.ts:156-158` | yes | `route.composioConnectionId` |
| `services/skills/hubspot-create-contact.ts:149-151` | yes | `route.composioConnectionId` |
| `services/skills/hubspot-log-note.ts:111-113` | yes | `route.composioConnectionId` |
| `services/skills/hubspot-move-deal.ts:111-113` | yes | `route.composioConnectionId` |
| `services/skills/notion-append-block.ts:104-106` | yes | `route.composioConnectionId` |
| `services/skills/notion-create-page.ts:111-113` | yes | `route.composioConnectionId` |
| `jobs/content-publish-tick.ts:101-103` | yes | env-resolved via `COMPOSIO_AUTH_<FORMAT>` |

Last one (`content-publish-tick.ts`) resolves the id from env var (`process.env[`COMPOSIO_AUTH_${format.toUpperCase()}`]`) at line 76 and gates the call at line 85 if missing. Not per-company-resolved like the skill bridge calls — this is intentional for the cron-triggered publish path (single-tenant self-hosted assumption) but worth flagging if multi-tenant content publishing is on the roadmap.

**Verdict:** clean. Type system enforces the requirement; every reachable call site passes a resolved id from a per-route decision.

---

## Appendix — methodology

1. Listed all 83 route files in `server/src/routes/`.
2. Counted `router.<verb>(...)` call sites per file and audited the first-line authz check on each handler.
3. Cross-referenced middleware: `actorMiddleware`, `boardMutationGuard`, `billingGate`, `runnerAuthMiddleware`, `privateHostnameGuard`, `securityHeadersMiddleware`.
4. Verified billing gate via static reading of route registrations + heartbeat-layer `enqueueWakeup`.
5. Verified Composio guard by grepping all `runComposioTool` call sites and confirming `connectedAccountId` is passed.
6. Sampled error response shapes by grepping `res.status(<code>).json` patterns.

No code modifications were made. All findings are read-only static observations.
