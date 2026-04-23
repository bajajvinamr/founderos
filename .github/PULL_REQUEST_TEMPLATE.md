## What Changed

<!-- 1-2 sentences: What was modified and why -->

## Why

<!-- Motivation: What problem does this solve? Why was it needed? -->

## How to Test

<!-- Commands or step-by-step manual verification. Include expected results. -->

## Routes Changed

<!-- List all NEW or MODIFIED API routes and UI paths. Format:
- POST /api/companies/:id/handoffs (new endpoint)
- GET /api/health/deep (new endpoint, returns deep health check)
- PATCH /decisions/:id (modified response shape)
- /departments (modified path prefix)
Leave blank if no route changes. -->

## Migrations

<!-- List all new migration files and safety status. Format:
- 20260421_add_audit_logs.sql (safe to rollback)
- 20260421_rename_column.sql (ONE-WAY — cannot rollback)
Leave blank if no migrations. -->

## Breaking Changes

<!-- List any breaking changes to APIs, env vars, or response shapes. Format:
- REMOVED env var: OLD_VAR (use NEW_VAR instead)
- CHANGED response shape: /api/handoffs now returns { success, data { id, title } } instead of { id, title }
Leave blank if none. -->

## Test Evidence

<!-- Provide links to test results, screenshots of E2E tests, or Loom recordings. Format:
- Unit tests: links to test files in this PR + test output
- E2E tests: link to Playwright run or screenshot
- Manual QA: Loom video or screenshot of clicking through the change
Must include at least one piece of evidence. Explain if none available. -->

## Linked PRD

<!-- REQUIRED for new pages, endpoints, or material workflow changes. Format:
- PRD-NNN (file: docs/prds/PRD-NNN-*.md)
For bug fixes, copy, style, refactor, or chore: "No PRD — <reason>" -->

## Linked ADR

<!-- Optional: link to Architecture Decision Record if this PR implements an ADR.
Format: docs/adr/023-feature-name.md -->

## Screenshots

<!-- For UI-only changes. Before and after if applicable. -->

## Risk

<!-- Low / Medium / High — describe blast radius and what could break -->

## Rollback Plan

<!-- How to safely revert this change if needed. Include manual steps if migrations require reversal. -->

## Checklist

- [ ] Tests pass locally (`pnpm test:run`)
- [ ] Typecheck passes (`pnpm -r typecheck`)
- [ ] No console errors in browser/logs
- [ ] Changes are documented (code comments + relevant docs/)
- [ ] All routes/migrations/breaking changes listed above
- [ ] Test evidence provided (unit/E2E/manual QA)
- [ ] Conventional Commit message used in commit (`feat:`, `fix:`, etc.)
- [ ] No new hardcoded secrets or env vars in code
