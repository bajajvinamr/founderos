# FounderOS — Production Readiness Remediation

## Context
Council audit (2026-04-30) returned BLOCK verdict — 4 P1s, 6 P2s, 6 P3s.
This project remediates all findings and deploys the product to production.

## Mission
Fix every P1 and P2 council finding. Ship to Fly + Vercel.

## Decisions file
~/.gstack/projects/founderos/decisions.md

## Key files
- server/src/agent-auth-jwt.ts — JWT (P1-1, P2-2)
- packages/adapters/ — missing claude_api adapter (P1-2, P1-3)
- server/src/services/heartbeat-helpers.ts — SESSIONED_LOCAL_ADAPTERS (P1-3)
- packages/db/src/seed-demo-reset.ts — sql.raw injection (P1-4)
- server/src/routes/authz.ts — local_implicit bypass (P2-3)
- .github/workflows/ — master branch + node mismatch (P2-4, P2-5)
- packages/db/src/schema/companies.ts — PAP default (P2-6)
- server/src/routes/plugin-ui-static.ts — path traversal (P2-1)
- server/src/routes/onboarding.ts — non-atomic bootstrap (P3-6)
- packages/db/src/seed-demo-depth.ts — counter overwrites all companies (P3-4)
