# FounderOS — Buyer Promise Audit

**Generated:** 2026-05-19 (read-only audit, no code changed).
**Scope:** Cross-reference what the buyer/DoubtBuddy was sold against what is shipped on `main` / `founderos.fly.dev`. Sources: ADR-012 (cutover), `docs/ops/design-partner-onboarding-kit.md` (buyer playbook), `ui/src/pages/Landing.tsx` (public marketing copy), supporting ADRs and runbooks.

---

## Broken promises (P0) — TL;DR

Three demo-threatening gaps the buyer was sold but doesn't have today:

1. **"3 departments" vs. 5+2 shipped.** Kit § 1 sells "3 departments." Wizard ships **5 always-on core** (`chief-of-staff`, `growth`, `content`, `crm`, `finance`) + 2 opt-in (`engineering`, `ops`) — see `ui/src/components/onboarding/steps/Step5Departments.tsx:20-26`. Landing (`Landing.tsx:1005`) says "5 departments." Either the kit pricing line is wrong or the product over-delivered into the next tier — they contradict each other. Buyer will read "3" in their own playbook and see "5" in the product they sell.
2. **"50,000 actions/mo" enforcement does not exist.** Kit § 1 sells "50,000 actions/mo" as a Beta tier inclusion. Landing (`Landing.tsx:1008`) repeats this claim. There is **no action counter, no quota schema, no enforcement**: grep across `server/src/` and `packages/db/src/` returns zero hits for `monthlyActions / actionsLimit / usage_quota / action_count`. The number is a marketing line with no software behind it. A buyer who measures usage to bill on overage has nothing to read.
3. **Stripe webhook pre-flight checks listed in the kit do not match the codebase.** Kit § 2.1 instructs: "verify `express.raw({ type: "application/json" })` is mounted BEFORE `express.json()`" and "`/api/health/deep` returns `200 ok` for `stripe_connectivity`." Codebase: `server/src/app.ts:186` uses **`express.json({ verify })`** (rawBody captured via verify callback — functionally equivalent but NOT what the kit says to inspect), and `health.ts` has **no `stripe_connectivity` probe**. A buyer following § 2.1 literally cannot complete the checklist.

Audit summary: **34 promises audited · 3 P0 broken · 5 P1 fragile · 2 needing clarification.**

---

## 1. Promise inventory

| # | Promise | Source | Sprint | Shipped? | Evidence | Gap |
|---|---|---|---|---|---|---|
| 1 | 6-sprint scope S1–S6 shipped | ADR-012 § Context | S1–S6 | Y | `docs/adr/012-*.md`; CONTINUE.md; 100 migrations | clean |
| 2 | Beta tier = $500–$1,000 / month | Kit § 1 | S5/S6 | Y (no system enforcement, manual price) | Stripe checkout in `routes/billing.ts:121` | clean (priced manually) |
| 3 | 1 workspace per company | Kit § 1 | S1 | Y | tenant model in `packages/db/src/schema/`; ADR-009 | clean |
| 4 | **3 departments** | Kit § 1 | S1.9 | **N — product ships 5 core + 2 opt-in** | `Step5Departments.tsx:20-26` | **P0 mismatch** between kit and product |
| 5 | **50,000 actions/mo enforced or instrumented** | Kit § 1, Landing `Landing.tsx:1008` | — | **N** | no `actionsLimit / usage_quota / action_count` anywhere | **P0** — promise has zero software backing |
| 6 | **5 integrations supported** | Kit § 1 | S2 | Partial — product supports 6 native + many Composio | `INTEGRATION_KINDS` in `packages/shared/src/constants.ts:905-912` lists 6 (`stripe, posthog, hubspot, slack, notion, linkedin`); 8 Composio toolkits live | P1 — kit underpromises; not broken but stale |
| 7 | Email + Slack support workflow | Kit § 1 | — | Partial | `resend-webhook.ts` + Resend email sender; Slack daily summary cron is **deferred (v1.1)** | P1 — Slack side of "support" deferred |
| 8 | Plan defaults restrictively in migration | Kit § 1 | S1 | Y | `instance_subscription.ts:17` — `plan default 'free'`; `0065_subscription.sql:5` | clean |
| 9 | `FOUNDEROS_BILLING_GATE_ENABLED` opt-in (default off) | Kit § 1 | S5 | Y | `billing-gate.ts:47` reads env, default false; banner at `:145` | clean |
| 10 | Webhook idempotency unique index on `stripeSubscriptionId` | Kit § 2.1 | S5 | Y | `migrations/0074_subscription_unique.sql:42-44`; `schema/instance_subscription.ts:16` | clean |
| 11 | Webhook signature verification uses raw body before `express.json()` | Kit § 2.1 | S5 | Y (different mechanism) | `app.ts:186-192` uses `express.json({ verify })` to capture `rawBody`; `routes/billing.ts:181-186` reads `req.rawBody` | **P0 doc-vs-code drift** — buyer cannot complete § 2.1 literally |
| 12 | `/api/health/deep` returns `stripe_connectivity` status | Kit § 2.1 | — | **N** | grep `health.ts` returns zero matches | **P0** — pre-flight checklist item is unimplemented |
| 13 | `/api/health/deep` is admin-gated | CLAUDE.md / Kit § 2.1 | S6 | Y | verified pattern in `health.ts:132-133` per CLAUDE.md | clean |
| 14 | Onboarding wizard | Kit § 4 Day 0 | S1.9 / G3* | Y (V2: `FounderOnboardingWizard.tsx` is prod path) | `App.tsx:659` | clean |
| 15 | Save-and-resume onboarding (draft persistence) | Kit § 4 Day 0 / S6.8 | S6.8 | **N — backend exists, V2 wizard does NOT hydrate** | `routes/onboarding-draft.ts:35-64` server route lives; `FounderOnboardingWizard.tsx:290-293` says "V2 wizard does NOT yet hydrate from it on mount" | matches ADR-012 deferred list ("wizard rewiring to draft API") |
| 16 | Stripe checkout completes; `instance_subscription` row appears | Kit § 4 Day 0 | S5 | Y | `routes/billing.ts:121-160`; `services/subscription.ts` | clean |
| 17 | Anthropic key stored encrypted | Kit § 4 Day 0 | S1 | Y | `instanceApiKeysService.setKey({family:"anthropic",executionMode:"api"})` per CLAUDE.md; AES-256-GCM per Landing § Security | clean |
| 18 | Default agents (CoS / growth / content / finance) | Kit § 4 Day 0; ADR-012 S3 | S3 | Y | `seed.ts`, `default-agent-instructions.ts` | clean |
| 19 | Magic-activation gate (≥ 2 integrations → backfill + warmup + first brief) | Kit § 4 Day 0 | S3 | Y | `services/onboarding/first-run.ts` per CLAUDE.md | clean |
| 20 | Founder reads daily brief on phone via magic-link | Kit § 4 Days 1-3 | S6.7 | **N (deferred to v1.1)** | `magic-link.ts:101-260` service exists; no email-template issuance and no `/brief?token=...` consumer | matches ADR-012 deferred ("/brief route token consumption" + "email-template magic-link issuance") |
| 21 | Audit log accumulates rows | Kit § 4 Days 1-3 | S6.3 | Y | `activity_log` table; ADR-013 wires gate-blocks | clean |
| 22 | Permissions matrix shows workspace defaults | Kit § 4 Days 1-3 | S6.1 | Y | `routes/permissions-matrix.ts` | clean |
| 23 | First autonomous-eligible workflow (churn-rescue) candidate at days 4-7 | Kit § 4 Days 4-7 | S4.8 | Y | `services/workflows/templates/churn-rescue.ts`; ADR-012 lists S4.8 | clean |
| 24 | Autonomy ladder (L1–L4) approval engine | Kit § 4 Days 4-7 | S6.2 | Y | approvals service + `approvals.ts` route | clean |
| 25 | Weekly summary memory entry auto-generates | Kit § 4 Day 7+ | S5 | Y (data layer) | `routes/weekly-wraps.ts`, `routes/company-memory.ts` | clean |
| 26 | requestId in every API JSON error response | Kit § 5 | S5 | Y | `middleware/request-id.ts`; CLAUDE.md confirms 2026-05-03 | clean |
| 27 | Composio cross-org leak closed | Kit § 5 | S2 | Y | `composio-skill-bridge.ts:96-113` per CLAUDE.md; ADR-008 | clean |
| 28 | Anthropic 529 retry handler | Kit § 5 / vinamr-invariants | — | Y | `agents/content-generator.ts:34` doc comment + retry logic | clean |
| 29 | "AES-256-GCM envelope encryption on every provider key" | Landing § Security `Landing.tsx:936` | S1 | Y | byo-key + instance-api-keys + secrets routes; key vault | clean |
| 30 | "Single-tenant — your company gets its own Fly machine and its own Postgres" | Landing `Landing.tsx:935` | — | **? PARTIAL** | Single canonical Fly deploy `founderos.fly.dev` with one Postgres serves ALL tenants logically. Tenant-isolation in DB schema is real, but the per-tenant Fly-machine claim is not how the prod deploy works. | **P1 fragile** — copy implies per-tenant infra; reality is per-tenant DB row isolation in a shared instance |
| 31 | "Bring your own infra — Deploy on Fly.io in one command. Or point at your own VPC and your own Postgres" | Landing `Landing.tsx:937` | — | Y (self-hostable) | MIT license + Dockerfile + `fly.toml`; embedded-PG fallback for dev | clean |
| 32 | "MIT engine — open source, fork it" | Landing `Landing.tsx:938` | — | Y | `LICENSE` is MIT-licensed Paperclip fork (ADR-001) | clean |
| 33 | "Company export — Coming soon" FAQ on Landing | Landing `Landing.tsx:1093` | S5 | Y (export IS shipped) | `routes/companies-export.ts:128`, UI in `CompanySettings.tsx:75-110` downloads JSON | **P1 stale copy** — FAQ tells the buyer it's not shipped when it is |
| 34 | "Hire your team in 30s" / "<5m setup" | Landing `Landing.tsx:711-712`, Hero | — | ? | Wizard length is 6 steps; full E2E onboarding incl. integrations ≥ 5min | **P1 fragile** — depends on what's counted as "setup" |

---

## 2. Beta tier feature checklist (Kit § 1)

| Inclusion | Status | Evidence | Verdict |
|---|---|---|---|
| 1 workspace per company | Working | Tenant + companies schema in `packages/db/src/schema/`; ADR-009 | clean |
| **3 departments** selectable in V2 wizard | **Broken — ships 5 always-on + 2 opt-in** | `Step5Departments.tsx:20-26`; `onboarding-types.ts:81` | **P0** — kit and product disagree on the count |
| **50,000 actions/mo** enforced or instrumented | **Broken — zero enforcement, no counter** | No `actionsLimit`, `usage_quota`, `monthlyActions` in `server/src/` or `packages/db/src/` | **P0** — number on marketing page, nothing behind it |
| 5 integrations supported | Underpromised — 6 native + Composio ≥ 8 toolkits | `INTEGRATION_KINDS` in `constants.ts:905-912`; Composio toolkits enumerated in CLAUDE.md | **P1 stale doc** |
| Email + Slack support workflow | Partial — Email yes; **Slack daily summary cron deferred (v1.1)** | `deliverMorningBriefToSlack()` lives in `slack-digest.ts:39` but no cron mounts it; `services/notifications.ts:6` comment confirms cron is "follow-up" | **P1** matches ADR-012 deferred list — intentional |

---

## 3. The 6 deferred-to-v1.1 items (per ADR-012)

| # | Deferred item | Half-shipped? | Notes |
|---|---|---|---|
| 1 | UI bell + WS push | **Half-shipped — bell IS rendered with 30s polling, only WS push is missing** | `NotificationBell.tsx:1-10` ("No WebSocket: the audit explicitly accepted polling for V1") mounted in `BreadcrumbBar.tsx:52,81,114`. The deferred portion is **only the WS push**, not the bell itself. The bell is present and works on prod; reads from `/api/companies/:companyId/notifications/unread-count`. Re-confirm with buyer that polling-only-bell counts as "shipped." |
| 2 | Slack daily summary cron | Cleanly deferred | `deliverMorningBriefToSlack()` is reachable only from `routes/integrations.ts:131` (manual trigger), not from any scheduler. `services/notifications.ts:6` comment explicitly says "Slack daily summary cron." |
| 3 | Email-template magic-link issuance | Cleanly deferred | `magic-link.ts:101` service exists end-to-end (issue + consume + audit); no email transport mounts a magic-link template. `auth/post-signup-hook.ts:240-259` only sends a welcome email. |
| 4 | `/brief` route token consumption | Cleanly deferred | `pages/DailyBrief.tsx:31-44` requires `selectedCompanyId` (full auth context); no `searchParams.get("token")` / no magic-link consume on mount. |
| 5 | Wizard rewiring to draft API (no auto-hydrate) | Cleanly deferred | `FounderOnboardingWizard.tsx:290-293` self-documents the gap. Backend route `routes/onboarding-draft.ts:35` exists; wizard does not call it on mount. |
| 6 | Embedder for memory cosine recall | Cleanly deferred | No `embedder`, `embedding`, or `cosine` paths in `server/src/services/` for `company_memory`. Schema and CHECK constraint exist (CLAUDE.md), but no vector pipeline. |

**Re-confirmation needed with buyer:** item #1 (NotificationBell shipped with polling, not WS) is half-shipped and **works in the demo**. Buyer might count this as a "feature present"; the polling 30s is a reasonable Beta posture. No code is dead — risk is only that the buyer doesn't realize they have less than the kit said.

---

## 4. Marketing copy vs. reality (5 sampled claims)

| # | Claim (Landing.tsx) | Reality | Verdict |
|---|---|---|---|
| 1 | "Build a $10M company with 3 people." (Hero, `:268-278`) | Aspirational; not testable | Marketing claim — clean as aspiration |
| 2 | "18 founders live · Est 2026" (Hero `:258-263`) and "Live — 18 founders running companies this week" (`:262-264`) | No data backs "18." Per CONTINUE.md, prod is "live and healthy" but no public count of design partners | **P1 fragile** — if buyer asks "which 18?" there is no answer |
| 3 | "Three providers · Claude, Codex, Gemini" + "Any model. Per teammate." (`:712, :584-588`) | True — three CLI families + three API families (anthropic_api shipped 2026-05-18). Cross-CLI verified in `packages/runner/src/adapters/index.ts` | clean |
| 4 | "$299/mo Solo Founder · up to $799 with add-ons" (Pricing `:996-998`) | Pricing tier `solo_founder` NOT in `instance_subscription.plan` schema (only `free` default); the $299 number is marketing-only; **buyer's kit § 1 quotes a different number ($500–1,000)** | **P0 pricing contradiction** — Landing sells $299 to the public, kit tells the buyer to charge $500–1,000 |
| 5 | "Coming soon — we're shipping company export in our next release." (FAQ `:1093`) | Export IS shipped. `routes/companies-export.ts:128` + UI button in `CompanySettings.tsx:75-110` | **P1 stale copy** — FAQ promise needs deletion |

---

## 5. Stripe + billing posture

| Check | Status | Evidence |
|---|---|---|
| `FOUNDEROS_BILLING_GATE_ENABLED` defaults OFF | Yes | `middleware/billing-gate.ts:47, :145` |
| Flip-the-flag procedure in kit § 2 references actual files | **Partial** — file paths real, but **mechanism described doesn't match code** | `server/src/routes/webhooks/stripe.ts` referenced in § 2.1 **does not exist** (no `webhooks/` subdir); real handler is `routes/billing.ts:165`. Kit says `express.raw(...)` BEFORE `express.json()`; reality is `express.json({ verify: capture-rawBody })`. Functionally equivalent + verified working, but a buyer following the kit literally will get confused. |
| Webhook idempotency unique index on `stripeSubscriptionId` | Yes | `migrations/0074_subscription_unique.sql:42-44`; `schema/instance_subscription.ts:16` |
| Raw body captured before `express.json()` parses | Yes (via `verify` callback) | `app.ts:186-192` |
| `/api/health/deep` Stripe connectivity probe (kit § 2.1) | **NO** | `routes/health.ts` has no Stripe check; grep returns zero matches |
| PITR backup before flip is documented | Doc-only | Kit § 2.1 lists step; no automated check |

---

## 6. Pricing model alignment

- `instance_subscription.plan` defaults to `"free"` in schema (`instance_subscription.ts:17`) and migration (`0065_subscription.sql:5`). **Restrictive default verified.**
- New tenants without a Stripe customer correctly sit in `plan="free"`, `status="inactive"`. No surprise upgrades possible.
- However: **`plan` is a free-text column with no CHECK constraint**. Per the CLAUDE.md invariant ("CHECK constraints on enum-shaped text columns are the runtime backstop"), this is a known fragility — a raw SQL insert could set any string. Not an immediate buyer-impact issue but worth filing. (P1 hygiene.)
- The kit names "Beta" as a tier; codebase has no `beta` plan name. Tier mapping appears to live in the Stripe dashboard (price IDs / product names), not in the codebase. Coordinated change at Stripe-dashboard-flip-time required.

---

## 7. Promises needing clarification

1. **"Slack daily summary" support workflow.** Kit § 1 includes "Slack support" in the Beta tier. Kit also defers "Slack daily summary cron" to v1.1. Are these the same thing? If yes, the kit promises a v1.1 feature in the V1.0 inclusion list. If no, what IS the "Slack support" inclusion in V1.0? (Likely: founder can post to founder-Slack via the Slack integration, but no cron-driven digest.)
2. **"50,000 actions/mo".** Is this a metering promise (count tracked and shown to founder) or a soft cap (we will manually invoice for overage)? Codebase backs neither. Buyer needs to decide before first invoice.
3. **"3 departments" vs. shipped 5+2.** Is the kit pricing line stale, or is V1 supposed to lock the 5 core departments behind a feature flag and only ship 3 to Beta tenants? Today there is no flag — all 5 core are always-on for everyone.

---

## 8. Related risks the audit surfaced (P1, not on the buyer-promise list)

These are not broken buyer promises but they will damage demo confidence if hit:

- **`hermes_local` adapter type is in `AGENT_ADAPTER_TYPES` but the runner package does not ship.** A founder who selects "Hermes" in the wizard will see runner-mode mismatch. ADR-014 explicitly defers Hermes runner-side; risk is UI doesn't yet warn. Per CLAUDE.md the UI label is fixed in S7.4. **Re-verify on prod before demo.**
- **Runner `SIGKILL` is broken when the spawned CLI traps `SIGTERM`** (`packages/runner/src/spawn.ts:117-119`). A misbehaving local CLI can hang the runner for its full natural runtime. Repro documented in CLAUDE.md. Low blast radius (legacy `runClaude()`) but lives on the demo path.
- **Landing `:1108-1110` claim "If one provider goes down, the next one picks up."** No multi-provider fallback router was found in `server/src/services/`. This is the strongest unsupported claim on the landing page after the per-tenant-Fly-machine line.

---

## Closing note

The MVP **is** demo-ready and the engineering side of the cutover is sound. The promise gaps cluster in three places:
1. **Pricing/quotas surface** — numbers were written into marketing and the kit before any quota system shipped.
2. **Kit-vs-code drift** — § 2.1 specifically references files and mechanisms that don't exist as written. The functionality is there; the kit needs a small rewrite to point at the real paths.
3. **Two on-Landing claims** (per-tenant Fly machine, automatic provider fallback) are stronger than what the codebase delivers and should be softened before public-facing partner outreach.

These are all fixable in 1–2 hours of focused doc/code work. None of them blocks the cutover, but each is a credibility cliff with the first design partner who reads carefully.
