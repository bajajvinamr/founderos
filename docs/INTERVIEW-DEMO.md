# FounderOS Interview Demo Script

**Prep:** Have the local instance running at `localhost:3100` with Little Wins pre-populated (6 weeks of data). Vercel backup at `founderos-bice.vercel.app` if local fails.

---

## 90-Second Elevator Demo

**Length:** Exactly 90 seconds. No wasted clicks. Keep talking.

### Click Path

1. **Arrive at Dashboard** (3 seconds)
   - Say: "This is FounderOS — the AI company OS for solo founders. You get a full org chart, real agents running daily, and one dashboard to manage them all. We've pre-loaded Little Wins, an Indian ed-tech company screening children for developmental delays."
   - Scroll down to show the pulse: MRR, burn, runway, stage.

2. **Decision Inbox** (15 seconds) — `/LW/decisions`
   - Say: "Founders were copy-pasting agent outputs into Discord and losing track of what they'd approved. The Decision Inbox is the single biggest improvement over raw Claude — when an agent can't decide, it asks here. You see the proposal, the rationale, approve or reject in one click."
   - Click one decision to expand. Read the proposal aloud (~2 sentences). Approve it.
   - Say: "Agent picks it up on the next heartbeat."

3. **Weekly Wrap** (15 seconds) — `/LW/weekly`
   - Say: "End of week, auto-generated. Shipped issues, blocked issues, goal deltas, top 3 agent runs, and the CoS's written summary. This is how you stay sane when you have 20 agents."
   - Point to goal deltas section. Show one red goal if available.

4. **Department Console** (20 seconds) — `/LW/departments/growth`
   - Say: "Each department — Growth, Content, Finance, CoS — has one lead agent. Click the Growth console. You see their current issues, recent runs, and integration status. The Growth agent is synced to PostHog and HubSpot. Every heartbeat they pull updated metrics and surface what needs attention."
   - Click one issue to show the agent's reasoning. Skim the transcript.

5. **Company Memory** — click the Memory section or nav to `/<LW>/company/settings` (10 seconds)
   - Say: "Long-term context we capture automatically. Product positioning, ICP, past decisions and their rationale. Agents read slices of this on every heartbeat. If they keep making the same mistake, you pin a memory — it's more durable than editing prompts."

6. **Monthly Review** (20 seconds) — back to Agents list, pick one agent, click the Review tab
   - Say: "Every agent gets a monthly card. Heartbeats run, issues touched, approvals requested, tokens used, cost in dollars. High approval-request count + low approval rate = the agent is misaligned. That tells you to rewrite their role or lower their permission."
   - Point to one agent's cost and latency metrics.

7. **Integrations tab** (10 seconds) — `/LW/integrations`
   - Say: "Slack for morning briefs, HubSpot for pipeline, PostHog for funnels, Notion for docs. Each integration is OAuth'd once, then the agent reads/writes sync on every run. No extra setup per-agent."

**Close (5 seconds):** "In 90 seconds, you've seen the full loop: agents propose decisions, you approve, they execute, and you review weekly. That's the whole company OS."

---

## 5-Minute Deep-Dive Script

**Length:** 5 minutes, 2 minutes slower than the elevator. Deeper context on the why and differentiators.

### Beat 1: The Problem (1 minute)

Start at Dashboard. Scroll to show the company pulse.

"FounderOS solves a specific problem: solo founders can't afford a full team, but they can afford Claude. The problem is **orchestration**. You can run agents, but then you have 20 Claude windows, you're copy-pasting outputs into spreadsheets, and you have no idea who approved what.

Most 'AI founder tools' are just Claude prompts wrapped in a UI. They don't solve the coordination problem. Paperclip lets you write custom agents, but everything is ad-hoc — no standard way to request decisions, no memory, no permissions, no integrations.

FounderOS builds the operating system layer *on top* of Claude. Four primitives: **departments** (who runs what), **decisions** (how agents ask for approval), **company memory** (long-term context that sticks), and **integrations** (so agents read real data, not hallucinations)."

### Beat 2: Departments & Agents (1 minute)

Navigate to `/LW/agents/all`.

"Agents are grouped into departments. We ship five pre-wired ones: Chief of Staff (weekly wraps, routing), Growth (PostHog, funnels), Content (drafts, scheduling), Finance (burn, invoices), CRM (HubSpot pipeline).

Each department has one lead and ICs. The lead wakes up on a heartbeat — every 30 minutes, every hour, whatever you set. They check their issues and move forward. If they're stuck, they ask the Decision Inbox."

Click into one agent. Show heartbeat cadence, permission level, adapter.

"Every agent has four permission levels: **observe** (read-only), **suggest** (propose work), **approve** (execute pre-approved tasks), **autonomous** (run freely within scope). New agents default to suggest. Only bump to autonomous after 2 weeks of clean runs. This is how you build trust."

### Beat 3: Decision Inbox (1 minute)

Go to `/LW/decisions`.

"Here's the insight: founders make better decisions faster when agents ask crisp questions, not dump 2000-word analysis. Every decision shows the proposal, the rationale, and one call — approve or reject.

When you approve, the agent picks it up on the next heartbeat and executes. When you reject, they write the rationale into company memory, so next week they don't propose the same thing.

The 'Auto-ran' section shows decisions the agent had permission to make alone — transparency without busywork.

Vs. Paperclip: Paperclip has no decision layer. Agents either run or they don't. You have no way to steer mid-week without editing prompts. Vs. raw Claude: Claude gives you output, not decisions. The Decision Inbox is the governance layer."

Click one to show the approval flow.

### Beat 4: Company Memory (1 minute)

Go to `/LW/company/settings` and show the Memory section or click a company memory card.

"Long-term memory is written to automatically when you approve/reject a decision, edit company settings, or mark a memory explicitly. It captures your ICP, product positioning, decisions made and their rationale, past wins/losses.

Agents read relevant slices on every heartbeat. If you notice a pattern (e.g., the Growth agent keeps proposing email when you've rejected it 3 times), you pin a corrective memory — e.g., 'We don't do email campaigns; we focus on paid ads.' That memory survives across weeks of iterations.

Vs. Paperclip: Paperclip has no memory layer. You edit the agent's system prompt, and hope you remember to do it. Vs. managing prompts in a spreadsheet: memory is queryable, timestamped, and tied to decisions."

### Beat 5: Weekly Wrap & Metrics (1 minute)

Go to `/LW/weekly`.

"End of week, auto-generated. The CoS summarizes shipped issues, blocked issues, goal deltas, cost spend, and top 3 agent runs. This is how you avoid checking Slack every 5 minutes.

Then we have two review workflows: **Monthly agent reviews** (heartbeats run, issues touched, cost, latency, approval rate) and **Monthly goal reviews** (on track, off track, why). If a goal is red, the CoS usually filed an issue already. Click through and the agent will unblock it on next heartbeat.

Vs. Paperclip: no built-in cadence. You have to manually ask agents to generate reports. Vs. Lindy: Lindy is workflow automation, not org structure. You're still writing the recipes."

Point to the goal deltas and show one that's off track.

---

## Architecture Talking Points (1 page, CTO-level)

**For when the conversation shifts technical, or someone asks "how is this built?"**

### Monorepo & Workspace Shape

- **pnpm workspaces** — cleanly separated packages: `@founderos/ui` (React Vite SPA), `@founderos/server` (Node+Express), `@founderos/db` (Drizzle ORM + schema), `@founderos/shared` (Zod schemas, types, utilities).
- **TypeScript across the stack** — full end-to-end type safety. Schema definitions in Drizzle → Zod validators → React hooks.
- **Single `pnpm dev`** — both dev server + UI start together. HMR on UI changes, auto-restart on server changes.

### Auth Story (Supabase Now, Better Auth Before)

- **Wave 15 swap:** migrated from Better Auth to Supabase Auth. Why? Supabase is more mature on OAuth + email+password + magic link, and we needed faster post-signup bootstrap.
- **Post-signup bootstrap:** when a user signs up via OAuth (Google) or email, a post-login hook runs `runPostSignupBootstrap` — auto-creates a company, hires starter agents, writes memory. No separate onboarding loop for the second+ user on a white-label instance.
- **JWKS verification:** Supabase posts a public JWKS endpoint. We validate ID tokens server-side without a DB round-trip. Session tokens are JWTs; refresh tokens are Supabase-managed.
- **White-label implications:** every customer's Supabase project is separate (OAuth app per customer). Their users sign in via Supabase, not our central tenant. Each instance owns auth + billing.

### Deployment Split (Vercel UI + Fly Backend + Fly Postgres)

- **Vercel (UI):** static SPA + `vercel.json` rewrites. `/api/*` rewrites to `$FOUNDEROS_BACKEND_URL/api/*` — transparent proxying. The UI never knows the backend URL; env vars control it server-side. No CORS, no extra round-trips.
- **Fly backend:** Node+Express on Fly machines. Deploy with `fly deploy`. Liveness + readiness probes. Single-tenant per customer — each instance gets its own machine.
- **Fly Managed Postgres:** attached volume for encrypted state (secrets master key). Continuous backups (full + incremental WAL). Restore-to-point-in-time via `fly mpg restore`.
- **Cold starts:** Fly machines stay warm with heartbeat health checks. First-time agent run ~500ms, subsequent runs ~200ms (warm container).

### Drizzle Migrations & The Journal Gotcha

- **Migrations are SQL files** — `packages/db/src/migrations/*.sql`. Drizzle generates them from schema changes.
- **The journal is critical** — `meta/_journal.json` tracks migration order and metadata. If you drop a SQL file without a journal entry, `pnpm check:migrations` fails.
- **Always use `pnpm generate`** — writes both the SQL + updates the journal. Never hand-drop files. If you did, manually add the journal entry: `{"idx": <next-idx>, "when": <timestamp>, "tag": "<name>", "breakpoints": true}`.
- **Snapshots** — `meta/<idx>_snapshot.json` captures the schema state after each migration. Regenerate if missing.

### Permission Model (Observe / Suggest / Approve / Autonomous)

- **Four levels, one decision per agent:** how much can they do without asking?
- **Observe** — read everything, comment on issues. No state writes.
- **Suggest** — propose issues, draft decisions. No execution.
- **Approve** — execute pre-approved tasks. Must ask on net-new work.
- **Autonomous** — execute freely within scope (department boundary). Only ask for cross-department or budget-exceeding actions.
- **Why this design?** — it maps to trust-building. New agents start at suggest. After 2 weeks of clean runs + low approval-request count, you promote to approve. After monthly review showing alignment, you move to autonomous.
- **The moat:** most AI tools skip this. They're either "ask every step" (useless) or "run free" (dangerous). This layer is where human judgment shapes agent behavior.

### Integration Pattern (OAuth Provider Registry + integration_data)

- **Provider registry** — each integration kind (Slack, HubSpot, PostHog, Notion, LinkedIn) has an adapter. OAuth flow is standard: redirect → approve scopes → callback → store token.
- **integration_data storage** — we store `{kind, type, value}`. For Slack, `kind="slack"`, `type="workspace_id"`, `value=<workspace-id>`. For PostHog, `type="api_key"`, `value=<encrypted-key>`. Agents query `integration_data` to find what's available.
- **No per-agent wiring** — integrations are company-wide. Any agent in the Growth department can read the PostHog integration. Permissions are department-level, not integration-level.

### Multi-Agent Orchestration (4 Primitives)

1. **Departments** — organizational groups. Each has a lead (senior agent) + ICs.
2. **Skills** — reusable agent workflows. E.g., "Triage pipeline", "Draft outbound sequence". Skills are composable; multiple agents can invoke the same skill.
3. **Decisions** — approval checkpoints. Agents ask, humans decide, rationale is captured in memory.
4. **Company Memory** — long-term context. Agents read slices on every heartbeat. Memory is queryable + timestamped.

**How they compose:** A **Goal** (outcome) is decomposed into **Issues** (work items). Each issue may trigger a **Skill** run. Agents execute the skill, hit a **Decision** if they're uncertain, and their approvals/rejections feed back into **Company Memory**. Next week, a new agent reads that memory and adjusts their behavior.

### Cost Model & Margins

- **Per-customer infra:** Fly machine (~$3–5/mo), managed Postgres (~$2–8/mo depending on size), Vercel (free tier if <100GB/mo bandwidth, then $20–50/mo).
- **Agent cost:** Claude Haiku at $1–2/1M tokens (cheap heartbeat). Sonnet at $3–5/1M (deeper thinking). Daily heartbeats for 20 agents = ~$0.01–0.10/day in tokens (varies by workload).
- **White-label margin:** sell at $4k perpetual license + $299/mo SaaS + they bring their Anthropic API key. Their LLM cost is separate (they own it). Our margin is 99% gross on the license, 90% gross on SaaS (minus Fly + Vercel infra).

---

## Business Talking Points (1 page, Sales/GTM)

### Jobs-to-be-Done Framing

Founders don't want agents. They want **decisions made**. Raw Claude is a research tool, not a decision-maker. Paperclip is powerful but chaotic — no standard layer for "ask, approve, execute, remember." FounderOS is that layer.

**The insight:** founders spend 30% of their time on "meta" — who did what, what was approved, what failed last week? We turn that 30% into a machine.

### $4k Whitelabel + $299/mo SaaS Thesis

- **Whitelabel:** buy the codebase, deploy it for your customer base, charge what you want. We get $4k one-time, then you own the install.
- **SaaS:** use our hosted instance at founderos.app (coming Wave 16). $299/mo per company + customer brings their API key. Lower CAC than sales-heavy models.
- **Why BYO API key eliminates the #1 objection:** most SaaS AI tools lock you into one LLM provider and charge 3-5x markup. FounderOS is provider-neutral (Claude, Gemini, GPT-4 all work). You bring your key = no vendor lock-in + no margin pressure on us. Customers save 70% on LLM costs vs. other platforms.

### Why Paperclip is the Right Base + Why the Wrapper Matters

- **Paperclip:** open-source MIT, 40+ agents wired, active upstream velocity. Don't reinvent.
- **Our wrapper:** Paperclip is raw agent orchestration. We add the OS layer: departments (organization), decisions (governance), memory (learning), integrations (real data), and permissions (trust-building). The wrapper is defensible because it solves the "what do I do with 20 agents?" problem that Paperclip doesn't touch.
- **Upstream sync:** we merge improvements from Paperclip into our codebase. When Paperclip ships new agents, our customers get them automatically.

### Unit Economics at 100 Users (Rough)

| Item | Cost / User / Month |
| --- | --- |
| Fly Postgres | $0.07 |
| Fly machine | $0.15 |
| Vercel | $0.01 |
| Anthropic tokens (2M/mo per agent × 20 agents) | $0.40 (customer bears this) |
| **Total FounderOS infra** | **$0.23** |
| **Gross margin at $299/mo** | **99.9%** |

Revenue: $29,900/mo. COGS: $23/mo. Gross profit: $29,877/mo.

### Moat Plan

1. **Cross-company benchmarks** — "your Growth agent costs $0.10/issue, theirs costs $0.15. Here's why." Anonymized, voluntary, addictive.
2. **Skills marketplace** — users upload skills they've built. "I wrote a 'win-back campaign' skill; buy it for $50." Commission = 30%.
3. **Fine-tuning layer** — we fine-tune small models on company memory. FounderOS-tuned Haiku outperforms generic Haiku on your company-specific tasks. Reduces token spend 20–30%.

### GTM: Why Solo Founders, Not SMBs

- **SMBs want a person** (sales consultant, fractional CFO). They don't want agents. Solo founders ARE the market — they run the whole org themselves.
- **Warm audience:** founder communities (Indie Hackers, Stripe Community, OpenAI Creator), accelerators (Y Combinator, 500 Global), founder Slack groups. Join, be helpful, mention FounderOS when relevant.
- **PLG motion:** product is valuable in trial (free tier: 3 agents, 1 company, no integrations). Founder tries, hits the friction at 3 agents, upgrades to $299/mo.
- **BYO key removes friction:** Anthropic API key doesn't cost anything upfront. Trial cost = $0. Conversion risk = low.

---

## Likely Questions + Tight Answers

### 1. "How is this different from Paperclip?"

Paperclip is raw agent orchestration — pick roles, write prompts, agents run. FounderOS adds the **operating system layer** — departments (org structure), Decision Inbox (governance), Company Memory (learning), integrations (real data), and permissions (trust-building). Paperclip says "run this agent," we say "organize your whole company and let agents propose, you decide." One level higher.

### 2. "Why not just use Claude directly?"

Claude is a research tool. You ask, Claude answers, you copy-paste into Slack. Scale that to 20 agents and you're drowning in Discord threads. FounderOS is **orchestration + memory + governance**. You get decisions logged, approvals enforced, memory captured, integrations synced. 20 agents, one dashboard.

### 3. "What happens when an agent makes a mistake?"

Three layers: (1) **Permission level** — low-permission agents ask before executing. (2) **Decision Inbox** — if they propose something risky, you reject it and the rationale goes to memory. (3) **Activity log** — every state change is audited. You can roll back, see what ran, and adjust the agent's role on the next heartbeat.

### 4. "How do you handle hallucinations?"

Real data + company memory. Most hallucinations come from stale or absent context. We sync integrations (HubSpot, PostHog, Slack) so agents read real metrics, not made-up numbers. And Company Memory captures ground truth — "we don't do email," "ICP is mid-market SaaS," etc. Agent reads that on every heartbeat and adjusts.

### 5. "What's your moat when OpenAI ships Agent Builder?"

OpenAI's Agent Builder will be like Paperclip — raw agent choreography. The moat is the **OS layer**: departments, decisions, memory, integrations, and permissions. That's not trivial to copy. Also, we're provider-neutral — whether OpenAI or Anthropic wins, FounderOS works. We have no vendor lock-in.

### 6. "Can customers take their data out?"

Yes. Export your company JSON at any time (`/company/export`). It includes org chart, agents, issues, memory, decisions, everything. Import it into a fresh FounderOS instance and you're restored. We also offer Notion sync for long-term memory and HubSpot sync for CRM data. No data prison.

### 7. "What's your pricing?"

Whitelabel: $4,000 perpetual. Deploy it, own it, charge your customers whatever. SaaS (coming Wave 16): $299/mo per company. Customers bring their Anthropic API key — LLM costs are separate, on them. No seat-based, no per-agent licensing. Simple.

### 8. "Why solo founders, not SMBs?"

Solo founders ARE the market. They run the whole org themselves, so agents make sense. SMBs want a fractional CFO or consultant (a person). Also, warm audience: Indie Hackers, YC, founder Slacks. Easy to reach, easy to convert if product is good.

### 9. "What's the hardest thing you've shipped?"

The permission model + Decision Inbox. Sounds simple, but the UX is razor-thin — you need to ask the right question, capture the decision cleanly, surface it in the inbox without drowning users, and then automate the "agent got approval, go execute" loop. Took 3 weeks of iteration. Still tweaking.

### 10. "What would you do differently?"

Started with Paperclip too late. If I rewound, I'd fork it from Wave 1, not Wave 10. Would have saved 2 months. Also, auth. We burned 2 weeks on Better Auth before moving to Supabase. Lesson: pick boring, proven infra early.

### 11. "What's the next 90 days?"

Wave 16: SaaS instance at founderos.app, invite + email magic-link auth, Stripe integration for billing. Wave 17: skills marketplace (users upload/buy reusable workflows). Wave 18: fine-tuning layer (FounderOS-tuned models for cheaper token spend).

### 12. "Why you?"

Built and shipped 12 waves of product in 6 months solo. Know the founder pain — wore every hat (CEO, CTO, ops, sales). Also, deep Claude expertise (shipped 500+ prompts, know which models work for what). And pattern-recognition: saw Paperclip + realized the missing layer was operating system, not agents.

---

## Fail-Safes (What to Do If Something Breaks Live)

### Local Instance Won't Boot

```bash
# If http://localhost:3100 is dead:
# 1. Check the terminal — any errors?
#    pnpm dev (if you killed it)
#
# 2. Clear node_modules cache
#    rm -rf node_modules && pnpm install && pnpm dev
#
# 3. Fall back to Vercel
#    "Let me pull up the production instance instead" → 
#    https://founderos-bice.vercel.app
```

**What to say:** "The local instance is warming up — let me grab the production build instead. It's the same code, just on Vercel. No loss of features."

### Agent Timeout or Slow Run

```
Agent runs but takes 30+ seconds. In the run transcript:
"Hmm, that one's thinking hard. Notice it's in 'approve' mode — so even if it
times out, nothing executes without me. Let me show you the permission model..."
```

**Pivot:** click Agent detail → Permission level tab. Show the four levels. This buys you 30 seconds and explains a key differentiator.

### Decision Inbox Empty or Stale

```
"Little Wins' agents usually propose decisions between 8–9 AM UTC (their time zone).
If the inbox is empty right now, it means they haven't heartbeat-ed yet. Let me click
Agents and show you the last run times..."
```

Click `/LW/agents/all`, sort by "Last run". Pick the Growth lead and click → run transcript. This shows the agent is alive and why no decisions are pending.

### Auth Issue (Can't Log In)

```
"The instance uses Supabase Auth — Google OAuth, email+password, magic link.
If login fails, it's usually:
1. Invalid Supabase project config (env var mismatch) — check /instance/settings/general
2. Supabase project is down (rare, but check status.supabase.com)

In a demo, I'd have the admin user pre-logged in, so no login needed.
If it happens to you: refresh, or ask the admin to check Supabase."
```

### Dashboard Loads but Data is Stale

```
"Company data is cached with TanStack Query. If you change something and it doesn't
show, that's a 10-second cache hit. Refresh the page or wait 10 seconds."
```

### Integration Disconnected

```
"Integrations auto-refresh on the next agent heartbeat. If you see 'disconnected':
1. Click it → click 'Reconnect'
2. You'll be sent to the provider (Slack, HubSpot, etc.) to re-approve
3. You're redirected back and it's live on the next heartbeat

Takes ~1 minute. No data is lost."
```

**What to say:** "Let me reconnect that — this usually means the OAuth token expired. It's a quick re-approve."

---

## Pre-Interview Checklist

- [ ] Local instance running: `pnpm dev` at `/Users/vinamr/Projects/founderos`
- [ ] Little Wins company pre-populated with 6 weeks of data
- [ ] At least one decision pending in Decision Inbox (or agent runs on click)
- [ ] One agent in Approve mode (not Autonomous — safer for live demo)
- [ ] Vercel backup URL memorized: `founderos-bice.vercel.app`
- [ ] Anthropic API key set in Instance Settings (agents need it to run)
- [ ] Network stable (bandwidth for video call)
- [ ] Terminal hidden (clean desktop)
- [ ] Slack / email silenced (no notifications during call)
- [ ] Walk through the 90-second script 2x alone before interview
- [ ] Have architecture & business talking points printed or on second screen

---

## Notes for You

- **Pacing:** in the 90-second demo, you're moving fast. Let the UI do the talking — don't over-explain each screen, just hit the highlights. For the 5-minute version, slow down 50% and dig into the "why" (Decision Inbox beats raw Claude, Memory sticks better than prompts, etc.).
- **Data matters:** if you show decisions/metrics/costs that are 0 or obviously fake, it breaks credibility. Make sure Little Wins has real-looking data.
- **Tone:** builder-to-builder. Confident but not rehearsed. "Let me show you something we discovered" not "and then the decision inbox feature..."
- **Interactivity:** if they ask a question during the demo, **pause the demo** and answer deeply. Don't robot through the script. This is a conversation, not a pitch.
- **Backup plans:** if Fly is down or instance won't start, shift to Vercel instantly. Interviewers won't care — they want to see the product work, not your infra.

Good luck tomorrow.
