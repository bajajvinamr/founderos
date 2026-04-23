# ADR-004 — Supabase for auth, not build-our-own

## Status

Accepted (2026-04-22)

## Context

We need email+password, Google OAuth, magic link, password reset, and server-side token verification on day one. Writing that ourselves is a month of work plus a lifetime of CVE-patching. We had better-auth wired from Paperclip, but hit two walls: limited OAuth provider coverage, and no clean story for verifying tokens on the Fly backend without a DB round-trip per request.

## Decision

Swap auth to Supabase. Keep the Fly backend stateless on verification — Supabase publishes a JWKS endpoint, we cache the public keys and verify JWTs locally. On first login, a post-signup hook (`runPostSignupBootstrap`) runs inline in the session resolver: creates the company, hires starter agents, promotes the first user to instance admin, seeds Company Memory. No separate onboarding loop.

## Consequences

- Email + Google + magic link + reset all work out of the box. Password policy, rate limiting, and session revocation are Supabase's problem, not ours.
- JWKS verification means no auth-service round-trip on every request. Good for p99.
- The inline bootstrap has a race window on first signup — two tabs can both try to become admin. Fixed in Wave 20 with an idempotent bootstrap + a route-level gate that redirects to `/auth` when pending + unauthenticated.
- One more vendor. If Supabase has an outage, new logins fail (existing JWTs keep working until they expire).
- White-label customers bring their own Supabase project — OAuth apps are per-customer, no shared tenant. Adds a provisioning step but removes a privacy land-mine.
- `BETTER_AUTH_SECRET` still set in Fly secrets as a legacy fallback path. Remove once we're confident the Supabase path is load-bearing.

## Alternatives considered

- **Clerk** — beautiful DX, but $25/mo per app minimum pricing and per-MAU costs that kill the $299/mo unit economics at scale.
- **better-auth (DIY, staying the course)** — we'd have to ship Google OAuth + magic link + JWKS ourselves. Two weeks we don't have.
- **Auth0** — enterprise pricing, feature set we won't use, and the operational surface is overkill for solo-founder self-hosting.
- **Roll our own** — hard no. Security-critical code written under deadline pressure is how breaches happen.
