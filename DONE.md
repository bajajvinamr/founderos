# DONE.md — Definition of Done (FounderOS)

Nothing ships unless every check below is green. The owner does not read
diffs — these gates are the review.

## 1. Local gate (automated)

```bash
./verify.sh          # typecheck + tests + full build
./verify.sh --fast   # typecheck + tests only (CI-preflight parity)
```

Must print `RESULT: PASS` and exit 0. What it runs:

| Check | Command | Mirrors |
|---|---|---|
| Typecheck | `pnpm typecheck` (all workspace packages) | deploy-prod.yml `preflight` job |
| Tests | `pnpm test:run` (vitest, whole monorepo) | deploy-prod.yml `preflight` job |
| Build | `pnpm build` (all packages) | pre-deploy sanity |

## 2. CI gate (automatic on push/PR)

- `.github/workflows/ci.yml` — canonical PR checks (typecheck, tests, lint,
  bundle-size budget 2700KB). Must be green before merge. Broken CI is a
  blocker, not background noise.
- `.github/workflows/deploy-prod.yml` `preflight` job — **the structural
  backstop on the deploy path**: typecheck + tests run again before any Fly
  deploy; a red preflight blocks `deploy-fly`, `smoke`, and triggers no
  rollout. Nothing reaches prod without passing it.
  - Monitoring tip: preflight failing at ~90s = typecheck error;
    still running at minute 4+ = typecheck passed, tests executing.
- E2E: `e2e-ci.yml` / `e2e-synthetic.yml` exist; release smoke via
  `release-smoke.yml`.

## 3. REMOTE — adapter environment test must return status "pass"

The onboarding wizard calls:

```
POST /companies/{companyId}/adapters/{type}/test-environment
```

(server route: `server/src/routes/agents.ts`; UI: `ui/src/components/OnboardingWizard.tsx`)

**Done means the response body is `{"status": "pass", ...}` — literally the
string `pass`.** A response that "came back fine" is not enough:

- `{"status": "fail"}` is a truthy object. Guards like `if (!result) return`
  accept it and let the wizard advance past a broken adapter. This exact bug
  shipped once (OnboardingWizard.tsx:454). Always check the `status` field.
- `"warn"` requires reading the `checks[]` array and a deliberate decision —
  it is not an automatic pass.

MANUAL/REMOTE verification against the deployed backend:

```bash
# Expect: "pass"
curl -s -X POST "$PROD_API/companies/$COMPANY_ID/adapters/$ADAPTER_TYPE/test-environment" \
  -H "Authorization: Bearer $TOKEN" | jq -r .status
```

## 4. REMOTE — post-deploy smoke (MANUAL)

```bash
pnpm fly:smoke        # scripts/fly-smoke.sh against the Fly backend
```

Expected: script exits 0. deploy-prod.yml also runs a `smoke` job +
`rollback-on-fail` automatically; check the workflow run is fully green:

```bash
gh run list --workflow=deploy-prod.yml --limit 1
# Expected: conclusion "success" on all jobs (preflight, deploy-fly, smoke)
```

## Known gaps

- Coverage is collected (`test:coverage`) but no enforced threshold in the
  local gate.
- `verify.sh` does not run E2E (Playwright needs a running stack); CI and
  the deploy pipeline cover that path.

## Known environmental failure modes (not code defects)

Observed on the first full gate run (2026-06-10):

- **`pnpm build` FAILS without Supabase build-time env.** The UI build
  hard-stops by design when `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
  are unset (env-validation-at-startup pattern). Local full-gate runs need
  both exported, or use `./verify.sh --fast` (typecheck + tests), which is
  the CI-preflight parity check anyway.
- **Embedded-Postgres `beforeAll` timeouts under machine load.** Suites
  using `startEmbeddedPostgresTestDatabase` (cash-planning, churn-forecast,
  pricing-simulator) can blow the 10s hook timeout when the machine is
  busy — the follow-on `testDb.cleanup` TypeError is cascade noise, not a
  second bug. Signature: `Hook timed out in 10000ms` at `beforeAll` +
  thousands of other tests green (3,630/3,630 passed on the run that
  surfaced this). Re-run quiet before treating as a regression.
