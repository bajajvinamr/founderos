# FounderOS — DoubtBuddy 6-Sprint Roadmap

_Single source of truth for which sprint is next. Each session updates `Status` and `Last touched` columns inline._

## Sprint table

| # | Sprint | Status | Effort | Depends on | Last touched | PR |
|---|---|---|---|---|---|---|
| **S1** | Foundation + workspace shell | done | 1w | – | 2026-05-05 | [#38](https://github.com/bajajvinamr/founderos/pull/38) |
| **S2** | Integrations + data layer | in_progress | 1w | S1 | 2026-05-05 | (parallel team — S2.1, S2.7, S2.8, S2.10 in flight) |
| **S3** | Chief of Staff + Growth dept | not_started | 1w | S2 | – | – |
| **S4** | Content Studio + Lifecycle CRM | not_started | 1w | S3 | – | – |
| **S5** | Finance + scenario modeling | not_started | 1w | S2 (parallel-able with S4) | – | – |
| **S6** | Ops + approval engine + polish | not_started | 1w | S5 | – | – |

**Status values**: `not_started` → `planned` → `in_progress` → `done` → `blocked` (with note)

**Critical path**: S1 → S2 → S3 → S4 → S6. S5 can begin in parallel with S4 once S2 lands (Finance reads Stripe + PostHog data, doesn't depend on Content/CRM).

---

## Sprint summaries

### Sprint 1 — Foundation + workspace shell

**Goal**: Founder can log in and "see their company." Department-driven UX feels like Slack + Notion + HubSpot + executive dashboard.

**What ships**:
- Workspace home with left sidebar = departments (CoS, Growth, Content, CRM, Product, Ops, Finance, Sales, Support, Integrations, Settings)
- Main panel = active department console (router shell, content per dept comes in later sprints)
- Right rail = company pulse widget cluster (MRR, signups, CAC, activation, churn, runway, experiment velocity, top blockers, weekly priorities)
- Top bar: workspace switcher, product switcher, quick command (cmd-K), notifications, founder brief shortcut, anomaly alerts badge
- Alerts center page (for KPI anomalies, agent escalations, integration failures)
- Approval inbox (founder-facing decision queue — already partly exists in `Approvals.tsx`/`DecisionsInbox.tsx`)
- Department registry table (so we can add/remove departments per workspace plan)
- Audit logs view (extends existing `Activity.tsx`)

**Detailed plan**: `.planning/PHASES/PHASE-S1-foundation.md`

---

### Sprint 2 — Integrations + data layer

**Goal**: Connect real company data so the dashboard shows MRR, churn, signups, activation, content attribution — live.

**What ships**:
- Stripe data ingestion (live, beyond current billing/webhook — we want subscription/customer/charge events flowing into a normalized event table)
- **PostHog connector** (greenfield — not in Composio bridge today)
- LinkedIn data layer (Composio connection exists; need post-performance + follower data ingestion)
- Notion + Slack + HubSpot data layer (Composio bridge exists; need ingestion not just write)
- Canonical `events` table with `{workspace_id, source, entity_type, event_name, timestamp, payload}` schema
- Webhook ingestion endpoints per source (Stripe webhook already exists; PostHog webhook is new)
- Connector health monitor (per-integration last-sync timestamp + error count + freshness indicator on the dashboard)
- Sync retry queues (BullMQ — already in stack)
- Data freshness indicators on every right-rail KPI ("MRR — synced 2 min ago")

**Detailed plan**: `.planning/PHASES/PHASE-S2-integrations.md`

---

### Sprint 3 — Chief of Staff + Growth department

**Goal**: First magical ROI moment. Within 10 minutes of completing onboarding, the founder sees an actionable insight that justifies the subscription.

**What ships — Chief of Staff agent**:
- Daily Founder Brief (KPI movements, anomalies, blockers, opportunities, suggested top 3 actions)
- KPI anomaly detection (stat-z + trend break — runs every 15 min, persists insights)
- Top 3 actions for today (decision inbox already exists; this populates it)
- Blocker escalation (when an agent gets stuck, CoS escalates to founder)
- Department status (green/yellow/red rollup on workspace home)

**What ships — Growth Department**:
- Experiment backlog screen (cards: hypothesis, channel, expected CAC, expected lift, status, confidence, owner agent, next milestone)
- ICE scoring (Impact × Confidence × Ease, auto-suggested by agent, founder-editable)
- Funnel diagnostics (Traffic → Signup → Activation → Retention → Paid — drop-off detection)
- Channel recommendation engine (reads PostHog + Stripe + LinkedIn, suggests budget reallocation)
- LinkedIn growth workflows (CoS detects "your founder content is driving X% of signups, double output here")

**Magic activation output** (success criteria):
> Within 10 minutes of onboarding the founder sees: "Your LinkedIn founder content is driving 32% of signups. Double output here. Trial conversion is weak due to onboarding drop-off at step 2."

**Detailed plan**: `.planning/PHASES/PHASE-S3-cos-growth.md`

---

### Sprint 4 — Content Studio + Lifecycle CRM

**Goal**: Direct acquisition lift (Content) + retention/revenue lift (CRM). First true autonomous revenue loop.

**What ships — Content Studio**:
- Research → draft → repurpose → publish flow
- Multi-format generator (one brief produces LinkedIn post + X thread + newsletter + reel script + landing copy + ad creative angles)
- Content attribution engine (every asset tracks views/saves/clicks/signups/revenue)
- Content calendar UX

**What ships — Lifecycle CRM**:
- Onboarding email sequences (templated, agent-personalized)
- Activation nudges (PostHog event-driven)
- Churn rescue workflows (Stripe `at_risk` + low PostHog activity → win-back)
- Upsell workflows (high-engagement free → paid)
- Founder-led email sequences (CoS drafts, founder approves and personalizes)

**First autonomous workflow** (success criteria):
> Low activation detected → CoS drafts email sequence → founder approval → deploy via HubSpot → CoS tracks lift over 7d.

**Detailed plan**: `.planning/PHASES/PHASE-S4-content-crm.md`

---

### Sprint 5 — Finance + scenario modeling

**Goal**: CFO moat. Founders can answer financial what-if questions without a spreadsheet.

**What ships**:
- Revenue cockpit (MRR, ARR, expansion, churn, LTV, payback period, gross margin)
- Pricing simulator ("what if I raise paid plans by 20%?" → MRR + churn risk + CAC payback delta)
- Churn forecast (cohort-based, Stripe + PostHog)
- Runway forecast (current cash + burn + projected revenue)
- LTV/CAC model
- Experiment ROI model (Growth experiments → Finance ROI rollup)
- Cash planning layer (next 6 months of expected cash flow with scenario toggles)

**Killer workflow** (success criteria):
> Founder asks: "What happens if I reduce free credits by 70%?" → AI outputs free→paid lift, churn risk, MRR impact, payback delta.

**Detailed plan**: `.planning/PHASES/PHASE-S5-finance.md`

---

### Sprint 6 — Ops + approval engine + polish

**Goal**: Turn the assembled system into a trustworthy operating system for 20-50 design partners.

**What ships**:
- Permissions matrix (Observe / Draft / Approval-required execute / Autonomous, per agent per department)
- Approval workflows (workflow-level approval gates, not just per-action — already partly exists)
- Audit trails (extend `activity_log` with workflow lineage — what triggered what)
- Agent memory (persistent learnings, what worked / didn't, per-workspace — `company_memory` table exists, expand schema)
- Workflow templates v1: growth anomaly, content loop, revenue rescue (the 3 templates from the PRD)
- Notification system (in-app + Slack)
- Mobile daily brief (responsive web view at `/brief`, magic-link auth, no native app)
- Slack daily summaries (post Daily Founder Brief into a configured Slack channel)
- Bug bash (final polish pass — known TS-strict warnings, accessibility, console errors)

**MVP release target**:
> 20–50 design partners onboarded. $500–$1,000/mo pricing test. Goal is not margin — it's proof of MRR lift.

**Detailed plan**: `.planning/PHASES/PHASE-S6-ops-polish.md`

---

## Cross-cutting decisions (NO halt — log and proceed per autonomy grant)

These are decisions the long-running prompt makes inline, NOT user-halt blockers. If a decision proves wrong, we revisit on retro.

| Decision | Default we'll take | When to revisit |
|---|---|---|
| **Workflow runtime** | BullMQ + plain async (already in stack) instead of LangGraph/Temporal/Inngest | If S3 CoS reasoning gets too complex for in-process |
| **Event ingestion** | Webhook → BullMQ → write to `events` table (no Kafka, no event bus) | At >100 customers / >10k events/min |
| **PostHog** | Hosted PostHog (free tier OK for first design partners) | If usage exceeds free tier |
| **Pricing tiers** | Tier 1 ($299–$799 solo) is the only tier ENABLED in v1; Tiers 2/3 are config-only | When first multi-seat customer asks |
| **Trial length** | 14 days (industry default for SaaS at this ACV) | Based on activation data |
| **Vector store** | pgvector inside existing Postgres (memory + embeddings stay in one DB) | At >100k embeddings |
| **Recharts vs Tremor vs custom** | Recharts (already in DoubtBuddy spec, lightweight) | If charting becomes bottleneck |
| **CoS scheduling** | Cron tick every 15 min for KPI anomaly + once daily 7am local for Daily Brief | Per-customer schedule preference in S6 |
| **Onboarding wizard** | Extend existing onboarding (steps already exist), add "choose departments + autonomy level" steps | – |

## Hard halts (blocks autonomous progression — must ask user)

These are the ONLY decisions that block forward motion:

- **Live Stripe key flip** to production mode (one-way door, real money at risk)
- **Real customer data migration** if a design partner is using v0 data already (irreversible)
- **DNS / domain ownership transfer** for `founderos.com` or any customer-facing domain
- **Council BLOCK verdict** on a critical-path PR (read the verdict, don't bypass)
- **Schema migration on `instance_user_roles` / `companies` / `company_memberships`** (auth-critical, FK-load-bearing — needs council before merge)

Anything else: take the default, log the decision, proceed.

---

## Conventions

- **One PR per sprint sub-feature** (not per sprint) — sprints are too large for single PRs. Each phase doc breaks the sprint into 5-10 tickets that map to PRs.
- **Conventional commits**: `feat(s1):`, `feat(s2):`, etc. so we can grep by sprint later.
- **Atomic commits per ticket**, squash-merge per PR.
- **Update this ROADMAP.md** after each sprint merge: Status + Last touched + PR list. Don't let the roadmap drift from reality.
- **Council before merge** if the PR touches: auth, payment, billing, schema, RBAC, security, agent autonomy. Council passes get logged in `~/.gstack/projects/founderos/decisions.md`.
- **`/vanta-sync` after each sprint** to extract learnings.
