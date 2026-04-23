# ADR-003 — Fly.io for the backend, Vercel for the UI

## Status

Accepted (2026-04-22)

## Context

The backend runs long-lived agent processes (heartbeat loops, cron routines, embedded Postgres option for local dev) and needs stateful machines with volumes. The UI is a Vite SPA that's pure static output plus a thin API proxy. Running both on one platform means compromising — serverless UI platforms choke on long-running agents; traditional VMs make static edge delivery awkward and expensive.

## Decision

Split by workload. Vercel serves the UI as a static SPA and rewrites `/api/*` to the Fly backend (`founderos.fly.dev`). Fly runs the Node server, the cron routines, and holds the Fly Managed Postgres attachment. The rewrite doubles as a CORS-avoidance proxy — the browser sees one origin (`founderos-bice.vercel.app`) and cookies just work.

## Consequences

- The UI gets edge CDN + preview URLs per PR for free. The backend gets persistent machines, volumes, and cron.
- No CORS headers to maintain. `/api/*` is same-origin from the browser's perspective.
- Backend URL lives in `FOUNDEROS_BACKEND_URL` on Vercel and is resolved at request time — we can swap backends (tunnel in dev, Fly in prod) without rebuilding the UI.
- Two dashboards to watch. Two deploy pipelines. Mitigated by `.github/workflows/deploy-prod.yml` orchestrating both in sequence with auto-rollback.
- Fly machines scale-to-zero by default, so first agent run after idle takes ~500ms to warm. Acceptable for our load pattern.

## Alternatives considered

- **Railway** — nice DX, but weaker on stateful workloads and no per-region Managed Postgres like Fly MPG. Lose too much on the DB story.
- **Render** — similar trade-offs to Railway, without the Managed Postgres pairing.
- **Single-stack on Vercel (serverless functions)** — our agent runs exceed the 10s Hobby / 60s Pro execution limit, and cron jobs on Vercel are restrictive. Non-starter.
- **Single-stack on Fly (serve static from the Node app)** — works, but we lose the edge CDN and the zero-config preview URLs. The cost of the split is small; the wins are real.
