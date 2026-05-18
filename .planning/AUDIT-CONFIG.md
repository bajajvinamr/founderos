# FounderOS Runtime Config & Secrets Audit

**Date:** 2026-05-19 · **Auditor:** automated · **Target:** prod-readiness for buyer demo
**App:** `founderos` (Fly, region `lhr`, machine 8d5990be21d228, 2 checks passing)
**Sources cross-referenced:** `server/src/lib/env-validation.ts`, `fly.toml`, `fly secrets list -a founderos`, `server/src/middleware/security-headers.ts`, `docs/ops/design-partner-onboarding-kit.md`, `CLAUDE.md`

---

## 1. Required Secrets Matrix

Legend: ✅ set on Fly · ❌ unset · ⚠ set but non-load-bearing on this provider · 🚫 P0 demo blocker

| Env var | Purpose | Severity | On Fly? | Blast radius if missing |
|---|---|---|---|---|
| `DATABASE_URL` | Fly Managed Postgres connection | hard | ✅ | App can't boot; release_command migrate fails |
| `SUPABASE_URL` | Supabase JWT issuer / JWKS base | WARN (effective REQ) | ✅ | `index.ts:530` throws at boot under `FOUNDEROS_AUTH_PROVIDER=supabase` |
| `SUPABASE_ANON_KEY` | UI client signin/signup | WARN (effective REQ) | ✅ | UI signin non-functional |
| `SUPABASE_SERVICE_ROLE_KEY` | Admin operations against Supabase | unchecked | ✅ | Post-signup hook bootstraps fail |
| `BETTER_AUTH_SECRET` | OAuth state signing for ALL providers | REQUIRED_IN_PROD | ✅ | First integration-OAuth attempt throws (state-store.ts:23) |
| `FOUNDEROS_AGENT_JWT_SECRET` | JWT for all local-agent adapters | REQUIRED_IN_PROD | ✅ | Every agent spawn fails `agent_jwt_secret_missing` |
| `FOUNDEROS_NONCE_SECRET` | Validate-key nonce HMAC | REQUIRED_IN_PROD | ✅ | Onboarding adapter-validate endpoint 500s |
| `FOUNDEROS_SECRETS_MASTER_KEY` | Per-instance secrets vault encryption | hard | ✅ | API-key vault unreadable; all hosted-API adapters fail |
| `COMPOSIO_API_KEY` | Composio v3 OAuth + tool exec | WARN | ✅ | Integrations page silently dark |
| `COMPOSIO_V3_READY` | Mounts Composio v3 routes | INFO | ✅ (`1`) | Routes return 404 |
| `COMPOSIO_AUTH_CONFIG_SLACK` | Per-toolkit auth_config.id | per-app | ✅ | Slack connect button silently fails |
| `COMPOSIO_AUTH_CONFIG_GMAIL` | " | per-app | ✅ | Gmail connect fails |
| `COMPOSIO_AUTH_CONFIG_GITHUB` | " | per-app | ✅ | GitHub connect fails |
| `COMPOSIO_AUTH_CONFIG_GOOGLECALENDAR` | " | per-app | ✅ | GCal connect fails |
| `COMPOSIO_AUTH_CONFIG_GOOGLESHEETS` | " | per-app | ✅ | Sheets connect fails |
| `COMPOSIO_AUTH_CONFIG_GOOGLEDRIVE` | " | per-app | ✅ | Drive connect fails |
| `COMPOSIO_AUTH_CONFIG_NOTION` | " | per-app | ✅ | Notion connect fails |
| `COMPOSIO_AUTH_CONFIG_LINKEDIN` | " | per-app | ✅ | LinkedIn connect fails |
| `SENTRY_DSN` | Server error tracking | WARN | ✅ | Errors land in pino only, no triage |
| `FOUNDEROS_BYO_RUNNER_ENABLED` | `byo_runner` adapter + routes | INFO | ✅ (`1`) | Runner UI flows 404 |
| `FOUNDEROS_PUBLIC_URL` | Self-referential URL base | runtime | ✅ | Magic links / OAuth callbacks misrouted |
| `FOUNDEROS_AUTH_PROVIDER` | Which auth backend to wire | runtime | ✅ (`supabase`) | Wrong provider mounted |
| `FOUNDEROS_ALLOWED_HOSTNAMES` | Host header allowlist | runtime | ✅ | private-hostname-guard rejects requests |
| `FOUNDEROS_STRICT_COMPANY_ISOLATION` | Tenant isolation gate | runtime | ✅ | Cross-org leaks possible if off |
| `STRIPE_SECRET_KEY` | Stripe checkout + sub status | WARN | ❌ 🚫 | `/api/billing/checkout` returns 503; billing gate fails open |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verify | WARN | ❌ 🚫 | Webhook unmounted; subs never reconcile |
| `STRIPE_PRICE_ID_PRO` | Beta-tier price id | runtime | ❌ 🚫 | Checkout cannot start (billing.ts) |
| `RESEND_API_KEY` | Welcome / magic-link / digest emails | WARN | ❌ 🚫 | All transactional email silently no-ops |
| `EMAIL_UNSUBSCRIBE_SECRET` | One-click unsubscribe HMAC (CAN-SPAM) | WARN (effective REQ for emails) | ❌ | First customer-email send throws at runtime |
| `ANTHROPIC_API_KEY` | Host-level Claude fallback | WARN | ❌ | Founder must BYO per-company; demo OK if onboarded with own key |
| `OPENAI_API_KEY` | Host-level Codex fallback | WARN | ❌ | Same as above for codex_local |
| `SUPABASE_WEBHOOK_SECRET` | `user.created` webhook HMAC | WARN | ❌ | Audit-only post 2026-05-03; non-load-bearing ⚠ |
| `FOUNDEROS_BILLING_GATE_ENABLED` | Hard-402 on inactive subs | INFO | ❌ (defaults `0` per fly.toml policy) | Intentional — flip AFTER §2 live-key validation |
| `FOUNDEROS_HOSTED_AGENTS_ENABLED` | Hosted-claude-CLI hardening | INFO | `0` (fly.toml) | Intentional — keystone S8 flag, default OFF |
| `FOUNDEROS_DISPATCHER_V2` | Runner multi-adapter dispatcher | INFO | ❌ | Optional; runner uses legacy `runClaude` |

**Tally:** 31 env vars referenced in validation + secrets — **22 set on Fly · 9 unset.** Of the unset: 5 are P0 demo blockers (Stripe trio + RESEND_API_KEY + EMAIL_UNSUBSCRIBE_SECRET when emails fire); 4 are intentional defaults.

---

## 2. CSP `connect-src` Audit

CSP source: `server/src/middleware/security-headers.ts:69-80`. Every entry cross-referenced against actual code-base usage.

| Host | CSP source | Actually used by | Status |
|---|---|---|---|
| `'self'` | line 70 | All `/api/*` + WSS + static | current |
| `ws:` / `wss:` | line 71-72 | `live-events-ws.ts` realtime | current |
| `https://*.supabase.co` + `wss://` | SUPABASE_HOSTS | Supabase JS client (`ui/src/lib/supabase.ts`) — signin/realtime | current |
| `https://*.supabase.in` + `wss://` | SUPABASE_HOSTS | Reserved (Supabase India region) | future-current — fine to keep |
| exact supabase project origin | dynamic via opts.supabaseUrl | Hardening | current |
| `https://api.composio.dev` | COMPOSIO_HOSTS | Server-side only (`composio-client.ts`) | **dead in browser** but harmless — keep |
| `https://backend.composio.dev` | COMPOSIO_HOSTS | Server-side only | **dead in browser** — keep |
| `https://*.ingest.sentry.io` | SENTRY_HOSTS | Sentry browser SDK | current |
| `https://sentry.io` | SENTRY_HOSTS | Sentry browser SDK | current |
| `https://api.anthropic.com` | ANTHROPIC_HOSTS | Server-side only (`packages/adapters/anthropic-api`) | **dead in browser** — keep |
| `https://api.stripe.com` | STRIPE_HOSTS | Stripe.js client | current |
| `https://hooks.stripe.com` | STRIPE_HOSTS | Stripe.js redirects | current |
| `https://registry.npmjs.org` | NPM_REGISTRY_HOSTS (PR #266) | `ui/src/pages/AdapterManager.tsx:fetch("https://registry.npmjs.org/...")` | **current — load-bearing** |

**Cross-check: external hosts the codebase fetches that are NOT in CSP.** Searched UI source for outbound `fetch()`/`new URL()` — found these UI-side externals (others are server-side, not CSP-gated):
- `registry.npmjs.org` → ✅ in CSP
- `app.posthog.com` / `eu.posthog.com` → **server-proxied** via `/api/integrations/posthog/connect`; UI never fetches PostHog directly → no CSP entry needed
- `api.openai.com` / `api.anthropic.com` → **server-proxied** via `/api/providers/validate-key` → no UI CSP entry needed
- `api.resend.com` → server-side only → no CSP entry needed
- Doc-link hosts (`docs.anthropic.com`, `platform.openai.com`, `ai.google.dev`, `github.com`) → rendered as `<a href>` only, not fetched → no CSP entry needed

**Verdict:** CSP allowlist is **clean as of PR #266.** No missing entries, no stale entries (Composio + Anthropic server-only entries are documented intent — keeping them is defensive, not dead). `script-src` allows `'unsafe-inline'` (Tailwind v4 + React) — known trade-off documented in the file header.

---

## 3. Fly Secrets — Actual `fly secrets list -a founderos` (digest fingerprint only; no values)

```
BETTER_AUTH_SECRET                  Deployed
DATABASE_URL                        Deployed
FOUNDEROS_AGENT_JWT_SECRET          Deployed
FOUNDEROS_ALLOWED_HOSTNAMES         Deployed
FOUNDEROS_AUTH_PROVIDER             Deployed
FOUNDEROS_BYO_RUNNER_ENABLED        Deployed
FOUNDEROS_MIGRATION_AUTO_APPLY      Deployed
FOUNDEROS_MIGRATION_PROMPT          Deployed
FOUNDEROS_NONCE_SECRET              Deployed
FOUNDEROS_PUBLIC_URL                Deployed
FOUNDEROS_SECRETS_MASTER_KEY        Deployed
FOUNDEROS_STRICT_COMPANY_ISOLATION  Deployed
COMPOSIO_API_KEY                    Deployed
COMPOSIO_V3_READY                   Deployed
COMPOSIO_AUTH_CONFIG_{8 toolkits}   All 8 Deployed
SENTRY_DSN                          Deployed
SUPABASE_ANON_KEY                   Deployed
SUPABASE_SERVICE_ROLE_KEY           Deployed
SUPABASE_URL                        Deployed
```

**Conspicuously absent (P0 demo blockers):**
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_PRO` — billing surface is dark
- `RESEND_API_KEY` — every email send no-ops silently
- `EMAIL_UNSUBSCRIBE_SECRET` — first customer-email send throws (`email-unsubscribe-tokens.ts`)
- `SUPABASE_WEBHOOK_SECRET` — non-load-bearing post 2026-05-03 (ok)
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` — ok if buyer brings own key during demo

---

## 4. Bootstrap Procedures

| Procedure | File | Status |
|---|---|---|
| `pnpm founderos auth bootstrap-ceo` admin recovery | `cli/src/commands/auth-bootstrap-ceo.ts` (143 LOC) | ✅ present. Issues `pcp_bootstrap_<48hex>` invite, 72h TTL, sha256-at-rest, refuses if admin exists unless `--force` |
| Auto-bootstrap `FOUNDEROS_AGENT_JWT_SECRET` (dev only) | `server/src/boot/jwt-secret-bootstrap.ts` (168 LOC), wired at `index.ts:90-110` | ✅ present. Runs AFTER `loadConfig()`, BEFORE `validateEnvOrExit()` so prod's hard-fail still fires when explicitly unset |
| First-user-wins instance_admin promotion with orphan guard | `server/src/auth/post-signup-hook.ts` + `routes/health.ts` (LOCAL_BOARD_USER_ID exclusion) | ✅ present per CLAUDE.md lines re: orphan guard + mirror upsert + FK CASCADE |

`fly ssh` fallback documented (CLAUDE.md): when container doesn't ship CLI config, replicate the INSERT directly against `invites` table.

---

## 5. Health Probes (fly.toml)

```toml
[[services.http_checks]]   path = "/api/healthz"   interval = "5s"   timeout = "2s"    # liveness
[[services.http_checks]]   path = "/api/readyz"    interval = "30s"  timeout = "5s"    # readiness (DB + auth bootstrap)
```

- `/api/readyz` — **public** per CLAUDE.md. ✅ correct for deploy probes.
- `/api/health/deep` — **admin-gated** (`assertInstanceAdmin` at `health.ts:132-133`). Fly probes do NOT hit it. ✅ correct.
- `/api/healthz` — process-only liveness. ✅ correct.

**Status:** 2/2 checks passing on machine `8d5990be21d228` as of audit.

---

## 6. Composio Per-Toolkit `auth_config` Coverage

All 8 documented toolkits have their `COMPOSIO_AUTH_CONFIG_<APP>` Fly secret deployed:

| Toolkit | Fly secret | Status |
|---|---|---|
| Slack | `COMPOSIO_AUTH_CONFIG_SLACK` | ✅ |
| Gmail | `COMPOSIO_AUTH_CONFIG_GMAIL` | ✅ |
| GitHub | `COMPOSIO_AUTH_CONFIG_GITHUB` | ✅ |
| Google Calendar | `COMPOSIO_AUTH_CONFIG_GOOGLECALENDAR` | ✅ |
| Google Sheets | `COMPOSIO_AUTH_CONFIG_GOOGLESHEETS` | ✅ |
| Google Drive | `COMPOSIO_AUTH_CONFIG_GOOGLEDRIVE` | ✅ |
| Notion | `COMPOSIO_AUTH_CONFIG_NOTION` | ✅ |
| LinkedIn | `COMPOSIO_AUTH_CONFIG_LINKEDIN` | ✅ |

Plus `COMPOSIO_API_KEY` + `COMPOSIO_V3_READY=1` — full v3 surface live. No silent-failure integrations on the integrations page.

---

## 7. Stripe Procedure Currency Check (`docs/ops/design-partner-onboarding-kit.md` §2)

Cross-referenced kit §2.2 against current code:

| Procedure step | Reference in code | Status |
|---|---|---|
| `fly secrets set STRIPE_SECRET_KEY=… STRIPE_WEBHOOK_SECRET=…` | `routes/billing.ts` reads `process.env.STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` | ✅ paths match |
| Webhook raw-body mount (`express.raw` before `express.json`) | `routes/webhooks/stripe.ts` (referenced in kit §2.1) | ✅ matches invariants doc |
| Unique index on `stripeSubscriptionId` | `instance_subscription.ts:16` per CLAUDE.md | ✅ verified |
| `fly secrets set FOUNDEROS_BILLING_GATE_ENABLED=1` enables hard-402 | `middleware/billing-gate.ts` reads same var | ✅ matches |
| `/api/health/deep` returns `stripe_connectivity` | `routes/health.ts` (admin-gated) | ✅ matches |

**Verdict:** Kit §2 procedure is **current as of 2026-05-19.** Safe to follow verbatim.

---

## 8. P0 Demo Blockers (must set BEFORE buyer demo)

Ranked by demo blast radius:

1. **`STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` + `STRIPE_PRICE_ID_PRO`** — even in test mode. Without them, the entire billing surface is 503 and the "subscribe to Beta" flow can't be demoed. Path: follow `docs/ops/design-partner-onboarding-kit.md` §2 with **test keys** for demo; flip to live keys only post-buyer-sign. `fly secrets set STRIPE_SECRET_KEY=sk_test_… STRIPE_WEBHOOK_SECRET=whsec_… STRIPE_PRICE_ID_PRO=price_…`.
2. **`RESEND_API_KEY`** — welcome email, magic-link, daily digest, weekly wrap all silently no-op without it. First impression on signup is "I never got the welcome email." `fly secrets set RESEND_API_KEY=re_…`.
3. **`EMAIL_UNSUBSCRIBE_SECRET`** — first customer-facing email send THROWS in `email-unsubscribe-tokens.ts`. Required the moment Resend is wired. Generate with `openssl rand -hex 48`.

**Optional but recommended for demo polish:**
- `ANTHROPIC_API_KEY` (host fallback) — so a buyer who hasn't BYO'd a key still sees agents run during the live demo. If buyer has own key, skip.
- Don't flip `FOUNDEROS_BILLING_GATE_ENABLED=1` for demo — leave at default `0` to avoid 402-blocking the demo flow.

---

## Appendix: Severity ladder (from `env-validation.ts`)

- **REQUIRED_IN_PROD** → process exits at boot when `NODE_ENV=production` and var missing. Currently: `BETTER_AUTH_SECRET`, `FOUNDEROS_AGENT_JWT_SECRET`, `FOUNDEROS_NONCE_SECRET`. All three are set. ✅
- **WARN** → degraded feature, server continues. Boot logs the gap.
- **INFO** → purely informational about what's enabled.
