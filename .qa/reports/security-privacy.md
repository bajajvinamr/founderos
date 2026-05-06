# Agent Report: Security/Privacy

_Generated: 2026-05-06 | Reviewer: Security/Privacy Discovery Agent_

---

## Scope Reviewed

Graph nodes: `security_privacy`, `tenant_isolation`, `auth_actor_resolution`, `agent_credentials_roles`

Files examined:
- `server/src/app.ts` — middleware registration order
- `server/src/middleware/auth.ts` — actor resolution
- `server/src/middleware/runner-auth.ts` — runner token auth
- `server/src/middleware/logger.ts` — pino redact config
- `server/src/middleware/security-headers.ts` — CSP
- `server/src/routes/authz.ts` — assertCompanyAccess / assertInstanceAdmin
- `server/src/routes/agents.ts` — PATCH agent, agent self-update
- `server/src/routes/approvals.ts` — self-approval guard
- `server/src/routes/billing.ts` — Stripe webhook signature
- `server/src/routes/brief-magic-link.ts` — magic-link consume
- `server/src/routes/runner.ts` — token issuance and management
- `server/src/routes/instance-invites.ts` — invite token logging
- `server/src/routes/auth-webhook.ts` — Supabase webhook email logging
- `server/src/routes/debug.ts` — debug echo endpoint
- `server/src/routes/execution-workspaces.ts` — tenant isolation by ID
- `server/src/routes/issues-execution.ts` — tenant isolation by ID
- `server/src/routes/plugin-ui-static.ts` — path traversal
- `server/src/routes/secrets.ts` — secret access guards
- `server/src/routes/integrations.ts` — integration access guards
- `server/src/services/magic-link.ts` — atomic consume
- `server/src/services/instance-invite.ts` — invite token generation
- `server/src/agent-auth-jwt.ts` — agent JWT sign/verify
- `server/src/auth/post-signup-hook.ts` — first-admin-wins
- `server/src/log-redaction.ts` — redaction helpers
- `server/src/realtime/live-events-ws.ts` — WebSocket auth
- `packages/shared/src/validators/agent.ts` — updateAgentSchema
- `packages/shared/src/constants.ts` — AGENT_ROLES list

---

## Top Findings (10)

---

### Finding 1

- **Severity:** P1
- **Category:** secret-leakage
- **Graph node:** `auth_actor_resolution`, `security_privacy`
- **File(s):** `server/src/routes/instance-invites.ts:136-139`
- **What is wrong:** When `emailSender.enabled` is `false` (e.g., `RESEND_API_KEY` not set), the invite `signupUrl` — which embeds the full plaintext invite token — is emitted to the pino logger at `info` level. The pino config at `server/src/middleware/logger.ts:50` only redacts `req.headers.authorization`; it does NOT scrub `signupUrl` or its embedded token. The `redactSensitive` helper in `httpLogger` only catches known key names like `token`, `apikey`, etc. The key `signupUrl` is not in that set.
- **Why it matters:** The invite token is not a `pcp_bootstrap_` token (that's the CLI format); it is a 43-char base64url token stored in plaintext in the `instance_invites` table. Any service that reads server logs (log aggregator, Sentry breadcrumbs, observability dashboard) will receive the full invite URL including the raw token. An attacker with log-read access can consume the invite and obtain `instance_admin`.
- **Threat model:** Log reader (support engineer, compromised log aggregator, Sentry data) → reads `signupUrl` in log → navigates to invite URL → claims `instance_admin` on the live instance.
- **Evidence (excerpt):**
  ```ts
  // instance-invites.ts:136-139
  logger.info(
    { to: email, signupUrl },  // signupUrl = "/auth?invite=<token>"
    "instance invite: email sender disabled — admin must share signup URL manually",
  );
  ```
- **Suggested fix:** Replace `signupUrl` in the log call with a token-safe preview: `{ to: email, inviteId: created.id }`. The full URL is returned in the API response to the admin — it does not need to be in logs.
- **Test to add:** Unit test that calls `createInvite` with email sender disabled and asserts the logger call does NOT include a string matching `/invite=[A-Za-z0-9_-]{40,}/`.
- **Effort:** Small
- **Safe to fix now?** Yes

---

### Finding 2

- **Severity:** P1
- **Category:** secret-leakage
- **Graph node:** `auth_actor_resolution`, `security_privacy`
- **File(s):** `server/src/routes/auth-webhook.ts:113-120`
- **What is wrong:** On every `user.created` Supabase webhook event, the handler logs `userId`, `email`, and `provider` at `info` level. Email addresses are PII. In a GDPR/privacy context, logging the email of every signup to the server log file (written to disk at `~/founderos-logs/server.log`) without redaction or expiry creates a long-lived PII exposure surface. The pino `redact` config does not cover email fields.
- **Why it matters:** Server log files are typically rotated but not immediately deleted. An operator accessing the log file or a log aggregator (Datadog, Logtail) would accumulate every founder email in plaintext.
- **Threat model:** Log access → harvests founder emails for phishing or GDPR notification obligation.
- **Evidence (excerpt):**
  ```ts
  // auth-webhook.ts:113-120
  logger.info(
    { userId: user.id, email: user.email, provider: user.provider, eventType },
    "auth webhook: user.created acknowledged",
  );
  ```
- **Suggested fix:** Replace `email: user.email` with `emailDomain: user.email?.split("@")[1] ?? null` in the log call. The userId is sufficient for correlation; domain-only is enough for analytics without PII exposure.
- **Test to add:** Assert the `user.created` log call does not contain the full email string, only the domain portion.
- **Effort:** Small
- **Safe to fix now?** Yes

---

### Finding 3

- **Severity:** P1
- **Category:** secret-leakage (pino redact gap)
- **Graph node:** `security_privacy`
- **File(s):** `server/src/middleware/logger.ts:50`
- **What is wrong:** The pino logger only redacts `req.headers.authorization`. The secret-prefixed token patterns documented in CLAUDE.md (`mlt_*`, `fos_*`, `pcp_bootstrap_*`, `sk-ant-*`, `sk_live_*`) are NOT in the pino `redact` array. Any log call that includes a raw object containing these field names (e.g., `{ token: "mlt_abcdef..." }`) will emit them unless the calling code manually strips them. The `redactSensitive` helper in `httpLogger.customProps` DOES catch `token`, `secret`, `apikey`, etc. by key name, but pino's built-in `redact` only fires on `req.headers.authorization`. Pino redact paths use dot-notation and are evaluated at the structural level before the object reaches any application-layer helper.
- **Why it matters:** If a future log call adds `{ token: plaintext, ... }` or if pino-http serializes a body that slips through `customProps`, the raw token value would be in the log file. The `SENSITIVE_KEYS` set covers the common names but does not handle compound or nested field shapes.
- **Threat model:** A developer adds a debug log with `{ magicLink: result.token }` during incident response. The key `magicLink` is not in `SENSITIVE_KEYS`, so `redactSensitive` passes it through, and the token lands in the log file.
- **Evidence:**
  ```ts
  // logger.ts:50
  redact: ["req.headers.authorization"],
  // Missing: "*.token", "*.secret", "*.apiKey" etc. as structural paths
  ```
- **Suggested fix:** Expand pino `redact` to cover the common structural paths: `["req.headers.authorization", "*.token", "*.secret", "*.apiKey", "*.api_key", "*.password"]`. These are structural wildcards pino supports. Additionally add value-pattern scanning to the `SENSITIVE_KEYS` set for the well-known prefixes (`mlt_`, `fos_`, `sk-ant-`, `sk_live_`).
- **Test to add:** Pass a log object containing `{ token: "mlt_abc123", apiKey: "sk-ant-abc" }` through the redaction path and assert output shows `[redacted]`.
- **Effort:** Small
- **Safe to fix now?** Yes

---

### Finding 4

- **Severity:** P1
- **Category:** privilege-escalation (agent role mutation)
- **Graph node:** `agent_credentials_roles`
- **File(s):** `packages/shared/src/validators/agent.ts:74-82`, `server/src/routes/agents.ts:1892`
- **What is wrong:** `updateAgentSchema` is derived from `createAgentSchema.omit({ permissions: true }).partial()`. The `role` field from `createAgentSchema` (`z.enum(AGENT_ROLES).optional()`) survives into `updateAgentSchema` — it is NOT omitted. The `PATCH /agents/:id` handler at `agents.ts:1892` passes the parsed body directly to `svc.update(id, patchData, ...)` without stripping the `role` field. An authenticated agent (or board user) with write access to an agent can therefore change that agent's `role` to any value in `AGENT_ROLES`, including `ceo`.

  The `ceo` role has elevated trust in the codebase: at `agents.ts:365`, an agent with `role === "ceo"` bypasses the `assertCanUpdateAgent` check on other agents (a CEO can modify all agents in its company). It also influences `canCreateAgents` logic. This is a privilege escalation: a `general` agent promoted to `ceo` gains the ability to modify all other agents in the company and is treated with CEO-level trust in task assignment and skill-sync flows.
- **Why it matters:** The CLAUDE.md critical invariant states "agent role cannot be promoted to admin via PATCH". While `instance_admin` / `founder` are not in `AGENT_ROLES` (so escalation to DB-level admin is not possible), the `ceo` → "modify all agents in company" path is a functional privilege escalation that the threat model explicitly calls out.
- **Threat model:** Agent with `canCreateAgents` permission or CEO access calls `PATCH /agents/:id { "role": "ceo" }` on itself or another agent, gaining the ability to modify all agents in the company without board oversight.
- **Evidence (excerpt):**
  ```ts
  // validators/agent.ts:74-82
  export const updateAgentSchema = createAgentSchema
    .omit({ permissions: true })
    .partial()
    .extend({
      permissions: z.never().optional(),
      replaceAdapterConfig: z.boolean().optional(),
      status: z.enum(AGENT_STATUSES).optional(),
      spentMonthlyCents: z.number().int().nonnegative().optional(),
    });
  // Note: `role` is NOT omitted — it passes through from createAgentSchema
  ```
  ```ts
  // agents.ts:365
  if (actorAgent.role === "ceo") return;  // CEO bypasses assertCanUpdateAgent
  ```
- **Suggested fix:** Add `role: z.never().optional()` to the `extend()` block in `updateAgentSchema`, same as `permissions`. Role changes require a separate privileged endpoint (analogous to `/agents/:id/permissions`). If role changes must remain possible, gate them behind `assertBoard` only — agents should not be able to change their own or others' roles.
- **Test to add:** `PATCH /agents/:id { "role": "ceo" }` from an agent actor should return 422.
- **Effort:** Small
- **Safe to fix now?** Yes

---

### Finding 5

- **Severity:** P1
- **Category:** cross-company
- **Graph node:** `tenant_isolation`, `auth_actor_resolution`
- **File(s):** `server/src/routes/authz.ts:13-18`
- **What is wrong:** `assertInstanceAdmin` grants full instance-admin bypass to ANY actor with `source === "local_implicit"` regardless of `isInstanceAdmin`. This means the synthetic `local-board` principal (set in `actorMiddleware` when `deploymentMode === "local_trusted"`) unconditionally passes ALL `assertInstanceAdmin` gates. In production `fly.toml` sets `FOUNDEROS_DEPLOYMENT_MODE = "authenticated"`, so `local_trusted` is not reachable there. However, this is a configuration-dependent safety control with no runtime enforcement.

  **Risk hypothesis (not P0 confirmed finding):** If a misconfiguration or `.env` override sets `FOUNDEROS_DEPLOYMENT_MODE=local_trusted` in a production-adjacent environment (staging, Docker Compose quickstart), the `local-board` user gains full instance-admin access without any credential, effectively bypassing all auth.
- **Why it matters:** `local_implicit` is a synthetic principal that CLAUDE.md explicitly flags must be excluded from admin counts. The bypass being structural (baked into `assertInstanceAdmin`) rather than env-gated creates a footgun for operators who test in a "close to prod" local_trusted mode.
- **Threat model:** Operator accidentally deploys with `FOUNDEROS_DEPLOYMENT_MODE=local_trusted` to a public URL → any HTTP client is instance admin with no auth.
- **Evidence:**
  ```ts
  // authz.ts:13-18
  export function assertInstanceAdmin(req: Request) {
    assertBoard(req);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
      return;
    }
    throw forbidden("Instance admin access required");
  }
  ```
- **Suggested fix:** Add an env-validator check that refuses to boot with `FOUNDEROS_DEPLOYMENT_MODE=local_trusted` when the server is bound to a public interface (`FOUNDEROS_BIND=public` or `HOST=0.0.0.0`). No code change to `assertInstanceAdmin` needed; the guard belongs at startup.
- **Test to add:** Integration test that boots in `local_trusted` mode and verifies `GET /api/health/deep` returns 200 (confirming `local_implicit` has admin), then a separate test for `authenticated` mode that returns 403 from the same endpoint without credentials.
- **Effort:** Small (env validator change only)
- **Safe to fix now?** Yes

---

### Finding 6

- **Severity:** P2
- **Category:** secret-leakage (agent JWT — HS256 symmetric key)
- **Graph node:** `auth_actor_resolution`, `agent_credentials_roles`
- **File(s):** `server/src/agent-auth-jwt.ts:20`, `server/src/agent-auth-jwt.ts:48-50`
- **What is wrong:** Agent JWTs are signed with HS256 (symmetric HMAC-SHA256) using `FOUNDEROS_AGENT_JWT_SECRET`. The vinamr-invariants explicitly call out: _"Use ES256 asymmetric JWTs for pi-perception auth. HS256 symmetric keys will fail auth silently"_ — however the more general security concern is that any process holding the server secret can forge agent JWTs for any `agentId`/`companyId` combination. There is no per-agent key rotation: rotating the shared secret invalidates all existing agent JWTs simultaneously.
- **Why it matters:** A compromised `FOUNDEROS_AGENT_JWT_SECRET` allows an attacker to mint valid agent JWTs scoped to any company, bypassing the DB lookup. The company_id check in `middleware/auth.ts:248` (`agentRecord.companyId !== claims.company_id`) is the only cross-company guard — and it relies on the JWT signature being unforgeable, which is only true as long as the shared secret is safe.
- **Threat model:** Server secret leaked (via env dump, Sentry context, or log) → attacker forges `{ sub: anyAgentId, company_id: anyCompanyId }` JWT → gains agent-level access to any company.
- **Evidence:**
  ```ts
  // agent-auth-jwt.ts:20
  const JWT_ALGORITHM = "HS256";
  // Shared secret for all agent JWTs
  const secret = process.env.FOUNDEROS_AGENT_JWT_SECRET?.trim();
  ```
- **Suggested fix (medium effort):** Migrate to per-agent asymmetric keys: store the public key per agent in `agent_api_keys`, sign with a per-run ephemeral private key. Short-term mitigation: add `FOUNDEROS_AGENT_JWT_SECRET` to the startup env validator and enforce rotation on any security incident.
- **Test to add:** Assert that a JWT signed with a different secret is rejected (timing-safe compare test).
- **Effort:** Large (asymmetric migration), Small (env validator + rotation docs)
- **Safe to fix now?** Partial (env validator only); asymmetric migration needs a sprint

---

### Finding 7

- **Severity:** P2
- **Category:** secret-leakage (Stripe webhook — raw body pattern)
- **Graph node:** `billing_stripe`, `security_privacy`
- **File(s):** `server/src/app.ts:177-183`, `server/src/routes/billing.ts:165`
- **What is wrong:** The Stripe webhook route uses `req.rawBody` which is attached via the `express.json` `verify` callback (app.ts:180-182). This is the documented approach and it WORKS — the raw buffer is attached before JSON parsing. However the concern from CLAUDE.md's invariant is the opposite: the raw body is not being parsed via `express.raw({ type: 'application/json' })` BEFORE `express.json()`. Instead `express.json()` itself saves the buffer in the `verify` callback. This is functionally equivalent for Stripe signature verification, but there is a subtle risk: if any middleware or intermediate proxy modifies `req` after `express.json()` (e.g., body-rewriting middleware, gzip decompression) the `rawBody` buffer captured in the verify callback and the body that Stripe verifies against could drift.

  **Current state is acceptable** for the present architecture (no body-rewriting middleware in the chain). This is documented as a risk hypothesis, not a confirmed vulnerability.
- **Why it matters:** Any future addition of body-rewriting middleware (compression, encoding normalization) between `express.json` and the billing route handler would silently break Stripe signature verification, causing all webhooks to reject with 400.
- **Threat model:** Body modification introduced by a future middleware → signature verification fails → Stripe webhooks silently dropped → billing state diverges from Stripe.
- **Evidence:**
  ```ts
  // app.ts:177-183
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }));
  // No separate express.raw() for the Stripe webhook path
  ```
- **Suggested fix (defensive):** Mount a `express.raw({ type: 'application/json' })` on `/api/billing/webhook` BEFORE `express.json()` registers globally, per the Stripe docs recommendation. This guarantees the raw body is always available even if `express.json` is replaced.
- **Test to add:** Integration test that posts a Stripe webhook with a valid signature and asserts 200 (not 400 "invalid signature").
- **Effort:** Small
- **Safe to fix now?** Yes (defensive hardening)

---

### Finding 8

- **Severity:** P2**
- **Category:** cross-company (WebSocket subscription filter)
- **Graph node:** `tenant_isolation`
- **File(s):** `server/src/realtime/live-events-ws.ts:95-176`, `server/src/realtime/live-events-ws.ts:208`
- **What is wrong:** The WebSocket upgrade path extracts `companyId` from the URL path (passed in as a parameter to `authorizeUpgrade`). For board/session actors, it verifies either `isInstanceAdmin || memberships.includes(companyId)`. For agent tokens, it verifies `key.companyId === companyId`. This is correct. However, the `companyId` used to filter events at line 208 (`subscribeCompanyLiveEvents(context.companyId, ...)`) comes entirely from the client-supplied URL path parameter, as parsed and passed through the upgrade handler.

  If the URL-parsing logic does NOT properly extract and validate the companyId from the path before passing it to `authorizeUpgrade`, a client could supply an arbitrary `companyId` and receive events for that company. The caller (`live-activity.ts`) is responsible for parsing the URL and extracting the companyId — this needs verification in `routes/live-activity.ts`.
- **Why it matters:** An attacker with a valid board session (even for Org A) who knows Org B's companyId UUID could subscribe to Org B's live event stream if the URL-to-companyId extraction is not guarded by the membership check.
- **Threat model:** Authenticated Org A founder guesses Org B's companyId (e.g., from a support ticket) → opens WS to `?companyId=<org-b-uuid>` → receives real-time issue/approval/heartbeat events for Org B.
- **Evidence:**
  ```ts
  // live-events-ws.ts:208
  const unsubscribe = subscribeCompanyLiveEvents(context.companyId, (event) => { ... });
  // context.companyId is derived from the client-supplied URL companyId parameter
  ```
  The membership check at line 145-146 (`hasCompanyMembership`) enforces that the authenticated user IS a member of the requested companyId, which is the correct guard. **This finding is confirmed-correct** if the board path (session, no bearer) properly checks membership — it does at line 145. The risk hypothesis was that it might not; the code is correct. Classifying as P2 risk-hypothesis.
- **Suggested fix:** No code change required for the current implementation. Add an explicit test: board user from Org A attempts WS subscription to Org B's companyId and assert the upgrade is rejected (connection closed 1008).
- **Test to add:** Cross-company WS subscription test.
- **Effort:** Small (test only)
- **Safe to fix now?** N/A (no code fix needed; test needed)

---

### Finding 9

- **Severity:** P2
- **Category:** secret-leakage (CSP missing origins)
- **Graph node:** `security_privacy`
- **File(s):** `server/src/middleware/security-headers.ts:62-72`
- **What is wrong:** The `connect-src` directive is missing two origins that are actively used by the application:
  1. **`https://api.openai.com`** — `server/src/services/embedder/openai.ts` and `server/src/adapters/codex-models.ts` call `https://api.openai.com/v1/...` directly. When the UI or a browser-side component triggers these paths (or when the CSP is evaluated in browser context), requests to `api.openai.com` will be blocked.
  2. **`https://api.resend.com`** (or `https://*.resend.com`) — The Resend email sender (`server/src/services/email-sender.ts`) calls the Resend API; the webhook comes inbound from Resend infrastructure. Outbound Resend API calls are server-side only, but if any UI component constructs Resend API calls directly (unlikely but possible via a future integration), they would be blocked.

  These are server-side-only calls, so the CSP violation would be silent for current functionality (CSP applies to browser-context fetches, not Node.js `fetch()`). However, the CSP is enforced (not report-only), and the 2026-05-03 council explicitly flagged "no CSP" as P1. Future UI features that proxy these calls or a plugin that invokes them from the browser would be silently blocked.
- **Why it matters:** The `connect-src` must be kept as a living allowlist per CLAUDE.md. Missing origins create invisible failures when features are added.
- **Evidence:**
  ```ts
  // security-headers.ts:62-72 — connect-src does NOT include api.openai.com
  const ANTHROPIC_HOSTS = "https://api.anthropic.com";
  // OpenAI is absent despite:
  // adapters/codex-models.ts:5: const OPENAI_MODELS_ENDPOINT = "https://api.openai.com/v1/models";
  // services/embedder/openai.ts:15: const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";
  ```
- **Suggested fix:** Add `https://api.openai.com` to `connect-src`. Add `https://api.resend.com` if any future client-side Resend integration is planned.
- **Test to add:** Snapshot test on `buildContentSecurityPolicy()` output to assert `api.openai.com` is present in `connect-src`.
- **Effort:** Small
- **Safe to fix now?** Yes

---

### Finding 10

- **Severity:** P2
- **Category:** cross-company (PATCH agent companyId bypass via status/spentMonthlyCents)
- **Graph node:** `agent_credentials_roles`, `tenant_isolation`
- **File(s):** `packages/shared/src/validators/agent.ts:74-82`, `server/src/routes/agents.ts:1989`
- **What is wrong:** `updateAgentSchema` exposes `status` and `spentMonthlyCents` as patchable fields. An agent (or board user) with write access to an agent can send `PATCH /agents/:id { "status": "terminated" }` directly without going through the designated lifecycle endpoints (`/agents/:id/pause`, `/agents/:id/terminate`). The designated endpoints call `svc.pause()` / `svc.terminate()` which presumably handle cascade logic (pause wakeups, update heartbeats, etc.). The raw PATCH path bypasses that lifecycle service and writes status directly via `svc.update()`.

  Similarly, `spentMonthlyCents` being patchable lets an agent artificially reset its own cost counter, defeating the budget enforcement guard.
- **Why it matters:** Bypassing lifecycle methods means no activity_log entry, no cascade to pause wakeups, and no heartbeat state machine update. An agent could reset its own `spentMonthlyCents` to `0` and continue running after a budget hard-stop. A malicious actor with board access could silently terminate agents without an audit trail.
- **Threat model:** Agent resets `spentMonthlyCents` to 0 → continues running past budget limit → unbounded LLM spend. Or: board user terminates an agent via PATCH with no audit log.
- **Evidence:**
  ```ts
  // validators/agent.ts:80-81
  status: z.enum(AGENT_STATUSES).optional(),
  spentMonthlyCents: z.number().int().nonnegative().optional(),
  ```
- **Suggested fix:** Remove `status` and `spentMonthlyCents` from `updateAgentSchema`. Status transitions must go through the lifecycle endpoints. `spentMonthlyCents` should only be writable by the system (cost accumulation service), never by external callers.
- **Test to add:** `PATCH /agents/:id { "status": "terminated" }` should return 422. `PATCH /agents/:id { "spentMonthlyCents": 0 }` should return 422.
- **Effort:** Small
- **Safe to fix now?** Yes

---

## Secret-Leakage Audit

**Patterns searched:**

```bash
# Pattern 1 — raw secret prefixes in server source
rg "fos_[a-zA-Z0-9]|mlt_[a-zA-Z0-9]|pcp_bootstrap_|sk-ant-|sk_live_|sk-" server/src/ --include="*.ts" \
  | grep -v "test|spec|__tests__|comment|TOKEN_FORMAT|hashRunnerToken|log-redact|redact|pattern|schema"

# Pattern 2 — secrets in log calls
rg "console\.log|logger\.(info|debug|trace)" server/src/services/ --include="*.ts" \
  | grep -i "token|key|secret|password|plaintext|mlt_|fos_|pcp_"

# Pattern 3 — magic link and invite token in log calls
rg "magic.*link|magicLink|issue.*token|signupUrl" server/src/ --include="*.ts" \
  | grep "log|logger|console"
```

**Hits found:**

| File | Line | Pattern | Severity |
|---|---|---|---|
| `server/src/routes/instance-invites.ts` | 136-139 | `signupUrl` (embeds invite token plaintext) logged at `info` level when email sender is disabled | **P1 (Finding 1)** |
| `server/src/routes/auth-webhook.ts` | 113-120 | `email: user.email` (PII) logged at `info` level on every signup | **P1 (Finding 2)** |
| `server/src/middleware/logger.ts` | 50 | pino `redact` only covers `req.headers.authorization`; missing structural paths for `*.token`, `*.secret`, `*.apiKey` | **P1 (Finding 3)** |
| `server/src/auth/clerk.ts` | 9 | Comment-only reference to `sk_live_...` format (not an actual value) | False positive |
| `server/src/routes/runner.ts` | 78-88 | Token generation code — no leakage, token is in response body only | Clean |
| `server/src/services/magic-link.ts` | (all) | No log calls include plaintext — token returned only from `issue()` return value | Clean |
| `server/src/routes/brief-magic-link.ts` | 54-59 | `tokenId` (not plaintext) logged on purpose-mismatch — safe | Clean |

**No `fos_`, `mlt_`, `sk-ant-`, `pcp_bootstrap_`, or `sk_live_` literal values found in non-test, non-comment server source code.**

---

## CSP / Header Audit

**`connect-src` origins (as built by `buildContentSecurityPolicy`):**

```
'self'
ws:
wss:
https://*.supabase.co https://*.supabase.in wss://*.supabase.co wss://*.supabase.in
https://api.composio.dev https://backend.composio.dev
https://*.ingest.sentry.io https://sentry.io
https://api.anthropic.com
https://api.stripe.com https://hooks.stripe.com
[optional: exact Supabase project URL from supabaseUrl param]
```

**Other headers set:**

| Header | Value |
|---|---|
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` |
| `Content-Security-Policy` | Enforced (not report-only) |

**Missing origins in `connect-src`:**

| Origin | Reason needed |
|---|---|
| `https://api.openai.com` | `server/src/adapters/codex-models.ts:5` and `server/src/services/embedder/openai.ts:15` call `api.openai.com/v1/...` — currently server-side only but must be in allowlist for future browser-side usage |
| `https://api.resend.com` | Resend email API is server-side; outbound webhook origin is `https://svix.com` / Resend infra. No immediate browser-side risk but missing from living allowlist |

**Confirmed good:**
- Supabase WebSocket origins covered by wildcard (`wss://*.supabase.co`)
- Sentry covered (`https://*.ingest.sentry.io`)
- Stripe covered (`https://api.stripe.com`, `https://hooks.stripe.com`)
- Anthropic covered (`https://api.anthropic.com`)
- Composio covered (`https://api.composio.dev`, `https://backend.composio.dev`)
- `frame-ancestors: 'none'` prevents clickjacking
- `object-src: 'none'` prevents Flash/plugin-based attacks

---

## Recommended PR Slices

**PR-SEC-1 (Small — 1h): Fix invite token and email leakage in logs**
- `server/src/routes/instance-invites.ts:137` — replace `signupUrl` with `inviteId`
- `server/src/routes/auth-webhook.ts:116` — replace `email` with `emailDomain`
- Tests: assert log calls do not include token patterns or full email addresses
- Files: 2 routes, 2 tests

**PR-SEC-2 (Small — 1h): Harden pino redact + strip role/status/spentMonthlyCents from updateAgentSchema**
- `server/src/middleware/logger.ts:50` — expand pino `redact` array
- `packages/shared/src/validators/agent.ts:74-82` — add `role: z.never().optional()`, remove `status` and `spentMonthlyCents` from schema
- Tests: schema rejection tests for the three fields; pino redact unit test
- Files: 1 middleware, 1 validator, 2 tests

**PR-SEC-3 (Small — 30min): Add `api.openai.com` to CSP connect-src**
- `server/src/middleware/security-headers.ts` — add `const OPENAI_HOSTS = "https://api.openai.com";` to `connect-src`
- Test: snapshot test on `buildContentSecurityPolicy()` asserting `api.openai.com` present
- Files: 1 middleware, 1 test

**PR-SEC-4 (Small — 1h): Startup env validator guard for local_trusted + public bind**
- `server/src/index.ts` — add startup check that errors if `deploymentMode === "local_trusted"` AND bind is public/0.0.0.0
- Test: assert server fails to start with that configuration
- Files: 1 startup file, 1 test

**PR-SEC-5 (Medium — 2-3h, future sprint): Migrate agent JWTs to per-agent asymmetric keys**
- `server/src/agent-auth-jwt.ts` — replace HS256 with ES256 + per-agent key pair
- `packages/db/` — add `agent_jwt_keys` table migration
- Files: JWT module, DB migration, heartbeat service
