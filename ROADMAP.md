# FounderOS Roadmap

Last updated: 2026-04-20

The product's job: **let a solo founder run a million-dollar company as a party of one.** Everything we build either serves that mission or gets cut.

---

## Where we are today

**Shippable:** The core product works end-to-end. A founder can land on the marketing site, sign up, pick a template, connect a provider, spawn a full AI company (CEO + reports, goals, projects, starter backlog), and open the Morning Brief.

**Surfaces built**

| Surface | State |
| --- | --- |
| Landing page | Done — Pulse Builders register, 13 sections, humanized copy |
| Auth (Clerk + better-auth hot-swap) | Done |
| 4-step onboarding wizard | Done — welcome → template → providers → launch |
| Template system | Done — 3 built-ins, export, import, clone |
| Multi-provider (Claude, Codex, Gemini — CLI or API) | Done — including strategy picker + demand analysis |
| Morning Brief (Dashboard hero) | Done — narrative, decisions, wins, today's focus, runway, brief-the-team |
| Team roster (3 views: roster cards, list, org tree) | Done — with ROI chip + budget bar |
| Teammate detail (Overview, Brief, Setup, Work log, Pay) | Done — employment-register vocabulary |
| Costs + Activity + Companies + Org + Skills + Instance settings | Inherited from core — business-first copy pass done |
| Encrypted instance key vault (AES-256-GCM) | Done |
| Fly.io deploy pipeline | Done — `fly.toml` + `Dockerfile` + provision + smoke scripts |

**Test surface:** 797 server tests passing, full typecheck clean on UI + CLI.

**Deploy state:** Production infra wired, not yet running in prod — live demo is a Cloudflare quick tunnel.

---

## P0 — Ship-blocker (this week)

What has to be true before the product can be shared with a paying pilot.

### 1. Live, stable production URL
- **Provision `founderos-demo` on Fly.io** with Managed Postgres in Mumbai.
- Smoke test via `scripts/fly-smoke.sh`.
- Attach a friendly domain (e.g. `demo.founderos.ai`) via Fly certs.
- **Blocker:** MPG create needs to run — either via explicit user-level Fly permission in Claude settings, or the user running `! fly mpg create --name founderos-db --region bom --plan basic --volume-size 10 --pg-major-version 17` in the shell.

### 2. Company Charter
**The single highest-leverage founder feature we're still missing.**

A writable markdown field per company: "what we're building, who for, why it matters." Stored in `companies.metadata.charter`. Injected into every teammate's standing prompt on every shift.

Makes agents aware of the mission without the founder having to repeat themselves in every brief.

- Data: extend `companies.metadata` JSONB with `charter` string.
- UI: new "Charter" card on CompanySettings + first-class nudge on the Dashboard when empty.
- Server: template-spawn writes a default charter based on the template; every adapter prepends the charter to its system prompt.
- Onboarding: step 4 "Launch" adds a one-line charter input (optional — can skip, prefill from template).

Effort: 0.5 day.

### 3. End-to-end smoke test of the cold-start journey
Playwright script that covers: land → sign up → spawn a company → see Morning Brief → "Brief the team" → open a teammate → "Start shift" → read work-log.

Catches the classic "works on my machine" regressions before they reach a real person.

### 4. Minimal `docs.founderos.ai`
Even 3 pages: *Getting started*, *How providers work*, *Self-hosting on Fly*. Linked from the landing footer (currently just points at a 404). Mintlify is already configured — `pnpm docs:dev` works locally.

### 5. Email handling for signups
When someone signs up on the live instance, they should get a welcome email. Currently zero email plumbing. Resend or Postmark, 20 lines.

---

## P1 — Near-term (2 weeks)

These are the features a pilot customer will notice missing in their first week.

### Weekly Wrap
Sunday-evening digest. "This week Acme Labs shipped 14 issues, closed 3 deals, spent $340. Next week's top 3 priorities are X, Y, Z." Auto-drafted by the CEO teammate, delivered via email + a `/weekly` route. This is what makes the product sticky — the founder *waits* for this on Sunday.

### 1:1 with a teammate
A right-panel chat drawer on each teammate's Overview tab. Founder types: *"Skip the Q4 content plan for this week, focus on outbound."* Writes to the teammate's standing instructions; takes effect next shift.

### Audit-log viewer
Activity log already captures events; need a filterable, exportable view. Required for any enterprise-ish conversation + our own "what went wrong" investigations.

### Billing surface (read-only for now)
Stripe integration that just *records* MRR. Pricing tier gate at $10k MRR is in the copy but enforced nowhere. Read-only billing view on Settings tells the founder what we'll eventually charge.

### Team ROI dashboard
Currently we have a ROI chip per card. Need a proper `/team/roi` view: teammates sorted by cost-per-closed-issue, comp utilization chart, "hire more / fire / reallocate" recommendations from the CEO teammate.

### Responsive polish
Landing + product look OK on mobile but feel unloved. One afternoon sweep: fix breakpoints, test on 375px, polish the Morning Brief card stacking.

---

## P2 — Medium-term (1 month)

### Integrations — the ones that matter for a real company
1. **GitHub** — link repos, auto-surface PRs in Morning Brief, let the CTO teammate open PRs back.
2. **Slack** — forward Morning Brief to a Slack channel; brief-the-team accepts Slack DMs as input.
3. **Calendar (Google / Cal.com)** — meeting awareness. "You have a call with Acme at 3pm. Atlas has prepped these notes."
4. **Email (Gmail / IMAP)** — Head of Growth teammate reads + drafts replies.
5. **CRM (Attio / HubSpot)** — pipeline sync for the Growth teammate.

### Brief-the-team v2
Promote from "pre-filled new issue" to a proper composer. Mentions (`@Nova`, `@Atlas`) that fan out. Priority picker. Preview of which teammates will receive it. Works from the keyboard shortcut `b`.

### Custom role creation with LLM-assisted brief writing
Founder types: *"I want to hire a community manager."* The CEO teammate proposes a role description, reports-to, initial goals, monthly comp. Founder reviews, confirms, hires.

### Workspace / multi-company UI
The data model already supports multiple companies per user. The UI assumes one. Rebuild CompanyRail to feel like a real workspace switcher.

### Plugin marketplace
Plugin SDK exists. Need a public browseable catalog. Start with first-party only.

### Docs site fleshed out
- Full adapter catalog with setup steps per provider.
- API reference generated from Zod schemas.
- Self-hosting guide on Fly / Render / Railway.
- Security whitepaper.

---

## P3 — Longer-term (next quarter)

### Mobile
- Morning Brief as a PWA / iOS app. Founders check it with their coffee.
- Push notifications for blocked teammates and approvals.

### Compliance track
- SOC 2 Type 1 prep — policies, vendor reviews, log retention.
- DPA + vendor-of-record docs.
- A customer-facing trust page.

### Enterprise seed
- SSO / SAML.
- Audit log API.
- VPC-pinned deployments with our help.
- "Scale" tier of pricing actually live.

### Growth / community
- Public changelog with editorial release notes.
- Blog with operator-style content ("Here's how agnost.ai runs on 3 teammates").
- Discord or Circle community.
- Email drip for new signups — day 1 welcome, day 3 "here's how founders are using the Morning Brief", day 7 check-in.

### Referral program
- "Refer a founder" — they get 3 months free Scale tier, you get them too.
- Tracked via a one-click invite link.

### Performance reviews
- Monthly "how did this teammate perform" summary auto-drafted by the CEO.
- Comparable-across-teammates scoring (issues closed, cost efficiency, blockage rate).

---

## What we are explicitly NOT doing yet

Cutting these keeps the product sharp. Revisit only when a specific customer blocks on them.

- **A visual org-chart editor.** Reports-to is edited per-teammate for now; drag-and-drop org charts are expensive UX debt.
- **A prompt IDE for the Brief field.** It's a textarea. Don't build a Prompt-Studio inside us.
- **Meeting recorder / transcriber.** That's Granola / Fathom's job. We consume their output later.
- **A vector DB for company context.** The charter + standing instructions are enough for v1. Add retrieval when a specific teammate is measurably struggling on recall.
- **Multi-model evals.** We route to one provider per teammate. Cross-provider A/B is a research feature, not a founder feature.
- **Our own LLM.** Obvious but worth saying.

---

## Operating principles

- Ship the thing the founder uses in the first 30 seconds of their day, then the thing they use in the last 30 seconds, then the thing they use Sunday night. Everything else waits.
- Every new surface starts with *"what does a founder look at when they open this screen — and what do they do with it?"* If the answer isn't one sentence, we don't build it.
- Business-first language. No heartbeats. No adapters in the UI. Employment register on every button.
- Copy is written by a founder talking to a founder. No AI-tells, no marketing fluff, no "comprehensive" / "robust" / "nuanced."
- The core engine stays open-source MIT. The hosted experience is where we charge.
