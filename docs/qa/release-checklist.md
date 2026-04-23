# Release Checklist (dev → main)

Run this checklist before promoting `dev` branch to `main`. All items must pass.

## Preflight Checks

- [ ] Branch is `dev` and tracking remote
- [ ] No uncommitted changes: `git status` shows clean tree
- [ ] Latest commit is Conventional Commit format (`feat:`, `fix:`, `chore:`, etc.)
- [ ] CHANGELOG.md has been updated with new version and entries
- [ ] All new env vars documented in `.env.example`

## Build & Type Safety

- [ ] Typecheck all workspaces: `pnpm -r typecheck` passes
- [ ] All tests pass: `pnpm test:run` passes (only CI-KNOWN-FLAKES.md marked tests may flake)
- [ ] Bundle size check: `pnpm -r build && du -sh dist/` is within threshold (no +10MB regressions)
- [ ] No unused dependencies: `pnpm --dry-run remove [unused]` shows zero removals

## Database & Migrations

- [ ] All pending migrations applied: `npx prisma migrate status` shows "up to date"
- [ ] Migrations are reversible (no DROP TABLE without --one-way marker)
- [ ] Seed script runs cleanly: `pnpm seed:demo` completes without error
- [ ] Schema matches current Prisma schema: `npx prisma db push --skip-generate --dry-run` shows no drift

## Local Demo

- [ ] Start demo environment: `pnpm seed:demo && cd server && PORT=3100 pnpm dev` runs for 30+ seconds
- [ ] Frontend loads: `curl -s http://localhost:5173/ | head -20` returns HTML (no 502)

## Click-Through Smoke Test (5 min manual)

Test these flows on localhost:3100 (or Vercel preview if available):

- [ ] Dashboard loads and renders (no 500 errors in console)
- [ ] Click Decisions tab — page loads and decision list renders
- [ ] Click into a department (any one) — detail page loads
- [ ] Switch to Weekly view — agenda renders
- [ ] Click Conversations tab — thread list renders
- [ ] Click Agents list — registered agents display
- [ ] Click Goals — goal list and creation form work
- [ ] Click Audit Log — events list renders and filters respond
- [ ] Click Settings (if available) — form loads
- [ ] No console errors (F12 → Console tab)

## API Smoke Tests

- [ ] Create test handoff via API: `curl -X POST http://localhost:3100/api/companies/[id]/handoffs -H "Content-Type: application/json" -d '{...}' | jq .` returns 201
- [ ] Handoff appears in UI: reload page and verify in appropriate view
- [ ] `/api/composio/status` returns 200 with expected apps listed
- [ ] `/api/health/deep` returns `status: "ok"` (all checks pass)

## Production Deployment Simulation

- [ ] Fly.io build succeeds: `flyctl deploy --app founderos --dry-run`
- [ ] Vercel build succeeds: `vercel build`
- [ ] Environment variables are set in both platforms (check CI secrets)
- [ ] No hardcoded secrets in code: `git log --all --source --grep="secret\|api_key\|token" --oneline` is clean

## Pre-Deploy Checklist

- [ ] Sentry project DSN is configured and non-empty in `.env`
- [ ] Database backup is recent (check Fly.io/Vercel dashboard for last automated backup)
- [ ] Rollback plan documented: identify previous stable release version
- [ ] On-call engineer acknowledged: team aware of deploy in progress
- [ ] Feature flags validated: any new flags are behind safe defaults

## Post-Deploy (Automated by GitHub Actions, but verify manually if needed)

- [ ] Fly.io deployment completes: `flyctl releases list --app founderos | head -3`
- [ ] Vercel deployment completes: check Vercel dashboard
- [ ] Smoke tests pass: `scripts/ci/smoke.sh --url https://founderos.fly.dev/api/health/deep --retries 3` returns all green
- [ ] `/api/health/deep` on prod returns `status: "ok"` within 2 seconds
- [ ] Sentry dashboard shows zero new errors in last 15 minutes
- [ ] Database queries performant: no slow queries logged (check Fly postgres logs)

## Communication & Sign-Off

- [ ] Merge commit message is detailed: `git log -1 --format=%B` includes deploy notes
- [ ] Link to GitHub Actions run in commit message or Slack
- [ ] Team notified in Slack (if webhook configured)
- [ ] Monitor Sentry for 15 minutes post-deploy for any regressions
- [ ] Document any issues encountered in CHANGELOG.md as post-deploy notes

---

**If any check fails:** Stop, fix, and re-run from "Preflight Checks". Do not skip steps to accelerate.

**Emergency rollback:** If production is broken after deploy, trigger manual rollback:
```bash
flyctl releases rollback --app founderos --yes
vercel rollback  # or redeploy previous version
```
