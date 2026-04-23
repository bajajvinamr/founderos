# ADR-002 — pnpm monorepo over multi-repo

## Status

Accepted (2026-04-21)

## Context

The UI (React/Vite SPA), the server (Node/Express), and the Drizzle schema all share types. A change to the `Decision` type touches the schema, the server route, the shared Zod validator, and the UI hook in the same PR. Splitting these across repos means four PRs, four versions, and a broken week every time a field changes.

## Decision

Single pnpm workspace at the repo root. Packages under `packages/*` (db, shared, adapters, templates, plugins) and app folders at the top level (`ui`, `server`, `cli`). Cross-package imports resolve to source at dev time; no publish step during inner-loop development.

## Consequences

- Atomic changes — rename a field in the schema and the UI fails typecheck in the same diff.
- Single `pnpm install` at the root hydrates everything. CI runs the whole workspace in one job.
- pnpm's content-addressed store keeps `node_modules` small despite the package count.
- One `tsconfig.base.json` enforces the same TS settings everywhere. Less drift.
- A bad change in `@founderos/shared` can break every workspace at once. Mitigated by CI typecheck on PR.
- Harder to open-source a single package later. If we ever want to split out `packages/plugins/sdk` for external consumers, we'll need to extract it — annoying but not a blocker.

## Alternatives considered

- **Turborepo** — real caching wins at our scale (one app, small surface area) would be marginal, and the extra config layer isn't worth it yet. If build times become a problem, revisit.
- **Nx** — powerful, but the ergonomics tax (generators, project graphs, plugin ecosystem) is wrong for a two-person project.
- **Multi-repo** — clean ownership boundaries, but atomic cross-layer changes become a four-PR dance. Not worth it at our size.
