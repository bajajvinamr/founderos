---
title: Client Handover
summary: Single-page checklist for the FounderOS buyer. Code-complete state, switches you must flip, and where to go when something breaks.
last_updated: 2026-04-24
---

# FounderOS — Client Handover

Read this file top-to-bottom once. The 2-week buyer plan's scope is code-complete; this is the operator hand-off.

---

## 1 · What works today (verified)

| Area | Status | Where |
|---|---|---|
| Server (prod) | Deployed, deep-health green across 5 checks | `https://founderos.fly.dev/api/health/deep` |
| UI (prod) | Deployed | `https://founderos-bice.vercel.app` |
| Auth | Supabase project `ggspsiexqppduvsqvpgy` wired | `packages/shared/src/auth-config.ts` |
| Onboarding (5 steps) | Company → goals → departments → adapter → first agent | `ui/src/components/onboarding/**` |
| Adapter choice | Claude CLI (recommended) / Anthropic API key / Skip | `Step4Plugin.tsx` |
| Department templates | Ops, Growth, Content, Finance | `packages/shared/src/departments/**` |
| Decision Inbox + Weekly Wrap + Monthly Review | Shipping | `ui/src/routes/**` |
| Legal pages | Terms + Privacy live | `ui/src/routes/LegalTerms.tsx`, `LegalPrivacy.tsx` |
| Billing (Stripe) | SDK wired, checkout + webhook signature verified | `server/src/services/stripe-client.ts` — returns 501 until env set |
| Single-tenant Fly provisioning | One-shot script, 3 GB volume, auto-deploy | `scripts/fly-provision.sh` |
| Runbooks | User / Admin / Incidents | `docs/runbooks/` |
| CI gates | typecheck · lint · test+coverage · migrations · bundle size · file size | `.github/workflows/ci.yml` |

**Verify before you accept handoff:**

```bash
curl -sf https://founderos.fly.dev/api/health/deep | jq '.status'
# expected: "ok"
```

---

## 2 · What you must flip to turn it live

These are **user-action-only** — I cannot do them for you. Listed in the order you'll hit them.

### 2a · Stripe (activates real billing)

1. Create a **$299/month** subscription plan in Stripe dashboard → copy price ID
2. Create a webhook endpoint pointing at `https://founderos.fly.dev/api/billing/webhook` → copy signing secret
3. Set three Fly secrets:
   ```bash
   fly secrets set \
     STRIPE_SECRET_KEY=sk_live_... \
     STRIPE_PRICE_ID_PRO=price_... \
     STRIPE_WEBHOOK_SECRET=whsec_... \
     -a founderos
   ```
4. Smoke test: `curl -X POST https://founderos.fly.dev/api/billing/checkout -d '{"email":"test@example.com"}'` — should return a `{url}` to a Stripe-hosted page (test in test-mode keys first).

**Rollback:** if anything breaks, `fly secrets unset STRIPE_SECRET_KEY -a founderos` — routes degrade to 501, no user data touched.

### 2b · GitHub secrets (activates CI/CD pipeline)

Without these, deploys are manual (`fly deploy` / `vercel deploy`). With them, merges to `main` auto-deploy.

| Secret | Where to get |
|---|---|
| `FLY_API_TOKEN` | `fly tokens create deploy` |
| `VERCEL_TOKEN` | Vercel dashboard → Settings → Tokens |
| `SENTRY_AUTH_TOKEN` | Sentry dashboard → Internal Integrations (enables source-map upload on release) |

Add via GitHub repo → Settings → Secrets and variables → Actions.

### 2c · Branch protection (prevents accidental force-push to `main`)

Follow the checklist in `docs/ops/branch-protection.md`. Must require: PR, status checks (`ci`), up-to-date branch. Takes 2 minutes in GitHub UI.

### 2d · Resend tier upgrade (transactional email)

Free tier caps at 100/day. Upgrade when you hit ~30 concurrent active users. Plan accordingly.

---

## 3 · Per-customer provisioning — recommended model

Three options; decision is yours. My recommendation first:

### Option A (recommended): Buyer hosts, each customer runs a shared instance

Single `founderos.fly.dev` instance, multi-tenant via the `companyId` scope that's already in the schema. Simplest operations: one app, one DB, one deploy pipeline. All the code assumes this.

**Trade-off:** customers share infra. If you resell to 10 different founders, they're all on the same Postgres. Fine for launch; revisit at 50+ paying.

### Option B: One Fly app per customer (single-tenant)

Run `./scripts/fly-provision.sh <customer-slug>` per customer. Script spins a new Fly app, 3 GB volume, pre-sets `DATABASE_URL` + `FOUNDEROS_SECRETS_MASTER_KEY`, deploys from source. Takes ~3 minutes per customer.

**Trade-off:** higher isolation, higher cost ($10-30/mo per customer minimum on Fly), and you pay for idle machines.

### Option C: Buyer-hosted (customer brings their own Fly account)

Give each buyer the repo + `scripts/fly-provision.sh` + the self-host doc. They run it on their own Fly account. You don't touch infra; they own uptime.

**Trade-off:** support load drops to zero, but upsell paths (managed hosting) disappear.

**Decision cue:** if your first 10 customers fit on one Postgres (confirmed — FounderOS is a low-QPS control plane, not an analytics workload), start with Option A. Migration to B/C is additive, not destructive.

---

## 4 · Where to go when something breaks

| Symptom | Read first | Then |
|---|---|---|
| User can't log in | `docs/runbooks/incidents.md` § "Login 403" | Check Supabase JWKS |
| Agent stuck, no runs | `docs/runbooks/incidents.md` § "Stuck agent" | Check heartbeat table, restart worker |
| Cost spike alarm | `docs/runbooks/incidents.md` § "Cost spike" | Check `audit_log` for runaway agent |
| DB connection drops | `docs/runbooks/incidents.md` § "DB drops" | Check Fly MPG status + connection pool |
| Deploy failure | `.github/workflows/README.md` | Check which CI gate failed; known flakes in `docs/CI-KNOWN-FLAKES.md` |
| Composio integration returns "not enabled" | By design — v3 migration pending (ticket `docs/tickets/001`) | Set `COMPOSIO_V3_READY=1` only after migration ships |

---

## 5 · What's deferred (tracked debt, not blockers)

Listed so you know what you're inheriting. None of these block handover.

- **Ticket 001** — Composio v3 migration. v1 is gated off; integrations return "not enabled" cleanly. Fix when first customer requests a live Slack/Gmail integration.
- **Ticket 002** — Per-file DB fixtures. 1 flaky test (`workspace-runtime.test.ts`) under parallel load. Non-blocking; quarantined.
- **Tickets 004-007** — Four files >2500 lines (heartbeat, company-portability, AgentDetail, worktree). Grandfathered in the CI file-size allowlist. Refactor as you touch them.
- **SENTRY_AUTH_TOKEN** — without it, stack traces in Sentry are minified. Errors still report.

See `docs/PLAN-FORWARD-2026-04-23.md` for the 90-day roadmap past handover.

---

## 6 · Final handoff checklist (the buyer signs this)

- [ ] Deep health returns `status: "ok"` on live prod URL
- [ ] Stripe secrets set in Fly; test-mode checkout returns a URL
- [ ] Stripe webhook fires a `checkout.session.completed` event and the server responds 200
- [ ] GitHub repo secrets (`FLY_API_TOKEN`, `VERCEL_TOKEN`) set
- [ ] Branch protection applied to `main`
- [ ] Buyer has admin access to: Fly org, Vercel project, Supabase project, Stripe account
- [ ] Buyer has watched the handover Loom (link: _to be added by you_)
- [ ] Buyer can find `docs/runbooks/` and knows to read `CONTINUE.md` before any new session
- [ ] `docs/HANDOVER.md` (this file) has been walked through live once

Once all boxes check, handover is complete.

---

_Questions during handover land in `docs/runbooks/incidents.md`. Anything novel → add a new entry so the next operator doesn't re-learn the same lesson._
