# GitHub Actions workflows

One-pager for every workflow under `.github/workflows/`. Keep this current when adding or removing a file.

## Wave ownership

| Wave | Scope | Workflows |
| --- | --- | --- |
| 22A | PR checks (this doc) | `ci.yml`, `pr-info.yml` |
| 22B | Deploy | _(deploy workflows)_ |
| 22C | Security | _(security scans)_ |
| 22D | Release | `release-main.yml`, `release-smoke.yml` |
| 22E | Repo meta | CODEOWNERS, issue/PR templates |

Workflows outside 22A are owned by other waves — don't edit them here.

## Workflows

### `ci.yml` — canonical PR checks

**When:** every `pull_request`, and pushes to `main` / `master`.

**Jobs:**

| Job | Needs | Timeout | What it does |
| --- | --- | ---: | --- |
| `install` | — | 10 min | Sets up Node 24 + pnpm 9.15.4, caches the pnpm store keyed on `pnpm-lock.yaml`, runs `pnpm install --frozen-lockfile`. Every other job depends on this. |
| `typecheck` | install | 5 min | `pnpm typecheck` across all workspaces, plus an explicit `tsc --noEmit` against `scripts/ci/*.ts`. |
| `lint` | install | 5 min | Runs `pnpm check:tokens` (forbidden-string gate) and `pnpm lint` (recursive `--if-present` across workspaces — a no-op today until a workspace declares its own `lint` script). |
| `test` | install | 15 min | Runs Vitest with coverage (text-summary, json-summary, lcov). Uploads `coverage/` and `test-results.json` as artifacts. Prints per-package coverage via `pnpm ci:coverage-summary`. |
| `migration-check` | install | 5 min | Belt-and-suspenders: `pnpm --filter @founderos/db check:migrations` (also run via typecheck hook). |
| `schema-drift` | install | 5 min | If any `packages/db/src/migrations/*.sql` changed, verifies each has a `_journal.json` tag and a `meta/NNNN_snapshot.json`. |
| `bundle-size` | install | 5 min | Builds the UI, sums gzipped size of `ui/dist/assets/**/*.js`, fails if over `BUNDLE_SIZE_BUDGET_KB` (default 1536 = 1.5 MB). Uploads `ui-dist`. |
| `file-size` | install | 3 min | Runs `scripts/ci/file-size-check.ts` on changed files (PRs) or last commit (main). Warns on `.ts/.tsx/.js/.jsx` files ≥1500 lines, fails ≥2500 lines. Grandfathered offenders live in `.github/file-size-allowlist.txt`. See `docs/tickets/003-ci-file-size-gate.md`. |
| `ci` | all above | 1 min | Aggregator gate — required check for branch protection. |

**Concurrency:** `ci-${{ workflow }}-${{ PR number || ref }}` with `cancel-in-progress: true`. New pushes to a PR cancel in-flight runs.

**Fail-fast:** off. Jobs run independently so you see every failure on a single run.

**Tuning:**
- Change budget: set the workflow env `BUNDLE_SIZE_BUDGET_KB`.
- Change Node / pnpm version: update the `env:` block at the top of `ci.yml`.

**Debug tips:**
- Re-run the `install` job first if you see cache-miss issues. The cache key is `pnpm-store-${OS}-node${NODE_VERSION}-${hashFiles('pnpm-lock.yaml')}`.
- Coverage not appearing? The `test` job tolerates Vitest failures on the coverage step so the summary still uploads — the real gate is the final `pnpm test:run` step.
- Bundle over budget? Download the `ui-dist` artifact, inspect `assets/` locally, or run `pnpm --filter @founderos/ui build && pnpm ci:bundle-size` on your laptop.

### `pr-info.yml` — PR summary comment

**When:** pull request `opened`, `synchronize`, `reopened`.

**What it does:**
1. Diffs PR head against base to count files changed (UI / server / packages / workflows / migrations).
2. Builds the UI on both head and base, measures gzipped bundle size on each via `scripts/ci/bundle-size-check.ts`, computes delta.
3. Downloads the `test-results` artifact from the CI workflow for the same head SHA, parses `numPassedTests` / `numFailedTests` / `numTotalTests` from Vitest's JSON reporter.
4. Posts or updates a single comment identified by the `<!-- founderos/pr-info -->` marker.

**Trigger type:** `pull_request_target` — runs against the base repo so comments work on forked PRs. Keep this workflow side-effect-free (no untrusted code execution on forks).

**Permissions:** `pull-requests: write`, `issues: write`, `contents: read`.

**Debug tips:**
- Comment missing? Check the job logs for the `Post / update PR comment` step. The GitHub API will 404 if `pull-requests: write` is missing on the token.
- Test counts empty? The CI workflow may not have uploaded `test-results` yet — push a new commit or wait for CI to finish before this workflow runs.
- Base-branch bundle fails to build (e.g. dependency drift)? The comment still posts head-only numbers; the step is `continue-on-error: true`.

### Other workflows (owned elsewhere)

- `docker.yml`, `e2e-ci.yml`, `e2e-manual.yml`, `e2e-synthetic.yml`, `release-main.yml`, `release-smoke.yml`, `refresh-lockfile.yml` — per their own ownership.
- **Removed 2026-04-23 (retro):** `pr.yml` (legacy policy gate, superseded by `ci.yml`) and `release.yml` (targeted nonexistent `master` branch — Paperclip fork residue). `e2e.yml` renamed to `e2e-manual.yml` to disambiguate from `e2e-ci.yml`.

## Scripts used by CI

- `scripts/ci/bundle-size-check.ts` — walks `ui/dist/assets/**/*.js`, gzip-sizes them, prints a table, emits `$GITHUB_STEP_SUMMARY` markdown, sets `$GITHUB_OUTPUT` (`total_kb`, `budget_kb`, `asset_count`), exits 1 if over budget.
- `scripts/ci/coverage-summary.ts` — reads every `coverage/coverage-summary.json` under the repo, prints overall + per-package percentages, writes a markdown summary for the job, optional threshold gate via `COVERAGE_THRESHOLD`.

## Local debugging

Run the same checks locally:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test:coverage
pnpm --filter @founderos/db check:migrations
pnpm --filter @founderos/ui build
pnpm ci:bundle-size
pnpm ci:coverage-summary
```
