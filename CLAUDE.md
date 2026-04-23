# CLAUDE.md — FounderOS project context

_Session-time behavior file. Full contributor guide lives in `AGENTS.md`._

## What this is

FounderOS: a control plane for AI-agent "companies" — founders plug in LLM agents (CoS, Growth, Content, Finance), wire integrations, and run their startup ops through an Inbox + Goals + Projects UI. Paperclip MIT fork. $4k buyer-funded.

Current deploys:
- Server: https://founderos.fly.dev (Fly region `lhr`, Managed Postgres `gjpkdonynwy0yln4`)
- UI: https://founderos-bice.vercel.app (Vercel project `founderos`)
- Supabase project `ggspsiexqppduvsqvpgy` (auth + JWKS)

## Stack

- **Monorepo:** pnpm workspaces. `pnpm -w run <script>` from root.
- **Server:** Node 24 + Express + Drizzle ORM. Entry `server/src/index.ts`.
- **UI:** React 19 + Vite + Tailwind + shadcn. Entry `ui/src/main.tsx`.
- **Shared:** `packages/shared` (types + validators + API path constants), `packages/db` (schema + migrations), `packages/adapters` (Claude/Codex/Cursor adapters), `packages/plugins`.
- **DB:** Postgres (Supabase prod, Fly MPG for API); embedded PGlite locally when `DATABASE_URL` unset.
- **Validation:** Zod at every boundary → `z.infer` for types. No hand-written request types.

## Commands you'll actually run

| What | Command |
|---|---|
| Install | `pnpm install` |
| Dev | `pnpm dev` (uses embedded PGlite if no `DATABASE_URL`) |
| Typecheck all | `pnpm typecheck` |
| Test all | `pnpm -w run test` (NOT `pnpm test` — that's a workspace script) |
| Lint | `pnpm lint` |
| Bundle size check | `pnpm --filter @founderos/ui build && pnpm ci:bundle-size` |
| Migrations check | `pnpm --filter @founderos/db check:migrations` |
| Fly deploy | `fly deploy -a founderos --strategy immediate` |

## Branch + release model

- Work on feature branches off `main`. `dev` is legacy — do not base new work on it.
- Conventional Commits required (`feat:`, `fix:`, `chore:`, `feat(wave-N):` for big sprints).
- `main` triggers `release-main.yml` (bumps version, pushes container, deploys).
- **Never** commit to or target `master` — it doesn't exist. Any workflow referencing it is dead code.

## CI gates (required checks)

`ci.yml` runs on every PR: typecheck, lint, test+coverage, migration-check, schema-drift, bundle-size (<1.5 MB gzipped UI), aggregated into `ci` job. See `.github/workflows/README.md` for the full map. Known flakes are quarantined in `docs/CI-KNOWN-FLAKES.md` — check there before assuming red CI is your bug.

## Known pitfalls

- **Router prefix parsing:** `ui/src/lib/company-routes.ts` has a `BOARD_ROUTE_ROOTS` set. When adding a new top-level route (`/settings`, `/weekly`, `/departments`), add its slug there or the router will mistake the route root for a company prefix.
- **Adapter choice on onboarding:** `claude_local` + `skip` don't need an API key. Only `anthropic_api` requires + validates a key. Server route `onboarding/bootstrap` enforces this — don't re-add a blanket key requirement.
- **Composio client is v1 — deprecated.** `composio-client.ts` still targets `/api/v1/*` which returns 410. Health check was moved to v3 but tool execution not yet migrated. Flag to user before wiring any new composio-backed flow.
- **Test flakes:** ~2/1569 tests fail under parallel execution due to shared embedded-PG data dir. Documented in `docs/CI-KNOWN-FLAKES.md`. Not your bug if you see `health.test.ts` or `workspace-runtime.test.ts` red.

## Where things live

- ADRs: `docs/adr/` (10 entries as of 2026-04-23)
- PRDs: `docs/prds/` (3 active)
- Retros: `docs/retros/`
- QA checklists: `docs/qa/`
- Runbooks: `docs/runbooks/`
- Deploy config: `DEPLOYMENT.md` + `docs/ops/branch-protection.md`
- Project handover (always current): `CONTINUE.md`

## Deferred / human-only next steps

Tracked in `CONTINUE.md`. Summary: Stripe live keys, `FLY_API_TOKEN` + `VERCEL_TOKEN` + `SENTRY_AUTH_TOKEN` as GitHub secrets, `main` branch protection, Resend paid tier.
