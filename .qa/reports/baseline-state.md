# Baseline State (captured 2026-05-06 during dream-state hardening run)

## Compile gates

| Gate | Result |
|---|---|
| `pnpm typecheck` (full repo) | GREEN |
| `pnpm lint` (full repo) | GREEN |
| `pnpm -w run test` | 2781 pass / **2 fail** / 7 skip / 2790 total |

## Test failures captured

### 1. `@founderos/db src/backup-lib.test.ts` — KNOWN v1.1 FLAKE

```
runDatabaseBackup > backs up and restores large table payloads without materializing one giant string
ERROR: foreign key referenced-columns list must not contain duplicates
[statement: ALTER TABLE "public"."content_drafts" ADD CONSTRAINT "content_drafts_brief_id_company_id_fk" FOREIGN KEY ("brief_id", "b...]
```

- Status: documented in `docs/CI-KNOWN-FLAKES.md` per CLAUDE.md / CONTINUE.md.
- Does NOT affect Fly Managed Postgres PITR backups (which are infra-managed).
- Defer to v1.1.

### 2. `@founderos/server src/__tests__/onboarding-bootstrap-atomicity.test.ts` — **NEW P0/P1 SIGNAL**

```
bootstrapCompanyOnboarding — atomic bootstrap >
  prefix collision during a same-name bootstrap fails atomically (no orphan company on the second call)
AssertionError: expected null to be an instance of Error
  at __tests__/onboarding-bootstrap-atomicity.test.ts:380
```

- The test expects: a second `bootstrapCompanyOnboarding` call with a colliding company name must throw.
- Actual: `err` is null — no error thrown, presumably the second call silently succeeded or returned a falsy value.
- Severity: **P1 minimum, possibly P0** depending on what the second call actually persisted. If two bootstraps with the same name leave two `company` rows, that's a tenant-provisioning-correctness issue. If only one row but the second call returned without surfacing the conflict, the wizard's UX silently misleads.
- This intersects the database-transactions agent's scope (atomicity / dedup) and the backend-api agent's scope (error shape).
- DO NOT fix in this baseline pass — let synthesis sequence it correctly.

## Branch / git state

- On `main` (NOT a feature branch — work is uncommitted directly).
- 28 modified + 12 new files staged for review.
- Recent merges include `feat: 2-week LRP merge — Sprints 4.8/5/6 + READY FOR CLIENT verdict` (`b2ec2d7`).
- All W1-W6 work in this run sits on top of that merge as uncommitted changes.

## Discovery agent status

| Agent | Status |
|---|---|
| backend-api | running (background) |
| database-transactions | running (background) |
| frontend-ux | **complete** — 3 P0, 3 P1, 4 P2 — `.qa/reports/frontend-ux.md` |
| security-privacy | running (background) |
| observability-e2e | running (background) |

## Top frontend-ux findings (already in)

1. **P0** — Onboarding wizard silently restores draft, no "Resume vs Start over" gate. `FounderOnboardingWizard.tsx:177-200`.
2. **P0** — Bootstrap submit error swallows `requestId`, collapses 401/402/403/409/5xx into one generic message. `FounderOnboardingWizard.tsx:316-322`.
3. **P0** — `ApprovalCard` self-approval prevention is UI-rule-only; backend not compared in component. `ApprovalCard.tsx:48-52`, `Approvals.tsx:51`.

(Full list in `.qa/reports/frontend-ux.md`.)
