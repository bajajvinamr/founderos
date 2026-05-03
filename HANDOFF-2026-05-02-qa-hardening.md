# Handoff — QA-Hardening Pass — 2026-05-02

## TL;DR

Three PRs landed this session targeting the highest-leverage red items left
after #11/#7. Two merged on `main`; one is open and **CI-blocked at the
GitHub Actions billing layer**, not by code.

| PR | Status | Closes |
|---|---|---|
| #18 — `chore(deps): patch Clerk audit CVEs` | merged `73f8bf7` | partial #6 |
| #19 — `fix(e2e): close #17 — add dialog role + testid to onboarding wizard` | merged `82ca8e2` | #17 |
| #20 — `test(frontend): cover founder critical flows` | **open, CI blocked by billing** | — |

**The single most important thing to do next: resolve the GitHub Actions
billing block.** Until that's cleared, no CI runs — including `release-main.yml`
on the merged PR #19 commit. Settings → Billing & plans.

## What shipped

### PR #18 — Clerk CVE patches (partial #6)

Two of three high CVEs in the original audit cleared via targeted
`pnpm.overrides`:

```jsonc
"overrides": {
  "rollup": ">=4.59.0",
  "@clerk/shared": ">=3.47.5 <4.0.0",
  "@clerk/clerk-react": ">=5.61.6 <6.0.0"
}
```

**Why overrides, not `pnpm up`:** `@clerk/clerk-react@5.61.6` is published
under the `latest-v5` dist-tag; npm's `latest` still points at the vulnerable
`5.61.3`, so `pnpm up` reported "already up to date." `@clerk/shared` is
transitive via `@clerk/backend@1.34.0` (the latest `1.x`), which pins
`^3.9.5` — overrides lift it without touching `@clerk/backend`.

**Deferred per mission:** Drizzle CVE. Daytime-only, requires schema/codegen
verification. Issue #6 stays open with "audit fail" gate accepted as known-red.

### PR #19 — Onboarding wizard E2E fix (#17)

Root cause: `FounderOnboardingWizard.tsx` rendered raw `<div>`s inside
`<DialogPortal>` and never used `<DialogContent>`, so the spec's selector
`[role=dialog], [data-testid*=onboarding], [data-testid*=wizard]` had nothing
to match.

Fix at `ui/src/components/onboarding/FounderOnboardingWizard.tsx:226-234` —
add accessibility attributes that double as the test hook:

```tsx
<div
  className="fixed inset-0 z-50 flex flex-col"
  role="dialog"
  aria-modal="true"
  aria-label="Founder onboarding wizard"
  data-testid="onboarding-wizard"
>
```

Removed `test.skip` from the `[onboarding-v2-flag]` spec; updated entry #5 in
`docs/CI-KNOWN-FLAKES.md` to FIXED 2026-05-02. E2E critical-flows job ran
green on PR #19. Issue #17 auto-closed on merge.

### PR #20 — Frontend critical-flow tests (OPEN, CI BLOCKED)

22 unit/contract tests across two new files:

**`ui/src/api/approvals.test.ts` (10 tests)**
- `approve` / `reject` / `requestRevision` POST to the right kebab/non-kebab
  path with `decisionNote` forwarding
- Bearer token attaches from supabase auth and is omitted when no session
- `get(id)` and `listComments(id)` GET the right paths
- `ApiError` propagates the parsed server error body on 409

**`ui/src/components/onboarding/auto-charter.test.ts` (12 tests)**
- `buildAutoCharters`: all 4 slots populated, non-empty charter+firstPriority,
  deterministic, bottleneck-specialised growth copy, vision incorporated,
  empty-vision fallback, team-shape voicing changes CoS
- `buildFirstDecisions`: 3 cards per primary bottleneck, every card routes
  to a real agent slot, deterministic, fallback for empty list

No MSW. No new deps. Local verification all green:

```
pnpm --filter @founderos/ui exec vitest run src/api/approvals.test.ts
  → 10/10 pass
pnpm --filter @founderos/ui exec vitest run src/components/onboarding/auto-charter.test.ts
  → 12/12 pass
pnpm typecheck → TC=0
pnpm lint → LINT=0
```

CI on PR #20 returned every job as failed with the annotation:

> The job was not started because recent account payments have failed or
> your spending limit needs to be increased. Please check the 'Billing & plans'
> section in your settings.

This is a platform billing issue, not a PR-diff issue. Same block hit `main`'s
Gitleaks/OSSF/Wave 22D workflows.

## Hard blocker (only the user can fix)

**GitHub Actions billing failure.** Symptoms:

- Every job on PR #20 returned `failure` with no logs (jobs never started)
- `gh run list --branch main --limit 3` shows OSSF/Gitleaks/Wave 22D failing
  for the same reason on main
- `release-main.yml` did not run on the PR #19 squash, so `main`'s newest
  release (`v0.2.16`, commit `31c4656`) is the **last released version** —
  PR #19's wizard fix is on `main` (`82ca8e2`) but **not deployed**.

**Resolution path:**

1. Settings → Billing & plans → resolve payment failure / raise spending limit
2. Re-run failed checks on PR #20: `gh run rerun --failed` against the most
   recent CI run for the branch
3. Re-run main's most recent CI / release pipeline so v0.2.16 actually deploys
   the wizard fix to production

## What's left after this pass

### Immediate, post-billing-resolution

- [ ] Re-trigger CI on PR #20 — local verification is clean, expected to be green
- [ ] Confirm `release-main.yml` runs on commit `82ca8e2` (PR #19 merge) so the
      wizard accessibility fix actually deploys
- [ ] Re-trigger `Gitleaks` / `OSSF Scorecard` / `Wave 22D Release Automation`
      on main

### Open issues

- **#6** — chore(deps): resolve audit high CVEs (Clerk side cleared; Drizzle
  remains, daytime-only)
- **#8** — fix(ci): stabilize CodeQL javascript-typescript analysis (out of
  scope this pass; CodeQL noise has been amber for weeks)
- **#16** — fix(e2e): re-enable critical-flows landing CTA spec under static
  UI mode (would need a local static-build repro: `pnpm build && SERVE_UI=true
  pnpm dev:server`; deliberately deferred this pass)

### Phase 4 — agent onboarding safety tests (NOT shipped)

The mission allowed Phase 4 only "if time remains." With CI blocked at the
billing layer, stacking another PR that can't be verified would create noise
in the queue. **Recommend running this in a follow-up session once billing
is resolved.** Sketch of what's worth testing:

- `server/src/routes/onboarding.ts` — bootstrap idempotency under retry
  (already covered by `onboarding-bootstrap-atomicity.test.ts`, but worth
  asserting that a second bootstrap call with the same idempotency key
  returns identical IDs without side-effects)
- `server/src/auth/post-signup-hook.ts` — confirm a freshly-signed-up user
  can't trigger company creation in another user's namespace
- Agent shortname collision between two new companies onboarded in parallel
  (already partially covered by `agent-shortname-collision.test.ts`)
- `paused-agent-blocks-heartbeat.test.ts` extended: a paused agent created
  during onboarding never receives a first heartbeat tick

### Quality posture after this session

- E2E critical-flows quarantine: 1 of 2 entries cleared (#17 closed, #16 still
  quarantined)
- Audit CVEs: Clerk side cleared, Drizzle deferred
- Frontend coverage: founder review API + auto-charter generator are now
  contract-tested (was zero before)
- Onboarding wizard: now accessibility-correct (role=dialog, aria-modal,
  aria-label, data-testid)
- Backend invariants: untouched this pass (intentional)

## Repo state

- Branch `test/frontend-founder-critical-flows` pushed to origin (PR #20 open)
- `main` at `82ca8e2` (PR #19 merge), one release tag behind (v0.2.16 cut at
  `31c4656` before PR #19 merged)
- No working-tree changes beyond untracked handoff docs and `.planning/`
- Local verification of PR #20: vitest 22/22 green, typecheck clean, lint clean

## Specific next-step command sequence (for the next session)

```bash
# After billing is resolved:
gh pr checks 20                                  # confirm clean re-run
gh pr merge 20 --squash --delete-branch          # merge if green
gh run rerun <main-release-run-id>               # ensure 82ca8e2 deploys
gh issue view 6                                  # decide on Drizzle CVE
gh pr list --state open                          # check for newly-blocked PRs
```
