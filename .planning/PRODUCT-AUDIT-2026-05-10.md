# FounderOS Product Audit — 2026-05-10

## Executive verdict

FounderOS is not usable for a non-tech founder today without hand-holding from a developer — specifically at the agent execution step and throughout the glossary. The core infrastructure is solid (auth, billing gate, integrations, audit lineage, daily brief), and the landing page sets a clear product narrative, but the delivery gap between what the marketing page promises ("5-minute setup, zero code") and what the product requires (CLI install, API keys, runner process on the founder's laptop) is structural, not cosmetic. A tech founder who already uses Claude Code can get value in week one. A non-tech founder cannot — they will stall at adapter setup.

---

## Question 1 — Useful for a founder?

### Jobs-to-be-done coverage

| Founder JTBD | FounderOS surface | Maturity |
|---|---|---|
| Know what happened while I slept | Daily Brief page (`DailyBrief.tsx`) — generates on demand, shows KPI movements, blockers, top 3 actions | 2 — usable, but requires an agent run first |
| Approve or reject agent actions | Inbox approvals tab + `ActionRow` approve button in Daily Brief | 2 — usable |
| Track company goals | Goals page — list + `GoalTree`, create/link goals | 2 — usable |
| Run projects with my AI team | Projects page — list, create, archive | 1 — stub (no agent-task linkage visible in UI) |
| Understand what my agents are doing | AgentDetail page — run transcript, status, charts | 2 — usable for technical founders |
| Give agents context about my company | Company Memory (S6.4 data layer exists) | 0 — UI consumer-wire deferred to v1.1 |
| Receive notifications when something needs me | Notifications data layer (S6.6) | 0 — UI bell + WS push deferred to v1.1 |
| Connect Slack / Gmail / GitHub | Integration setup in onboarding | 1 — setup flow exists but recovery UX is absent |
| See my company's finances / runway | Finance page (S5 shipped revenue cockpit, runway model) | 2 — usable if Stripe + PostHog connected |
| Understand which agent spent what | AgentDetail budget card | 2 — usable |
| Get a weekly wrap | Weekly summary cron | 0 — deferred to v1.1 |
| Export my company state | FAQ says "one click exports" | 0 — not visible in the app UI |

### What it does well today

- The Daily Brief is the best thing in the product. The design and the data model (`kpiMovements`, `blockers`, `opportunities`, `topThreeActions` with approve buttons) are exactly right for a founder's morning routine. The `DailyBrief.tsx` component handles empty states, generate-on-demand, and error display cleanly.
- Inbox approvals work end-to-end. The approval flow — agent proposes, founder approves via button — is coherent and the magic-link security model is solid.
- Finance surfaces (S5) are genuinely sophisticated for an MVP: runway model, pricing simulator, LTV/CAC, scenario chat. A founder tracking burn will find real value here once Stripe is connected.
- The onboarding bootstrap is atomic and correct. The `db.transaction` wrapping in `onboarding-bootstrap.ts` means a failed bootstrap leaves zero orphan rows — a detail that matters for trust.
- Landing page copy is sharp and sets the right expectation frame ("AI executive team, not a pile of agents"). The testimonials and pricing tiers are coherent.

### What it does badly or not at all today

- **Agent execution never fires on Fly.** `onboarding-bootstrap.ts:307` maps every adapter choice to `claude_local` or `byo_runner`. `claude_local` requires the Claude CLI installed in the server container — which it is not on Fly. `byo_runner` requires the founder to install `@founderos/runner` on their laptop and keep a process running. Neither of these is self-serve for a non-tech founder. The landing page promise "AI executive team in one workspace" is not delivered.
- **Company Memory has no UI.** S6.4 shipped the data layer (DB schema, service, category CHECK constraint), but the comment in ADR-012 explicitly defers the embedder and cosine-recall UI wire to v1.1. A founder who wants to give context to their agents has no way to do it from the app.
- **Notifications do not ring.** S6.6 shipped the data layer; the bell icon and WebSocket push are deferred. A founder waiting to be notified of an agent action will not know it happened unless they manually check the Inbox.
- **The 6-tile adapter chooser (PR #105) is deceptive.** The UI shows Claude, Gemini, Codex, Google API, OpenAI API, and Anthropic API tiles. Per the production-readiness audit, 4 of the 6 handlers are not yet wired — the chosen adapter does not affect which adapter the agent actually runs. `ui/src/components/onboarding/` would need to be read to confirm the exact "coming soon" marking, but the server-side comment at `onboarding-bootstrap.ts:289-307` is explicit.
- **The company export the FAQ promises does not exist.** The FAQ answer "one click exports your whole company as a JSON file" has no corresponding button in the UI. This is direct false advertising toward a non-tech buyer.

---

## Question 2 — P0 missing features

P0 = without this, a non-tech founder cannot get value in their first week.

1. **Self-contained agent execution on the hosted instance.** Without it, the founder's agents never run without developer intervention. The current `byo_runner` pattern requires: install Node, install `@founderos/runner`, `npm install -g`, authenticate a token, keep a terminal open. That is four manual steps a non-tech founder will not complete unaided. Smallest viable shape: surface an in-app "Start your runner" panel with a copy-paste command and a live connection status indicator (the `runner_tokens.lastSeenAt` liveness ping already exists at server side). Does not fix the execution gap but makes the manual step survivable. Code target: `ui/src/pages/Settings` + a new `RunnerInstallDialog` component (one exists per CLAUDE.md — verify it is surfaced post-onboarding).

2. **Notification bell + at-minimum email fallback.** The data layer (S6.6) exists. The founder needs to know when their inbox has items requiring action. Without this, approval-gated work stalls silently. Smallest viable shape: a `notifications` badge count on the Inbox nav item, polled every 30s. No WebSocket needed for MVP. Code target: `ui/src/components/` sidebar nav + a `notificationsApi.count()` query endpoint.

3. **Company Memory UI.** The product's core differentiator over "raw Claude Code" is organizational context (the landing page explicitly calls this out). Without a way to store and surface that context from the app, every agent starts from scratch. Smallest viable shape: a read/write list of memory entries (title, body, category) on the Company or Agent settings page. The service and schema already exist at `server/src/services/company-memory.ts`. Code target: a `Memory` tab on `ui/src/pages/AgentDetail.tsx` or a dedicated `/memory` route.

4. **Honest adapter onboarding with a working path for non-CLI founders.** The current flow asks "which provider do you use?" and then ignores the answer at the agent level. A non-tech founder who picks "Anthropic API key" (the most obvious path for someone who has never used Claude Code CLI) expects their agents to run. They won't. Smallest viable shape: on the post-onboarding dashboard, show a persistent "Your agents are not running yet" banner with the exact next step for their chosen adapter, and disable the "Run" button on each agent with an explanation tooltip. Code target: `ui/src/pages/AgentDetail.tsx` `RunButton` + a new `AgentRunReadinessGate` component.

5. **Remove the false-advertising FAQ item about company export.** The FAQ reads "one click exports your whole company as a JSON file. Import it anywhere, replay it, clone it, send it to a friend." No export button exists in the app. A non-tech founder who tries to find this feature and cannot will lose trust in the entire product. Smallest viable shape: either build the export (the data is all in Postgres — a single SELECT across company, agents, goals, projects is enough) or remove the FAQ item. Code target: `ui/src/pages/Landing.tsx:1089-1092` FAQ item removal is 2 minutes; the export API endpoint is a 4-hour engineering task in `server/src/routes/companies.ts`.

---

## Question 3 — Non-tech founder usability

### First 10 minutes

1. **Lands on the landing page.** Copy is strong. The "Build your company" CTA sends them to `/auth`. No problem here.

2. **Auth page.** Email/password or Google sign-in via Supabase. Clean. Name field on sign-up. No issues visible in `Auth.tsx`. Email confirmation is required (Supabase handles it). Non-tech founder may not know to check spam. No explicit "check your inbox" copy visible in the 60 lines read.

3. **Post-auth → onboarding wizard.** The wizard collects: vision, bottlenecks, team shape, adapter choice, integrations. The adapter step is the first cliff. The wizard shows 6 tiles. Tiles that are "coming soon" should be greyed out (per CLAUDE.md), but even the working tiles (claude_local, byo_runner) require CLI installation that the wizard does not walk the founder through in-app. The wizard asks a non-tech founder to pick between "Claude Code CLI", "BYO Runner", and "Anthropic API" without explaining what those mean or what they require.

4. **Bootstrap completes.** The `maybeTriggerFirstRun()` gate requires 2+ integrations to be connected to fire the first-run orchestrator (the thing that generates the first Daily Brief). A founder who skips integrations during onboarding — which is the likely path for a non-tech founder who does not have Stripe/PostHog/LinkedIn set up yet — lands on an empty Daily Brief page with a "Generate now" button. Clicking it with no integrations produces a brief with empty `kpiMovements`, which is confusing rather than useful.

5. **Dashboard.** The founder sees Goals, Projects, Inbox, Agents. Agents show as "idle". There is no clear next action. The "Run" button on an agent will either do nothing (if the runner is not connected) or enqueue a job with no feedback on what happened. There is no "here's what to do next" UI.

6. **Total time to first value for a non-tech founder:** indeterminate. The product has no guaranteed path to value delivery in the first session without developer assistance.

### Glossary land mines

Terms in the UI that a non-tech founder will not recognize, with their location:

| Term | Location | What it means / what they need to do |
|---|---|---|
| Adapter | Onboarding wizard step 4 (adapter chooser) | Which AI provider runs the agents — requires technical setup |
| BYO Runner | Adapter tile in wizard | "Bring Your Own Runner" — requires installing an npm package and keeping a process running on their laptop |
| API key | Adapter step | Anthropic / OpenAI / Google secret key — requires creating an account and billing with the AI provider |
| claude_local | Adapter option | Claude CLI installed locally — requires `npm install -g @anthropic-ai/claude-code` |
| Runner token | Settings (RunnerInstallDialog per CLAUDE.md) | `fos_<32 alnum>` — a secret token for the runner package |
| Heartbeat | Server-side, surfaces in agent status descriptions | Background ping confirming the runner is alive |
| Composio | Integration step | Third-party integration platform needed to connect Slack, Gmail, GitHub |
| Integration | Onboarding step 5 | API connection to an external service — each requires OAuth or API key setup |
| Instance admin | Bootstrap / admin recovery | The FounderOS deployment administrator role |
| Magic link | Email auth flow | One-time-use login link |
| Autonomy level | Department settings (onboarding step) | How much the agent does without asking permission (scale 1-4) |
| BYOK | Landing page security section ("Bring your own keys") | Implicit in "BYO provider keys" — means the founder pays their own AI bills |

### Recovery from failure

Current failure states and what a non-tech founder sees:

- **Slack disconnects / token expires.** No in-app alert. The integration row status changes on the backend, but there is no notification (the bell is deferred). The founder will not know until agent runs start failing with opaque errors.
- **API key expires / rotated.** Same: no proactive alert. The agent will fail on next heartbeat; the failure surfaces in the agent run log on the AgentDetail page if the founder happens to check. No push to Inbox.
- **Runner goes offline (laptop closed, process killed).** `runner_tokens.lastSeenAt` drives the pill liveness indicator (per CLAUDE.md). If the runner goes offline, the pill turns "offline." There is no notification to the founder. Agents queue up jobs that will never be processed until the runner reconnects.
- **Render error (white screen).** No top-level React `ErrorBoundary` exists (confirmed by production-readiness audit: `ui/src/main.tsx` and `ui/src/App.tsx` have none). A JavaScript render error produces a white page with no actionable message.
- **First-run orchestrator fails.** `maybeTriggerFirstRun()` is fire-and-forget in the HTTP handler. Failure is logged server-side but the founder never knows. They see an empty Daily Brief with no explanation of why the "magic activation" did not fire.

Self-recovery is possible for a tech founder who knows to check the agent run log, re-enter API keys in Settings, and restart the runner. A non-tech founder cannot self-recover from any of the above without developer help.

---

## Top 5 P0 actions

Sorted by ROI per hour of engineering work:

1. **Add a top-level React ErrorBoundary with a human-readable fallback** (30 LOC, 1 hr). Currently a render error shows a white screen. Wrap `<App />` in `ui/src/main.tsx` with a class component that catches, logs to Sentry, and shows "Something went wrong. Reload the page or contact support." This is the single highest-leverage UX fix: it turns all unknown failures from catastrophic to recoverable. File: `ui/src/main.tsx`.

2. **Add a post-onboarding "Your runner is not connected" persistent banner with copy-paste install command** (2-3 hrs). This does not fix the execution gap — it makes it visible. The banner checks `runner_tokens.lastSeenAt`; if the runner has never connected, it shows the install command and a "token copied" button. If it has connected before but is now offline, it shows "Your runner went offline — restart it to resume." Without this, founders who complete onboarding have no idea why their agents do nothing. Files: new `RunnerStatusBanner` component + call in `ui/src/App.tsx` or the main layout.

3. **Remove the false-advertising FAQ item about company export, or ship a minimal export** (30 min to remove, 4 hrs to build). The FAQ at `ui/src/pages/Landing.tsx:1089` says "one click exports your whole company as a JSON file." No such button exists. Remove the claim now. Build the export if time allows. Trust is the P0 resource with design partners.

4. **Add a notification badge count to the Inbox nav item, polled every 30s** (3-4 hrs). The notifications data layer (S6.6) exists. A simple `GET /api/companies/:id/notifications/count?read=false` endpoint + a red badge on the sidebar Inbox link is all that is needed. This closes the "agents did something requiring approval and the founder has no idea" gap. Files: `server/src/routes/notifications.ts` (add count endpoint) + sidebar nav component.

5. **Rewrite the adapter chooser step to explain the required setup for each tile before the founder selects it, and disable tiles that do not have a working end-to-end path** (4-6 hrs). The current 6-tile UI asks the founder to pick an adapter without explaining what each requires. Add a one-sentence requirement under each tile: "Requires Claude Code CLI installed on your laptop" / "Requires an Anthropic API key ($XX/mo at typical usage)" / "Coming soon." Mark unimplemented tiles visually disabled with a tooltip. This is truth-in-advertising for the most consequential decision a new founder makes. Files: onboarding wizard adapter step component.

---

## What I didn't / couldn't audit

- **The authenticated app UI beyond what the source code exposes.** I could not navigate the live app at `founderos.fly.dev` to observe the actual first-time experience, watch state transitions, or confirm which error states are rendered vs. logged. Screenshots and UX walkthroughs are the missing layer.
- **The full onboarding wizard component tree.** `ui/src/components/onboarding/` returned a directory-read error from the worktree path. I read the route handler (`server/src/routes/onboarding.ts`) and the bootstrap service but could not read the wizard step components directly to count steps, read copy, or confirm which tiles are greyed out.
- **Real customer feedback.** No usage analytics, session recordings, or support ticket data was available. Every usability claim in this audit is inferred from code and copy — not observed from real founders.
- **Settings pages.** `ui/src/pages/Settings.tsx` did not resolve from the worktree path. I could not audit the settings flow (API key management, integration reconnect, runner token management) that a non-tech founder would need to use when things break.
- **The full PRD directory.** The `docs/prds/` directory listing failed. Only the content linked from ADR-012 and the onboarding route was accessible.
- **Fly secrets verification.** Whether `SENTRY_DSN`, `POSTHOG_API_KEY`, `STRIPE_SECRET_KEY`, and the Composio per-app auth configs are actually set on the live Fly deployment cannot be confirmed from code alone. This is flagged as a Vinamr-must-do in the production-readiness audit.
