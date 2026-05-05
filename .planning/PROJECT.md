# FounderOS — AI Company OS for Lean Founders

_Drafted 2026-05-05. Buyer-funded build. Authorized to run autonomously through end of Sprint 6._
_Supersedes the 2026-05-04 self-serve provisioning roadmap (see `ARCHIVE-2026-05-04-self-serve-provisioning.md`)._

## North star

Enable founders and ultra-lean teams (1–5 people) to build $1M–$10M ARR companies by deploying **AI departments that autonomously run company functions** — Chief of Staff, Growth, Content Studio, Lifecycle CRM, Finance, Ops.

The founder logs in and feels they are **walking into their company HQ**, not opening software.

## MVP promise

> Increase growth execution output by 5–10x and surface the top revenue opportunities automatically.

## Key metric (single number that defines success)

> **Incremental MRR lift per customer within 30 days.**

This is the metric that makes value obvious, measurable, and easy to sell. Every sprint must ladder up to this — if a feature doesn't move signups / activation / free→paid / churn / decision-quality, cut it.

## Buyer context (load-bearing)

- **$4k buyer-funded**: a customer paid $4k to have us build this. They will then **resell as SaaS** to their own customers (similar arrangement to `pi-perception`, where the same customer paid $2k and now operates it).
- **Resell implies tenant-agnostic**: no FounderOS-specific copy or branding hard-coded into the product surface. The buyer brands and goes to market.
- **Architecture B (per ledger)**: existing FounderOS architecture stays — single-tenant deployed-per-customer Fly app, multi-tenant-shaped schema (`companies` + `companyMemberships` etc.), Supabase auth, Fly MPG. No multi-tenant single-deploy refactor. No per-customer-Fly-app provisioning automation in this scope (that's v2).

## ICP wedge

**SaaS founders at $5k–$100k MRR, founder-led growth, overwhelmed by GTM execution.**

They:
- already have data (Stripe, PostHog, LinkedIn already connected)
- feel team pain (can't justify 3+ hires)
- need leverage (1 person = 5-10x output)
- pay quickly (already buy SaaS, understand CAC/MRR/churn)

Avoid pre-revenue founders for v1 — they have no data, no urgency, no MRR to lift.

## What ships in 6 weeks (the contract)

| Sprint | Goal | Outputs |
|---|---|---|
| **S1** | Foundation + workspace shell | Department-driven UX (left nav, main panel, right rail), KPI rail, alerts, approval inbox |
| **S2** | Integrations + data layer | Stripe + PostHog + LinkedIn + Notion + Slack + HubSpot, canonical event schema, freshness indicators |
| **S3** | Chief of Staff + Growth | Daily Founder Brief, KPI anomaly detection, experiment backlog (ICE), funnel diagnostics |
| **S4** | Content Studio + Lifecycle CRM | Multi-format content generator, attribution engine, first autonomous workflow (low-activation → email → approval → HubSpot) |
| **S5** | Finance + scenario modeling | Revenue cockpit, pricing simulator, churn forecast, runway, LTV/CAC, "what-if" engine |
| **S6** | Ops + approval engine + polish | Permissions matrix, audit trails, agent memory, workflow templates, mobile brief, Slack summaries, bug bash |

**Release target**: 20–50 design partners. Pricing test: $500–$1,000/mo for 1 workspace + 3 departments + 50k actions + 5 integrations + weekly founder brief.

## What is OUT of scope for the 6-week MVP

Explicit cuts (ladder up to MRR lift but not v1):
- All departments enabled by default (only CoS + Growth + Content + CRM + Finance for v1; Sales/Support/Product/Ops are "available" but unprioritized)
- Cross-workspace benchmarks (data network effects — needs >10 customers)
- Capital allocation / treasury layer (Tier 3 enterprise feature, not MVP)
- Multi-company workspaces (Tier 3)
- Self-serve provisioning automation (that's v2 — see archive)
- Mobile native app (mobile is a responsive daily-brief web view in S6)
- Slack/Salesforce/Mixpanel/Amplitude/Brex/QuickBooks/Mercury connectors beyond the must-have list
- Agent marketplace / template gallery
- Multi-region (Fly `lhr` only — same as today)

## Dependencies on existing FounderOS infrastructure

The codebase as of 2026-05-05 already provides ~40% of S1+S2 surface:

- **Auth + multi-tenant**: `companies`, `company_memberships`, Supabase JWKS, post-signup mirror — all live
- **Agent slot model**: 4-slot agents per company, adapter family (claude_local / anthropic_api / byo_runner / skip) — live
- **Approvals**: `approvals`, `approval_comments`, approve/reject UX — live
- **Audit logs**: `activity_log` — live
- **Goals/Inbox/Conversations**: routes + UI exist
- **Composio integrations**: Slack, Gmail, GitHub, GoogleCalendar, GoogleSheets, GoogleDrive, Notion, LinkedIn — live with cross-org leak fix from PR #30
- **HubSpot skills**: create-contact, log-note, move-deal — live
- **Stripe billing + idempotency**: PR #33, plan-tier middleware PR #35 — live
- **Security**: rate limits PR #31, CSP/headers PR #32, billing gate PR #35 — live
- **Activity log + audit**: live
- **Boot-time migrations + release_command**: live
- **Runner adapter (BYO)**: `byo_runner` family + `@founderos/runner` npm package + UI install dialog — live

The 6-sprint plan **builds on** this, not replaces it. Each phase doc lists "what exists" before "what we build."

## Constraints

- **No new external dependencies without ADR**: existing stack (Node + Express + Drizzle + Postgres + Supabase + Fly + Composio + Anthropic) is the surface. New ones (LangGraph runtime, Inngest, Temporal, Redis pub/sub) need an ADR explaining why what we have can't.
- **Council before any one-way door**: payment changes, schema migrations on existing customer data, irreversible auth/auth-token changes — invoke `/council`.
- **Tests before merge** for any logic touching agents, approvals, billing, or KPIs (the surfaces that drive the key metric).
- **Tenant-agnostic copy**: any customer-facing string the buyer would re-skin lives in a `i18n` or `branding` config, not hard-coded. Internal operator tooling can be FounderOS-branded.

## Status (2026-05-05)

- 7 self-serve hardening PRs merged 2026-05-04 (#28–#35) — see `CONTINUE.md`
- Branch `feat/doubtbuddy-6-sprint-plan` opened for the planning rewrite
- Self-serve provisioning roadmap archived at `.planning/ARCHIVE-2026-05-04-self-serve-provisioning.md`
- ROADMAP.md (this directory) tracks S1–S6 progress
- Authorization: explicit permission to NOT halt for decisions until S6 ships, except for the hard halts listed in `LONG_RUNNING_PROMPT.md`

## Decisions log

`~/.gstack/projects/founderos/decisions.md` is the persistent council ledger. Each sprint's checkpoint will land entries there. Prior context that shapes scope:

- **2026-05-03 multi-domain council BLOCK** (auth+landing, billing, integrations, agent runtime, deploy/ops) — Phase 0 fixes shipped same day
- **2026-05-04 self-serve hardening sprint** (PRs #28–#35) — all merged, structurally correct for per-customer-app deployments
- **2026-05-05 architecture decision (this doc)**: stay on existing arch (B), build to DoubtBuddy 6-sprint scope, defer self-serve provisioning automation to v2

See `.planning/ROADMAP.md` for the active plan.
