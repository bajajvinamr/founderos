# Design Partner Onboarding Kit (DoubtBuddy whitelabel)

> **Audience:** the buyer / operator handing FounderOS to its first design partners.
> **Read order:** §1 (pricing) → §2 (Stripe live key flip — ONE-WAY DOOR) → §3 (outreach template) → §4 (first-week-of-customer timeline) → §5 (escalation).
> **Last updated:** 2026-05-06 (S6.10 cutover commit).

---

## 1. Pricing — Beta tier

The MVP ships with one pricing tier. Rationale: 20-50 design partners over the first ~90 days is a learning exercise, not a revenue exercise. Single tier removes the "should I pick the cheap or expensive plan?" decision from the design-partner conversation.

| Tier | Price | What's in |
|---|---|---|
| **FounderOS Beta** | **$500–$1,000 / month** | 1 workspace · 3 departments · 50,000 actions/mo · 5 integrations · email + Slack support |

**Anchor pricing:**
- $500 is the floor for genuine "I want to use this" partners — high enough to filter "free trial junkie" signups, low enough to not block a serious founder.
- $1,000 is the ceiling for partners with real revenue (>$50k MRR) where pricing is a signal of seriousness, not a barrier.
- **No multi-month contracts in Beta.** Month-to-month, cancel anytime. Trust is built by retention, not by lock-in.

**What's NOT in Beta** (defer to GA):
- Multi-workspace per company.
- > 50k actions/mo (custom quote at $1,500+).
- More than 3 departments (engineering + ops are the next two; add as they ship to the dept catalogue).
- More than 5 integrations beyond the Composio default set.
- Phone / on-call support — Beta is async (Slack + email).

**How pricing maps to the codebase:**
- Plan defaults are set restrictively in the migration (per the project kick-off rule "Default to most restrictive"). Free tier has no Stripe customer; Beta has a Stripe customer + active subscription.
- Server-side billing gate in `server/src/middleware/billing-gate.ts` enforces 402 on inactive subs at `/agents/:id/wakeup` + `/heartbeat/invoke`. **Currently OPT-IN behind `FOUNDEROS_BILLING_GATE_ENABLED=1`** — flip the flag in prod once Stripe webhook telemetry is clean (see §2).

---

## 2. Stripe live key flip — ONE-WAY DOOR

> **STOP.** This procedure modifies real-money payment processing. Read all of §2 before executing any step. Mistakes here charge real cards.

### 2.1 Pre-flight checklist

Verify each item PASSES in production before touching live keys:

- [ ] **Stripe webhook endpoint is reachable from Stripe.** Test with `stripe trigger payment_intent.succeeded --webhook-endpoint <url>`; confirm the test event lands in your server logs with a 200 response.
- [ ] **Webhook signature verification is wired correctly.** `server/src/routes/webhooks/stripe.ts` mounts `express.raw({ type: "application/json" })` BEFORE `express.json()` registers globally. This is load-bearing — `express.json()` would parse + discard the raw body and signature verification would fail on every event silently. Verified pattern documented in vinamr-invariants.staging.md.
- [ ] **Idempotency unique index on `stripeSubscriptionId`** is present (verified at `instance_subscription.ts:16` + migration). Without it, every webhook retry creates a duplicate row.
- [ ] **`FOUNDEROS_BILLING_GATE_ENABLED=0`** in prod (the default — gate is opt-in). DO NOT enable until at least 24h of clean test-mode webhook telemetry has been observed.
- [ ] **`/api/health/deep`** returns `200 ok` for `stripe_connectivity` (admin-gated; use an instance-admin credential). If anything is yellow/red here, fix before flipping.
- [ ] **Backup of `instance_subscription` table taken** via Fly MPG point-in-time-recovery snapshot. Note the snapshot timestamp — rollback target if the flip goes sideways.
- [ ] **The buyer + at least one engineer are both available for the next 60 minutes.** The flip + first live-key webhook should be witnessed live.

### 2.2 The flip itself

```bash
# 1. Set the live keys in Fly secrets (do NOT echo them; use a password manager → Fly directly).
fly secrets set -a founderos \
  STRIPE_SECRET_KEY=sk_live_<...> \
  STRIPE_WEBHOOK_SECRET=whsec_<...>

# Fly automatically restarts the app to pick up secrets. Wait for `Updating existing machines`
# in the output, then verify health is back:
curl -fsS https://founderos.fly.dev/api/readyz

# 2. Update the Stripe webhook endpoint URL in the Stripe dashboard
#    from the test-mode URL to the live-mode URL (same path, but now using the
#    live signing secret you just set).

# 3. Trigger ONE live event end-to-end with a real card (a $0.50 charge that
#    you'll refund immediately). Watch the server logs:
fly logs -a founderos | grep stripe_webhook

#    Confirm: webhook 200 received, signature verified, instance_subscription
#    row upserted, NO duplicate rows.

# 4. Refund the test charge in the Stripe dashboard immediately.

# 5. Enable the billing gate in prod ONCE (one-way door — flips behavior for
#    all customers from soft-fail to hard-402 on inactive subs):
fly secrets set -a founderos FOUNDEROS_BILLING_GATE_ENABLED=1
```

### 2.3 If something goes wrong

- **Webhook 4xx/5xx in logs:** the live signing secret in Fly doesn't match the live secret in Stripe. Re-copy from Stripe dashboard → `fly secrets set`.
- **Duplicate `instance_subscription` rows:** the unique index is missing. STOP. Roll back to the PITR snapshot from §2.1, restore the index, then re-flip.
- **Customer charged unexpectedly:** open Stripe dashboard → refund manually → in Slack thread to the buyer + engineer + your support inbox.
- **You can't tell if it worked:** disable the billing gate immediately (`fly secrets unset FOUNDEROS_BILLING_GATE_ENABLED`) — restores soft-fail mode where missing subscriptions don't block the app. Investigate offline.

### 2.4 Post-flip validation (within 24h)

- [ ] At least 1 real charge processed (a real partner subscribes for the first time).
- [ ] `instance_subscription.stripeSubscriptionId` appears for that partner.
- [ ] No duplicate rows in `instance_subscription`.
- [ ] The 402 gate fires correctly when an inactive sub hits `/agents/:id/wakeup` (test by suspending a sandbox subscription and replaying a known-good wakeup request).
- [ ] Sentry errors related to Stripe = zero.

---

## 3. First design partner outreach template

Use this as a starting point, not a script. The point of design partners is they push back on what's wrong; the email is just the door-opener.

### 3.1 Cold-warm email (founder-to-founder)

> **Subject:** quick demo? built a control plane for AI agent companies
>
> Hey [name],
>
> I noticed [specific signal — a tweet, a job listing for an AI engineer, a podcast appearance, anything except a generic LinkedIn lookup]. We've spent the last 6 weeks shipping FounderOS — a single dashboard where founders plug in their LLM agents (CoS, growth, content, finance) and run the company through an Inbox + Goals + Projects UI. The agents read your real data (Stripe, PostHog, HubSpot, Slack, Notion), surface decisions, and execute approved actions.
>
> The MVP is live: 4 default agents, daily brief, real Stripe + PostHog + HubSpot integrations, Slack + email notifications, audit trail on every action, autonomy ladder (the founder approves before anything customer-facing happens).
>
> We're picking 20-50 design partners over the next 90 days. **$500/mo Beta tier**, month-to-month, no contract. I'd want one 30-min call from you every week for feedback.
>
> If this resonates, reply with a calendar link and I'll send a screen-share of one specific decision the agent surfaced for our internal company in the last 24 hours.
>
> [signature]

### 3.2 Filter signals (who NOT to invite)

- **Pre-revenue founders** with no integrations to plug in. The agents need data to be useful; pre-revenue companies have no Stripe/PostHog/CRM data yet.
- **Founders who want a "marketing tool"** specifically (vs. an operating system). Wrong audience — refer them to a content scheduling tool.
- **Companies > 20 employees.** The product is for solo / very-small founders running a startup as a one-person shop. Larger orgs have department heads who'd push back on agent autonomy.

### 3.3 Filter signals (who TO invite)

- Solo founders or 2-person founding teams shipping at $5k–$50k MRR.
- Already use Anthropic / OpenAI APIs in production for SOMETHING (signals AI-curiosity).
- Active on Twitter/LinkedIn about ops / agent infra / "I wish I had a CoS."
- Pay for Notion + Linear + something Slack-adjacent — they already buy SaaS to delegate.

---

## 4. First-week-of-customer expected timeline

Once a design partner signs up, here's what should happen and when. Anything that DOESN'T happen on time is a red flag — investigate.

### Day 0 (signup + first hour)

- Founder hits `/signup`, completes wizard (8 steps, save-and-resume on; the migration 0102 backbone preserves draft across sessions).
- Stripe checkout completes; `instance_subscription` row appears.
- Onboarding-bootstrap fires (`server/src/services/onboarding-bootstrap.ts`); Anthropic key stored encrypted; default agents (CoS / growth / content / finance) get runtime states ready.
- If they connected ≥ 2 integrations, magic-activation gate runs (`server/src/services/onboarding/first-run.ts`): backfill 90d of events, agent-warmup, daily brief generation, "Your first brief is ready" toast.

**Expected**: founder lands on dashboard with one real daily brief inside 10 minutes of signup.

**If it doesn't happen**: check `runner_jobs` and `agent_runtime_state` for the new company id. Most likely cause: Anthropic key validation failed at `routes/onboarding.ts:291` but the bootstrap path silently fell back to `claude_local` (which doesn't run on Fly). See vinamr-invariants for the adapter mismatch gotcha.

### Days 1–3

- Founder reads daily brief on phone via magic-link (S6.7 wires this once consumer code lands).
- They approve / dismiss insights from the inbox.
- Audit log accumulates rows. Permissions matrix shows their workspace defaults.

**Expected**: they reply to your weekly check-in with at least one specific insight that surprised them.

**If they don't reply**: you have ~2-3 day window before they churn quietly. Reach out within 5 days of signup if they've gone silent.

### Days 4–7

- Their first autonomous-eligible workflow (typically churn-rescue, since S4.8 has the only autonomous template at MVP) becomes a candidate for autonomy promotion.
- The approval engine (S6.2) gates this — they explicitly approve the workflow with `promoteWorkflowToAutonomous: true` before it can fire customer-facing actions.

**Expected**: they understand the autonomy ladder (L1–L4) and have made a deliberate choice about which workflows run autonomously.

**If they're still at L1 across the board on day 7**: the autonomy story isn't landing. This is a product feedback signal — surface it to the engineering side.

### Day 7+

- Weekly summary memory entry auto-generates (S5.x weekly_summary kind on `company_memory`).
- They're ready for a structured 30-min feedback call. Take notes; they become Sprint 7 input.

---

## 5. Escalation

| Signal | Action |
|---|---|
| Stripe webhook 5xx after live-key flip | Roll back per §2.3. Do NOT retry blind. |
| Customer charged but no `instance_subscription` row | Check the unique index. Refund manually. Fix index before next charge. |
| Design partner reports a security issue | Escalate to engineering Slack + the buyer immediately. Use `requestId` from the API response (every error response carries it — see CLAUDE.md §"Every API JSON error response now includes `requestId`"). |
| `pnpm e2e` runs in CI go red on `main` | Local verification: `FOUNDEROS_E2E_PROFILE=public-only pnpm e2e` against `founderos.fly.dev`. If local-green + CI-red, it's CI infra (GitHub Actions billing exhausted as of 2026-05-02 — see CONTINUE.md standing decision #3). |
| Anthropic 529 (overloaded) — not 429 | The retry handler should already cover both. If not, see vinamr-invariants "Anthropic SDK: max_tokens is required. Omitting it throws at runtime, not at import time." |
| Composio cross-org leak suspected | The fix is closed (PR #30). When adding a new skill, you MUST resolve `connectedAccountId` from the per-org route decision. TypeScript will refuse compile if you forget. |

---

## What's NOT in this kit

- Marketing website copy (DoubtBuddy will re-skin separately).
- Branded email templates (DoubtBuddy will re-skin separately).
- Customer success playbook beyond §4 (build that as you learn from the first 5 partners).
- Pricing past Beta (revisit after first 20 partners — data tells you the right curve).

The kit covers what you need to **bring on a partner safely**. Everything else compounds from there.
