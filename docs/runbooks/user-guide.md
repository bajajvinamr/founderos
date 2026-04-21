---
title: User Guide
summary: Everyday use of FounderOS — signing in, hiring agents, running the weekly cadence
---

For founders using a FounderOS instance someone else is hosting. If you run the instance yourself, also read the [Admin Guide](./admin-guide.md).

## Sign in

Your admin sends you a URL that looks like `https://founderos-<slug>.fly.dev` (or a Vercel app with a custom domain) and an invite link.

### First-time sign-up

1. Open the invite link `https://<instance>/invite/<token>`
2. Create your account — email + password
3. You land on the Dashboard

### Signing in again

Visit the instance root. If a session exists you skip straight to the dashboard; otherwise you land on `/auth`.

### Forgot password

Password reset email flow is not shipped yet. **Ask your admin to reset it for you** — see [Admin Guide → Resetting a user's password](./admin-guide.md#resetting-a-users-password).

---

## Pick a company template

On first run, the Onboarding Wizard opens automatically. You pick one of three starter templates:

| Template | Roles | Best for |
|---|---|---|
| **Solo Indie SaaS Founder** | CEO, CoS, Growth Lead, Engineer, Support | One-person product, first revenue |
| **Bootstrapped B2B SaaS** | CEO, CoS, Sales, Growth, Success, Content, Engineer | Self-funded B2B with repeat deals |
| **Pre-seed AI Lab** | CEO, CTO, 2 Research, Product, GTM, DevOps | Research-heavy team, funded but lean |

Each template ships with a real org chart, a starter backlog, and goals. You can hire more teammates later — templates are a seed, not a cage.

To re-run onboarding (add another company or another teammate), go to `/onboarding`.

---

## Add your Anthropic API key

FounderOS runs agents through adapters. Cheapest + best path: an Anthropic API key.

1. Get a key at [console.anthropic.com](https://console.anthropic.com)
2. Go to **Instance Settings → Providers** (`/instance/settings/providers`)
3. Pick **Anthropic**, paste the key, hit **Test**
4. If Test returns green, you're done — agents can now run

The key is encrypted at rest using your instance master key (AES-256-GCM). The UI never shows the raw key again after you save it.

If your admin has disabled a provider, you won't see it here. Ask them.

Alternatives: OpenAI (`OPENAI_API_KEY`), Google Gemini (`GEMINI_API_KEY`), or a logged-in Claude Code CLI subscription. Full matrix in [Providers](../adapters/providers.mdx).

---

## Hire your first agent

Two ways to hire.

### Quickest — Ask the CEO

1. Open the sidebar → **Hire** (or navigate to `/<company>/hire`)
2. Tell the CEO what role you need ("hire a growth lead who can own email")
3. The CEO returns a proposal: role, department, suggested adapter, permission level, starter issues
4. Review and **Approve** — the agent is created and wakes up on their first heartbeat

### Manual

Go to **Team → All → New Agent** (`/<company>/agents/new`). Fill role, department, adapter, permission level, and heartbeat cadence.

Every agent has: a name, a role, an adapter (which LLM), a permission level, and a heartbeat interval. The heartbeat is the clock — every N minutes, the agent checks its issues and may run.

---

## Departments

Agents are grouped into departments. Visit `/<company>/departments/<id>` for the department console.

| Department | Owns |
|---|---|
| **Chief of Staff** (`chief-of-staff`) | Weekly wrap, morning brief, routing, goals alignment |
| **Growth** (`growth`) | Funnels, activation, PostHog dashboards, paid experiments |
| **Content** (`content`) | Blog drafts, social, newsletter, PR |
| **CRM & Lifecycle** (`crm`) | HubSpot pipeline, lifecycle emails, win/loss |
| **Finance** (`finance`) | Burn, runway, invoices, cost tracking |
| **Engineering** / **Product** / **Research** | Template-specific |

Each department has one lead and one or more ICs. The lead is the agent you wake when you want that function to take action.

---

## Decision Inbox

The Decision Inbox (`/<company>/decisions`) is where agents ask you for calls they can't make alone.

Each decision has a state:

- **Pending** — waiting on you. Approve or reject.
- **Approved** — agent will act on the next heartbeat
- **Rejected** — agent moves on; writes the rejection reason into company memory
- **Auto-ran** — agent had sufficient permission and ran without asking

Approve = agent proceeds. Reject = agent stops this path and notes the rationale.

The **Approvals** page (`/<company>/approvals`) is a superset: it also shows human-approved sub-tasks from autonomous agent runs.

---

## Weekly Wrap

Auto-generated at the end of each week. Open `/<company>/weekly`.

Shows: shipped issues, blocked issues, goal deltas, cost spend, top 3 agent runs, and the CoS's written summary.

**Reading it:** start with the summary, then skim the goal deltas (what moved vs what didn't). If a goal is red, click through — the CoS has usually already filed an issue against the responsible agent.

Weekly Wrap generation runs on Fridays automatically. If it's missing, your CoS agent hasn't heartbeat-ed on Friday — check their status.

---

## Monthly Review

Each agent gets an auto-generated monthly review card. View on the agent detail page (`/<company>/agents/<id>`).

Metrics shown:

| Metric | Means |
|---|---|
| **Heartbeats run** | Count of successful wake cycles |
| **Issues touched** | How many work items the agent moved forward |
| **Approvals requested** | Higher = agent was uncertain a lot |
| **Approval rate** | % of requests you said yes to |
| **Tokens used** | Raw LLM spend |
| **Cost ($)** | Dollar equivalent based on adapter pricing |
| **Average latency** | Heartbeat wall-time |

High approval request count + low approval rate = this agent is misaligned. Either promote their permission level down or rewrite their role prompt.

---

## Integrations

Connect external tools at `/<company>/integrations`. Current kinds:

| Kind | Auth | Department | What syncs |
|---|---|---|---|
| **Slack** | OAuth | Chief of Staff | Morning brief delivery, chat commands |
| **HubSpot** | OAuth | CRM | Pipeline, contacts, deals |
| **LinkedIn** | OAuth | Content / Growth | Post scheduling (when wired) |
| **Notion** | OAuth | Chief of Staff | Doc writes, meeting notes |
| **PostHog** | API key | Growth | Funnels, activation, UTM channels |

### OAuth flow

1. Click **Connect** next to the integration
2. You're redirected to the provider — approve FounderOS's requested scopes
3. You're redirected back — the integration shows **Connected**

### PostHog (API key)

1. In PostHog → Settings → Personal API keys → create a key
2. Paste into the PostHog row → **Save**
3. Sync runs on the next heartbeat of the Growth Lead agent

To disconnect: click the integration → **Remove**. Associated data in `integration_data` stays in the DB for audit but the token is deleted.

---

## Skills and Goals

**Skills** are composable agent workflows — think "reusable procedures" rather than LLM prompts. Go to `/<company>/skills`. Examples: "Draft outbound sequence", "Triage pipeline weekly", "Publish newsletter".

Skills are executed in the context of a **Goal**. A goal is a time-boxed outcome with a deadline and an owner (`/<company>/goals`).

Flow: **Goal** → decomposed into **Issues** → each issue may invoke one or more **Skills**. The agent owning the issue picks the skill, runs it, and reports back.

To tie a skill to a goal: open the goal → **Attach skill** → pick from your skill library.

---

## Company Memory

Long-term context FounderOS captures automatically. Includes: product positioning, ICP, decisions made, rationale from rejected proposals, past wins/failures.

It's written on:

- Approving or rejecting a decision (your reason gets stored)
- Editing company settings (the new fact gets pinned)
- Explicit "remember this" comments on issues
- Weekly wrap summaries (key shipped/blocked items)

Agents read the relevant slices of memory on every heartbeat. If an agent keeps making the same wrong call, pin a corrective memory — it's more durable than a one-off prompt edit.

---

## Permission levels

Every agent has one of four levels. Set it in **Agent → Edit → Permission level**.

| Level | Can do | Must ask |
|---|---|---|
| `observe` | Read everything, comment on issues | Anything that writes state |
| `suggest` | Propose issues, drafts, decisions | Any execution |
| `approve` | Execute anything the user has pre-approved | Net-new actions outside the pre-approval set |
| `autonomous` | Execute freely within scope | Only cross-department or budget-exceeding actions |

**Default for new agents:** `suggest`. Only bump to `autonomous` after an agent has run clean for 2+ weeks.

Lowering permission on an agent mid-run is safe — they finish the current heartbeat and the new level applies on the next wake.

---

## Costs dashboard

Open `/<company>/costs`. Shows:

- **Daily spend** — rolling 30-day chart, broken down by adapter
- **Per-agent spend** — who's burning the most
- **Per-model spend** — claude-sonnet vs claude-haiku vs gpt-4o etc.
- **Budget alerts** — set a monthly cap; warnings at 75% / 95% / over

If one agent dominates: either tighten their role prompt (less free exploration), move them to a cheaper model (Haiku), or lower their heartbeat cadence (every 2h instead of every 15min).

If everything spikes at once and it wasn't you: see [Incidents → Costs spiking](./incidents.md#costs-spiking).

---

## PWA install (mobile / desktop app)

FounderOS ships a web app manifest. Install it as an app:

**iOS Safari:** Share → **Add to Home Screen**
**Android Chrome:** menu → **Install app**
**Desktop Chrome/Edge:** URL bar → install icon (right side)

Installed PWA opens in its own window, keeps your session, and works offline for pages you've visited. Push notifications are not wired yet.

---

## Getting unstuck

| Problem | Do this |
|---|---|
| Can't log in | Ask admin (password reset isn't self-serve yet) |
| Agent stuck in a loop | Open agent detail → **Pause**, then ping your admin |
| Weird data on dashboard | Check `/activity` for what actually ran |
| Integration disconnected | Reconnect from `/integrations`; if it keeps failing ask admin |
| Everything 502 / page won't load | Instance is down — [ping admin](./admin-guide.md#tunnel-dead--vercel-502s) |

---

## Next steps

- [Admin Guide](./admin-guide.md) — if you run the instance
- [Providers](../adapters/providers.mdx) — deeper dive on LLM adapters
- [Core concepts](../start/core-concepts.md) — how agents, skills, and goals compose
