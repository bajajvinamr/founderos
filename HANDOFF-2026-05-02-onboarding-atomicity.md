# FounderOS Onboarding Atomicity Handoff — 2026-05-02

## Executive Summary

Issue #11 — onboarding bootstrap atomicity — fixed and merged. Bootstrap is now
a single Postgres transaction; a failure on agent N rolls back the entire run
and leaves zero rows in companies / memberships / secrets / goals / projects /
agents / activity_log. PR #14 squash-merged at `1095639`. Issue #11 auto-closed.
No product-visible behavior change on the happy path.

## Issue #11 Status

`CLOSED` via squash merge of PR #14 (`1095639`).

## What Changed

| File | Change |
|---|---|
| `server/src/services/onboarding-bootstrap.ts` | **NEW.** Atomic orchestrator. Wraps every persistent step (company, owner membership, secret, goal, project, memory, 4 agents, audit log) in one `db.transaction`. Service factories are re-instantiated inside the tx callback with `tx` cast to `Db` so every write hits the same transaction. Memory writes preserve the `.catch(() => null)` semantics (non-critical). The Anthropic key live-API check stays *outside* the tx in the route handler — external network I/O has no place inside a DB transaction. |
| `server/src/routes/onboarding.ts` | Route handler shrunk from 167→~50 lines. Validates input + Anthropic key, derives company name, then delegates to `bootstrapCompanyOnboarding`. The first-decisions and accept-decision routes are unchanged. |
| `server/src/__tests__/onboarding-bootstrap-atomicity.test.ts` | **NEW.** 7 embedded-Postgres integration tests covering atomicity invariants. |
| `server/src/__tests__/onboarding-adapter-type.test.ts` | Added a fakeDb stub with a no-op `transaction()` so the existing service-mock tests still exercise the route under the new tx-wrapping shape. |

Net diff: +676 / −162 across 4 files.

## Tests Added (atomicity invariants)

1. **Happy path** — bootstrap commits exactly one row in every load-bearing
   table, in the right shape.
2. **Anthropic-secret happy path** — `adapterChoice=anthropic_api` writes one
   secret row and injects `secret_ref` into all 4 agents' adapterConfig.
3. **Rollback on agent failure** — when agent #3 throws, zero rows survive in
   companies / memberships / secrets / goals / projects / agents / activity_log.
   This is the exact regression the issue called out.
4. **Retry idempotency** — after a failed run, a second run with the same
   inputs succeeds and produces clean rows (no orphan from the first run, no
   duplicate from the second).
5. **Secret-service rollback** — failure inside `secrets.create` rolls back
   the company/membership inserted earlier in the same tx.
6. **Two distinct names → two companies** — concurrent bootstraps with
   different company names both succeed and produce non-colliding prefixes.
7. **Same-name atomic failure** — when two concurrent bootstraps would
   collide on issue prefix, the loser fails atomically (zero orphan rows)
   instead of auto-retrying. **Documented trade-off** — the original code
   had auto-retry but lost atomicity on later failures, which is strictly
   worse for the founder. Atomic failure is recoverable; orphan rows are not.

## Verification (local, all green pre-merge)

| Check | Command | Result |
|---|---|---|
| Typecheck | `pnpm typecheck` | clean |
| Lint | `pnpm lint` | clean |
| Atomicity suite | `pnpm test:run server/src/__tests__/onboarding-bootstrap-atomicity.test.ts` | 7 / 7 pass |
| Adapter-type suite | `pnpm test:run server/src/__tests__/onboarding-adapter-type.test.ts` | 7 / 7 pass |
| Server suite | `pnpm test:run --project @founderos/server` | 1181 pass, 1 documented skip |

## CI on PR #14 (pre-merge)

| Check | Status |
|---|---|
| test (+ coverage) | ✅ |
| typecheck | ✅ |
| lint | ✅ |
| schema-drift | ✅ |
| migration-check | ✅ |
| bundle-size | ✅ |
| file-size | ✅ |
| install + cache | ✅ |
| ci (all checks) | ✅ |
| PR summary | ✅ (now green — PR #13's `actions:read` fix landed) |
| Check PR Size | ✅ |
| Validate PR Title | ✅ |
| gitleaks (×2) | ✅ |
| Analyze (javascript-typescript) | ❌ known repo-wide #8 |
| audit | ❌ known repo-wide #6 |
| E2E — critical flows | ⏳ pending — known repo-wide #7 |

All substantive checks green. Only the three known repo-wide reds remain.

## Behavior Before

Six service factories called sequentially in the route handler. Each used
`db.transaction` *internally*, but a failure between factory N and N+1
committed factories 1..N-1 unrecoverably. Result: a network blip during
agent provisioning could leave a permanent orphan company + membership +
secret + goal + project + memory rows + audit log entry, with no agents.
The founder would re-run bootstrap and get either a duplicate company or
a prefix-collision error against their own ghost row.

## Behavior After

One outer `db.transaction`. Any throw at any persistent step rolls back
every write in this run. Memory writes still swallow errors (non-critical).
External I/O (Anthropic key validation) runs *before* the tx opens, so it
cannot poison or extend transaction scope. Founders can retry a failed
bootstrap with the same inputs and get a clean result.

## Product Changes

None. This is a strict reliability fix. The route contract, request shape,
response shape, and happy-path side effects are byte-identical.

## Known Repo-Wide Reds (unchanged)

- **#6 audit high CVEs** — pre-existing, not in scope for issue #11.
- **#7 E2E critical flows** — pre-existing, not in scope.
- **#8 CodeQL Analyze** — pre-existing, not in scope.

## New Reds Introduced

None.

## Risks / Notes

- **Concurrent prefix collision is now an atomic failure, not a retry.**
  `companyService.create`'s inner prefix-uniqueness retry depends on each
  attempt being its own implicit tx. Inside the outer tx, the first
  conflict aborts the whole tx (`current transaction is aborted`) and the
  retry inserts can't recover. The trade-off — "fail atomically with no
  orphan rows" beats "retry but possibly leave orphans on later failure" —
  is documented inline in the orchestrator. Test #7 pins the new behavior.
  If concurrent same-name bootstraps become common (they aren't today),
  the fix is a savepoint-wrapped retry helper around the company insert
  only — but that requires touching `companyService.createCompanyWithUniquePrefix`
  to take an explicit savepoint handle, which is out of scope for this PR.
- **Memory failures still swallowed silently.** Preserved on purpose to
  match prior semantics. If we want memory writes to be load-bearing
  later, drop the `.catch(() => null)` and the orchestrator will roll
  the whole tx back on memory-insert error.

## Optional Follow-Up Done

- None. Kept the diff strictly scoped.

## Next Recommended Action

- **#7 E2E critical flows** is the highest-leverage remaining red. Without
  E2E green, every PR ships without browser-flow regression coverage.
  Triage candidate: open the `actions/runs` URL on PR #14 once it
  finishes, capture the failing journey + screenshot, and decide between
  (a) repair the journey, (b) quarantine to `docs/CI-KNOWN-FLAKES.md`,
  or (c) split the suite so flake doesn't block PR merge.
- **#6 audit high CVEs** is next-highest leverage — `pnpm audit` against
  the lockfile, then `pnpm up <pkg>` per advisory, in a single PR.
- **#8 CodeQL** is lowest leverage in the short term — usually a noisy
  finding that needs a one-off triage, not a mainline blocker.

## Session Stats

- Files changed: 4
- Lines: +676 / −162
- Tests added: 7 (atomicity) + adapter-type test stub fix
- Local suite: 1181 pass, 1 documented skip
- PRs merged this overnight session: #4, #10, #12, #13, #14
- Issues closed: #11 (this PR)
- Known repo-wide reds remaining: #6, #7, #8 — all pre-existing
