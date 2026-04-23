# FounderOS E2E — critical flows (Wave 23A)

Playwright suite that walks the UI + API as a real user and fails loudly when
one of the 15 critical regressions resurfaces. Owned by Wave 23A.

This suite is **separate from** `tests/e2e/` (which owns the onboarding +
signoff-policy specs and bootstraps its own server on port 3199). This one
points at an already-running server and is used by two GitHub Actions:

- `.github/workflows/e2e-ci.yml` — runs on every PR/push to `dev`/`main` against a
  locally-seeded server.
- `.github/workflows/e2e-synthetic.yml` — cron every 30 min against
  `https://founderos-bice.vercel.app` with `FOUNDEROS_E2E_PROFILE=public-only`.

## What it covers

| # | ID | What breaks if it regresses |
|---|----|-----------------------------|
| 1 | `landing` | Marketing page broken — landing hero / CTA gone |
| 2 | `auth-page` | `/auth` form unreachable for new users |
| 3 | `unauth-redirect` | Signed-out users hit the legacy CLI bootstrap page instead of `/auth` |
| 4 | `health` | `/api/health` contract changed — breaks the UI `CloudAccessGate` |
| 5 | `company-prefix-routing` | Top-level paths like `/departments/*` mis-routed as a `:companyPrefix` (wave 22 regression) |
| 6 | `composio-status` | Integration surface broke — `/api/composio/status` shape changed |
| 7 | `onboarding-v2-flag` | `FOUNDEROS_ONBOARDING_V2` flag is off or the legacy wizard resurfaced |
| 8 | `decisions-list-api-shape` | `/decisions/pending-outcomes` envelope shape drifted |
| 9 | `memory-list-api` | `/memory` is no longer an array |
| 10 | `weekly-wrap-api` | `/weekly-wraps` is no longer an array |
| 11 | `agents-list-api` | `/agents` is no longer an array |
| 12 | `handoff-create` | Agent handoff creation broke end-to-end |
| 13 | `sentry-canary-gated` | Admin gate on `/api/debug/sentry-canary` regressed |
| 14 | `rate-limit-invite` | Invite rate-limit middleware removed or re-ordered |
| 15 | `static-assets` | HTML/JS MIME or Cache-Control headers are wrong |

## Running locally

Install the browser binary once (this is a manual step — the package is
installed via pnpm but Chromium needs a separate download):

```bash
pnpm e2e:install
```

Run the whole suite against the default `http://localhost:3100`:

```bash
# Terminal 1: seed + run the server
pnpm seed:demo
pnpm dev

# Terminal 2: run the E2E suite
pnpm e2e
```

Run against production (public-only, does not mutate anything):

```bash
FOUNDEROS_E2E_BASE_URL=https://founderos-bice.vercel.app \
  FOUNDEROS_E2E_PROFILE=public-only \
  pnpm e2e
```

Run a single test:

```bash
pnpm e2e --grep "company-prefix-routing"
```

Open the HTML report after a failure:

```bash
open e2e/playwright-report/index.html
```

## Env vars

| var | default | meaning |
|-----|---------|---------|
| `FOUNDEROS_E2E_BASE_URL` | `http://localhost:3100` | Target origin |
| `FOUNDEROS_E2E_PROFILE` | `default` | `default` = all 15 tests; `public-only` = unauth subset (7 tests) |
| `FOUNDEROS_E2E_DEMO_PREFIX` | `AGN` | Company `issuePrefix` to use for scoped API calls. Override to `PRED` / `GRV` / `LW` etc. |

## How CI invokes it

The two workflows under `.github/workflows/` call `pnpm e2e` with the
appropriate env vars. On failure they upload `e2e/test-results/` and
`e2e/playwright-report/` as a single GitHub Actions artifact.

The synthetic workflow uses the same incident-dedup pattern as
`uptime.yml` — a single open GitHub issue titled
**"E2E synthetic failing in production"** that gets commented on while the
probe is failing and auto-closed when it recovers. The threshold is 3
consecutive failures (≈ 90 minutes at 30-min cadence) so a one-off 500 is
a warning, not an incident.

## Adding a test

1. Add it to `tests/critical-flows.spec.ts` under the appropriate `describe`
   block. If it needs auth/data, call `requireAuthed(profile, "<id>")` first.
2. If it's safe against production, add the id to `PUBLIC_ONLY_TEST_IDS` in
   the same file AND update the `--grep` list in `e2e-synthetic.yml`.
3. Every assertion takes a **descriptive message** as its second arg. CI
   logs are the primary debugging surface for flaky production probes.
