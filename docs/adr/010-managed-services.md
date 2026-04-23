# ADR-010 — Managed services where OAuth/security sprawl is the risk

## Status

Accepted (2026-04-23)

## Context

Solo founder, no ops team, two-week timeline. Every self-hosted dependency is a long-tail maintenance tax — patch cycles, CVE monitoring, on-call when it breaks. The riskiest categories are identity (ADR-004), integrations (ADR-008), error monitoring, and the database. Self-hosting any of those means owning a security surface we'll under-maintain.

## Decision

Lean on managed services wherever the alternative is owning a vulnerability surface we'd underinvest in. Self-host only the app code, and use Fly Managed Postgres for the database (managed anyway). Specifically:

- **Sentry** for error monitoring (server + browser SDK).
- **Composio** for integration OAuth and tool routing.
- **Fly MPG** for Postgres with continuous WAL backups, point-in-time restore, and 20-minute incremental snapshots.
- **Supabase** for auth (ADR-004).
- **Vercel** for UI hosting (ADR-003).
- **Resend** for transactional email.

## Consequences

- We don't run any database, auth, or OAuth infrastructure. The blast radius of our mistakes is narrow.
- Monthly spend goes up modestly — roughly $50-100/mo of vendor costs on top of Fly + Vercel base cost. Trivial against the gross margin.
- Each vendor is a potential outage vector. Sentry going down means we stop seeing errors, not that the app breaks. Composio going down means Composio-routed skills fail (native fallbacks still work). Supabase going down means new logins fail; existing JWTs keep working. Acceptable failure modes.
- Supply chain surface: we pull SDKs from six vendors. Mitigated by Dependabot weekly, CodeQL security-extended, gitleaks with custom Anthropic/Supabase/Stripe rules, and the OSSF scorecard workflow.
- Data residency is the vendors' problem within their regions. We pick `lhr` for Fly and document it in `HANDOVER.md`; customers with stricter residency needs get a per-instance deploy in their region of choice.
- FOSS absolutists will hate this. We're not selling to FOSS absolutists.

## Alternatives considered

- **Self-host everything (Keycloak + Sentry self-hosted + Postgres on a VM + self-hosted OAuth gateway)** — honest, infinitely cheaper at scale, and eats a week per component to set up and a day per month per component to maintain. Wrong trade for a two-week timeline with one engineer.
- **FOSS-only stack** — admirable, same time cost as above, and we'd still end up using SaaS for the hard parts (email deliverability, OAuth tokens).
- **Lean further into serverless (Cloudflare Workers + D1 + Access)** — edge-first, but our long-running agent workloads don't fit the serverless execution model (see ADR-003).
