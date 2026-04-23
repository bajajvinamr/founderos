# ADR-009 — Tenant isolation via `req.actor.companyIds` + route-level assertion

## Status

Accepted (2026-04-23)

## Context

FounderOS is multi-tenant at two levels: one instance can host multiple companies (a user belongs to N companies), and a single user can switch between companies in the UI. Any route that accepts `companyId` from the request body or path is a tenant-leak surface — if we forget a check, a user in company A can read/write data in company B. With 80+ routes and growing, ad-hoc checking is how breaches happen.

## Decision

Two layers, both required:

1. **Middleware**: `requireCompanyAccess` resolves the actor from the auth token, loads their `companyIds` into `req.actor`, and blocks any request where the route's `companyId` isn't in that set.
2. **Per-handler assertion**: `assertCompanyAccess(req, companyId)` is called at the top of every handler that reads/writes company-scoped data. Belt-and-braces — the middleware catches most paths, the assertion catches the ones where `companyId` comes from somewhere other than the path.

Defense-in-depth: agent tokens are scoped to a single `companyId` at issue time. An agent operating in company A physically cannot present a token that authenticates against company B.

## Consequences

- Two independent checks have to pass before a cross-tenant read succeeds. Either one catches the leak.
- Every new route has a checklist: does it take `companyId`? Then it needs the middleware + the assertion. Enforced by PR review.
- Agent skill invocation is naturally tenant-scoped — the token used to call the skill already carries the company. No extra guard needed in skill code.
- Some routes (reports, global dashboards) legitimately span companies for instance-admins. These have an explicit `requireInstanceAdmin` path that bypasses `requireCompanyAccess`. Narrow carve-out, documented in each handler.
- The router bug fixed in the `f198121` commit — "route roots that weren't registered were mis-parsed as company prefix" — was caught because the middleware fired loudly on a path it didn't recognize. Good signal that the check is load-bearing.

## Alternatives considered

- **Schema-level RLS (Postgres row-level security)** — strongest guarantee, but brittle with Drizzle's current RLS story and awkward when the server sometimes needs cross-tenant reads (admin tooling, backups, reports).
- **Request-interceptor sniffing (auto-inject `WHERE company_id = ?`)** — magical, hard to audit, fails on joins. Too clever.
- **Per-tenant database / schema** — strongest isolation, wrong shape for our pricing (shared Fly Postgres cluster, small customers).
- **Only the middleware, skip the handler assertion** — fine until one route has a handler that takes `companyId` from the body instead of the path. Belt-and-braces is cheap; use both.
