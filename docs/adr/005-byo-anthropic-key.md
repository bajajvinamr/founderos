# ADR-005 — BYO Anthropic key per customer

## Status

Accepted (2026-04-22)

## Context

Token cost dominates the economics of any agent platform. Spend-per-user is wildly variable — one customer's heartbeats might run $5/mo, another's $500/mo depending on agent count, workload, and model choice. If we bundle tokens into the subscription price, we're either pricing too high for light users, underpricing heavy ones, or running complex metering we don't want to build.

## Decision

Customers bring their own Anthropic API key. We take 0% margin on tokens. FounderOS is priced as a flat $299/mo SaaS tier plus $4k perpetual white-label licenses — pure software value, no usage component. The key lives in the encrypted key vault (AES-256-GCM envelope), validated at entry via a real Anthropic call, never logged.

## Consequences

- Unit economics are clean and boring — flat COGS per customer (Fly + Postgres + Vercel ≈ $0.23/user/mo at 100 users), 99%+ gross margin.
- No metering, no rate-limit billing logic, no "you went over your plan" emails.
- Removes the #1 objection we hear: "I don't want to pay 3-5x markup on tokens." Customers save the margin most AI platforms take.
- New customers must have an Anthropic account ready. A real onboarding friction — softened by clear setup docs and a "validate key" button that calls Anthropic before storage.
- We can't subsidize tokens as a pricing lever. No "free trial with free tokens." Free tier has to be something other than included usage (today: 3 agents, 1 company, no integrations).
- Per-agent provider preference (ADR implicit in Wave 4) lets customers mix Claude + Gemini + OpenAI + Codex. Keeps us provider-neutral — whoever wins the model race, FounderOS still works.

## Alternatives considered

- **Include tokens in the subscription** — requires real-time metering, overage handling, customer-facing dashboards, and a pricing ladder. Months of product work and real margin risk on heavy users.
- **Rate-cap per user on a pooled key** — we'd eat all the volatility, and a single noisy customer burns the pool. Bad idea at our scale.
- **Hybrid: bundled starter allowance, BYO above that** — the worst of both worlds. Still need metering, still need BYO setup. Skip.
