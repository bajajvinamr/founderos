<div align="center">
  <img src="docs/images/logo-light.svg#gh-light-mode-only" alt="FounderOS" height="32" />
  <img src="docs/images/logo-dark.svg#gh-dark-mode-only" alt="FounderOS" height="32" />
</div>

<p align="center">
  <em>The AI company OS for solo founders — run 20 agents across Claude, Codex, and Gemini from a single dashboard.</em>
</p>

<p align="center">
  <a href="#quickstart"><strong>Quickstart</strong></a> &middot;
  <a href="#what-you-get"><strong>What you get</strong></a> &middot;
  <a href="#self-host-deploy"><strong>Self-host</strong></a> &middot;
  <a href="#license"><strong>License</strong></a>
</p>

---

## What FounderOS is

FounderOS spins up a complete AI-run company from a template. Pick "Pre-seed AI lab", "Solo indie SaaS founder", or "Bootstrapped B2B SaaS" — in one click you get a CEO + full org, goals, projects, and a starter backlog wired to real agents that actually work on heartbeat.

Bring whichever provider you have — a logged-in Claude Code CLI subscription, an Anthropic API key, OpenAI, or Gemini. FounderOS detects what's available and routes agents automatically.

## What you get

- **Multi-provider agents** — Claude, Codex, and Gemini, using either a local CLI subscription or a direct API key, mixable per agent.
- **Built-in templates** — 3 ready-to-spawn company shapes, plus JSON export/import so a running company can be replayed into a fresh instance.
- **Per-agent provider preference** — each template agent declares the family it wants; the spawner resolves to a concrete adapter based on what's configured.
- **Strategy picker** — mixed, Claude-first, OpenAI-first, Gemini-first, or full per-agent override.
- **Demand-aware onboarding** — the provider step shows "N agents prefer this" chips and flags unmet demand before you spawn.
- **Encrypted key vault** — AES-256-GCM envelope encryption, zero raw-key surface, per-instance.
- **Company Pulse** — stage, MRR, ARR, burn, and runway live on the dashboard.
- **4-step onboarding wizard** — welcome → template → providers → launch.
- **Single-tenant deploy** — Fly.io provisioning with liveness + readiness probes and a smoke script.

## Who it's for

Solo founders and lean teams who want the leverage of 20 agents without wiring cron + LangChain + spreadsheets themselves. If you've tried to rig your own AI company and hit the "who runs what on which provider" wall, this is the answer.

## Quickstart

Local dev, no external DB needed:

```bash
pnpm install
pnpm dev
```

Then open <http://localhost:3100> and step through the onboarding wizard.

## Self-host (deploy)

```bash
./scripts/fly-provision.sh your-app-name
fly deploy
./scripts/fly-smoke.sh https://your-app-name.fly.dev
```

Single-tenant per customer — every instance runs in its own Fly machine with a dedicated Postgres and its own encrypted key vault. No shared provider credentials, no shared budget, no noisy-neighbor risk. See [`docs/deploy/`](./docs/deploy/) for the full pipeline.

## Tech stack

- **Engine**: Node.js + TypeScript, pnpm workspaces, Express
- **Frontend**: React 19 + Vite + TailwindCSS v4 + shadcn/ui, TanStack Query
- **Database**: PostgreSQL via Drizzle ORM (embedded locally, Supabase/Fly Postgres in prod)
- **Auth**: Clerk or better-auth, hot-swappable at runtime via `/api/auth/config`
- **Agents**: provider-agnostic — Claude, Codex, Cursor, Gemini, OpenCode
- **Validation**: Zod at every route boundary, invariants locked with unit tests
- **Crypto**: AES-256-GCM envelope encryption for stored provider keys

## Architecture decisions

Why the stack looks the way it does — forking Paperclip, the Fly/Vercel split, Supabase for auth, BYO Anthropic key, the permission ladder, Composio, and the rest. See [`docs/adr/`](./docs/adr/README.md).

## License

MIT. See [`LICENSE`](./LICENSE) for the full text and [`NOTICE.md`](./NOTICE.md) for upstream open-source attributions.
