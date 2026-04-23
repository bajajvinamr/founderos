# ADR-008 — Composio as the integrations layer (additive, not replacing)

## Status

Accepted (2026-04-23)

## Context

Every integration we wire by hand (Slack, HubSpot, Notion, LinkedIn, PostHog) is a week of OAuth plumbing, token refresh, scope management, and provider-specific API quirks. We had native clients for five providers by Wave 11. Adding the next ten at the same pace would eat the rest of the quarter. Composio's free tier covers 250+ tools with a single auth flow and SDK surface — an obvious leverage point.

## Decision

Keep the native clients we've already built as the fallback. When `COMPOSIO_API_KEY` is set on an instance and the user has connected the tool via Composio, skill invocations auto-route through the Composio SDK instead of our native client. Fail loud on Composio error — no silent dual-run, no fallback-on-error that masks a real problem. Composio is the expansion lane; native clients stay for the providers we've already shipped and for customers who prefer direct OAuth.

## Consequences

- Integration surface goes from 5 to ~250 overnight for customers who turn on Composio. Zero per-provider engineering cost.
- One auth flow for users — connect once in Composio, unlock everything they've connected.
- We don't have to maintain OAuth apps with every SaaS vendor. Composio does it.
- One more vendor dependency in the critical path. If Composio goes down, agents can't act in Composio-routed tools. Native clients unaffected.
- Skill code has to route cleanly: `if (composio.isConnected(tool)) use composio; else use native`. One branch per skill. Kept it explicit in `server/src/services/skills/*.ts` — no dynamic dispatch magic.
- Customers without a `COMPOSIO_API_KEY` get the native-client experience. No regression for existing users.
- Security posture: Composio holds the OAuth tokens, not us. For most customers that's a win (smaller attack surface on our side). For regulated customers, it's a new third party to vet. Document in `docs/runbooks/`.

## Alternatives considered

- **Pipedream Connect** — similar scope, smaller catalog, weaker agent-tool ergonomics.
- **Nango (self-hosted)** — we'd own the OAuth vault. More control, but that's the opposite of what we want: we're trying to shed OAuth maintenance, not take it on.
- **Build per-provider, forever** — honest but slow. One week per provider × 20 providers = the rest of the year gone.
- **Composio as the only path, kill native clients** — tempting, but regresses customers who already OAuth'd natively and is a harder sales story for enterprise. Additive is better.
