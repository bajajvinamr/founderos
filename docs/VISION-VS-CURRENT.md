# FounderOS — Vision vs. Current

Read alongside `ROADMAP.md` (tactical) and the `FounderOS-DoubtBuddy.md` concept doc (north-star).

The DoubtBuddy doc positions FounderOS as a full **AI Company Operating System** for SaaS founders between **$5k–$100k MRR**, with a **departments-and-integrations** architecture and an **AI Chief of Staff** that does capital allocation. What's currently built is a generic **AI-teammates + Morning Brief** product that positions against "any solo founder." Both are real, but only one of them is a venture-scale business.

This doc closes the gap between the two.

---

## Positioning: what we're saying today vs. what DoubtBuddy says

| Surface | Current (built) | DoubtBuddy north-star |
| --- | --- | --- |
| Headline | "Run a million-dollar company as a party of one" | **"Build a $10M company with 3 people"** |
| Wedge | Solo founders, anyone | **SaaS founders at $5k–$100k MRR** |
| Promise | "Morning brief, AI teammates with org chart" | **"Measurable MRR lift in 14–30 days"** |
| Pricing | $0 until $10k MRR · 2% after | **$299–$799 solo / $2k–$5k team / $10k–$50k portfolio** |
| Category | AI team-building tool | **AI Company OS** (HubSpot + Workday + Notion for AI-native companies) |

**Action items:**
- Rewrite the landing hero to anchor on "Build a $10M company with 3 people" — memorable, non-negotiable per the doc.
- Add a specific-MRR wedge line to the landing ("Built for SaaS founders doing $5k–$100k MRR").
- Replace the "$0 until $10k MRR · 2% after" pricing with the 3-tier ladder from the doc. The revenue-share model is cute but doesn't match the enterprise trajectory.

---

## Product architecture: teammates vs. departments

**Current** — the unit of work is a *teammate*: a titled agent with a brief, a shift, a comp cap, a provider. Team pages, teammate cards, roster views.

**DoubtBuddy** — the unit of work is a *department*: Growth, Content, CRM, Finance, Ops, Support, Sales, Product Intelligence. Each with its own tabbed console, KPI ownership, experiment backlog, and attribution.

**Same underlying primitives, different framing.** Every "teammate" we ship maps to a role inside a department. But the founder's mental model should be "I'm opening the Growth department" not "I'm looking at Orbit, my Head of Growth."

**Missing surfaces:**

| DoubtBuddy module | Status |
| --- | --- |
| Chief of Staff dashboard | **Partial** — Morning Brief is the Founder Brief module. Missing: Department status (green/yellow/red), Capital allocation view, Decision inbox as a first-class screen. |
| Growth Department console | **Missing** — experiment backlog, funnel analytics, channel recommender, budget allocator. |
| Content Studio | **Missing** — calendar, research, drafts, repurpose, distribution, attribution. |
| CRM / Lifecycle | **Missing** — onboarding, activation, churn rescue, upsell, campaigns. |
| Finance Department | **Missing** — revenue cockpit, scenario modeling, pricing simulator, runway forecast, LTV/CAC. |
| Ops Department | **Partial** — Issues + Routines cover some ops, but no workflow approval engine, no SOP generator. |
| Integrations console | **Missing** — no Stripe, PostHog, HubSpot, Slack, Notion, LinkedIn integrations yet. |

---

## The five biggest gaps between built and pitched

These are the things a pilot customer would ask for on day one and we'd be unable to demonstrate.

### 1. Integrations — the thing the whole product rests on
The DoubtBuddy doc lists integrations as the *determining factor for adoption*. Without Stripe, PostHog, HubSpot, Slack, Notion, LinkedIn, Meta Ads — there's no real data flowing through the AI teammates, so there's no real MRR lift to demonstrate.

**Priority order** (drop in day-one integrations before building new surfaces):
1. **Stripe** — MRR, churn, expansion. Unlocks the Company Pulse widget's real numbers + the Finance department.
2. **PostHog** — signups, activation, funnels. Unlocks the Growth department.
3. **HubSpot** (or Attio) — pipeline, contacts. Unlocks CRM / Lifecycle.
4. **Slack** — distribution channel for Morning Brief + Weekly Wrap. Also input: `@CEO what's our churn?`
5. **Notion** — shared context / company wiki. Each teammate reads from and writes to Notion docs.
6. **LinkedIn** — Growth teammate's outbound channel.

### 2. Department consoles
Founders don't think "I need to talk to my CMO teammate" — they think "I need to look at Growth this week." Rebuild the left nav around *departments*, put teammates inside each department.

Shortest path: take the existing `/agents` roster and split it into a per-department view using the `AgentRole` enum we already have. Each department page becomes a tabbed shell: **Team** (the teammates), **KPIs** (pulled from integrations), **Workflows** (the existing issues/routines scoped to that department), **Decisions** (approval inbox scoped to that department).

### 3. Decision Inbox
Currently pending approvals surface as a number on the Morning Brief. The DoubtBuddy doc makes this a first-class screen — because **approval flow is the trust model of the product**. Without it, founders can't let the AI team run autonomously.

Build a `/decisions` screen: every pending approval, grouped by department, with context ("Why this matters") + one-click approve/reject/redirect. Tied to the 4-level permission architecture below.

### 4. Permission levels (Observe / Draft / Approve / Autonomous)
Today's permission model is binary: the teammate runs, or they're on leave. The DoubtBuddy doc specifies a four-level trust escalation: observe → draft → approve → autonomous. This is what makes the product shippable into companies — you dial up autonomy per workflow as trust builds.

Data: add `permission_level` to the agent table (per-workflow or per-scope eventually). UI: a slider/radio on each teammate's Setup tab. Runtime: the adapter checks permission level before executing tool calls that have side effects.

### 5. Company memory + cross-company benchmarks (the moat)
The DoubtBuddy doc names company memory as the *primary moat*. Every experiment, KPI movement, and outcome is stored as reusable intelligence that compounds. Cross-workspace benchmarks are the venture-studio tier's selling point.

**V1**: we already have activity logs. Add a dedicated `memory` table scoped to company, keyed by topic, with LLM-generated summaries of what's been tried and what worked.
**V2**: anonymized cross-workspace benchmarks (opt-in), surfaced on the Growth dashboard ("SaaS at your stage typically converts 3.2% trial→paid; you're at 1.8%").

---

## Reconciled roadmap

Replaces the ROADMAP.md priorities. Keep ROADMAP for week-to-week; use this for the 3-month arc.

### Month 1 — Integration layer + department shell
*Goal: every demo shows real customer data flowing through at least one AI department.*

1. Stripe integration → real MRR on the Company Pulse widget
2. PostHog integration → real signups / activation
3. Department navigation rework: left nav becomes Chief of Staff · Growth · Content · CRM · Finance · Ops
4. Decision Inbox screen with approval/reject flows
5. Shipped Company Charter (already in-progress) + weekly Sunday Wrap
6. Landing repositions: "Build a $10M company with 3 people", $5k–$100k MRR wedge, 3-tier pricing

### Month 2 — Growth + Content departments
*Goal: first end-to-end revenue loop the customer can feel in their Stripe dashboard.*

1. Growth department console: experiment backlog with ICE scoring, funnel diagnostics, channel recommender
2. Content Studio: research → draft → repurpose → publish → attribution
3. LinkedIn + HubSpot integrations
4. Permission levels v1 (Observe / Draft / Approve / Autonomous) on every teammate
5. Company memory v1: per-company rolling summary surfaced at the top of each department
6. First paying design partners onboarded at $299/mo tier

### Month 3 — Finance department + Lifecycle CRM + trust layer
*Goal: a demo-able "run a company from one dashboard" experience.*

1. Finance department: revenue cockpit, scenario modeling, pricing simulator, runway forecast
2. Lifecycle CRM: onboarding, activation, churn rescue workflows
3. Full audit log viewer for compliance
4. Slack + Notion integrations
5. Mobile PWA of the Morning Brief
6. 20–50 design partners live, with at least 5 showing measurable MRR lift in-product

---

## What changes in the tactical roadmap

Re-prioritize P0–P3 in ROADMAP.md to match:

- **Move up** (into P0/P1): Stripe + PostHog integrations, Decision Inbox, Department navigation, Permission levels, Weekly Wrap.
- **Keep** (P0): Company Charter, stable Fly deploy, E2E smoke, docs site, welcome email.
- **Keep** (P1): 1:1 chat, audit log viewer, billing surface, Team ROI dashboard, responsive polish.
- **Move down** (to P3 or later): Custom LLM-assisted role hire, plugin marketplace, referral program, SSO/SAML, SOC 2, iOS native.

---

## Non-negotiables from the concept doc

Keep these in every product decision from here on:

1. **"Measurable MRR lift in 14–30 days"** is the success metric. Every feature answers: how does this move a founder's MRR this quarter?
2. The tagline **"Build a $10M company with 3 people"** should appear on the landing, every pitch deck, and the README. It's the one line that sells the product.
3. **Departments, not agents**, is the mental model in the UI. "Agents" is internal plumbing.
4. **Approval-first trust model**. Observe → Draft → Approve → Autonomous. Never bypass.
5. **Revenue attribution** is the moat work. Every content asset, every campaign, every workflow traces back to signups + revenue.
6. **Cross-company memory** is the defensibility story. Start logging from day one even if we don't surface benchmarks until month 3.
