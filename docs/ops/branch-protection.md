---
title: Branch Protection Rules
summary: Exact GitHub settings to apply to protect `main`. Update applied 2026-05-07 to match current `ci.yml` aggregate + sibling workflows.
---

The CI gates only enforce merges if the corresponding GitHub branch protection rules are set. This doc tells you what to tick and where.

> **Status (2026-05-07):** branch protection on `main` is **NOT YET ENABLED** in production. Synthesis flagged this as a Phase-5 hard-stop alongside CI billing exhaustion (now resolved). Owner: human admin (Vinamr). Apply the rules below.

## Where to configure

GitHub → **Settings** → **Branches** → **Add rule** (or edit existing rule for `main`).

> **Apply to `main` only.** `dev` is legacy per `CLAUDE.md` ("dev is legacy — do not base new work on it"). Don't add a `dev` rule; the previous version of this doc had one but the branch is dead.

---

## Rules for `main`

**Branch name pattern:** `main`

### Require a pull request before merging
- [x] Require approvals (minimum **1**)
- [x] Dismiss stale pull request approvals when new commits are pushed
- [x] Require review from Code Owners
- [ ] Require approval of the most recent reviewable push (optional — tighten when team grows past 1)

### Require status checks to pass before merging
- [x] Require branches to be up to date before merging

**Required checks** — add these names exactly as they appear in the Checks tab on a recent PR:

| Check name (exactly as shown in GitHub) | Source workflow | What it gates |
|---|---|---|
| `ci (all checks)` | `ci.yml` aggregate | typecheck + lint + test + migration-check + schema-drift + bundle-size + file-size — single check that depends on all of them |
| `gitleaks` | `gitleaks.yml` | Secret scanning |
| `audit` | `npm-audit.yml` | Dependency vulnerability scan |
| `Analyze (javascript-typescript)` | `codeql.yml` | CodeQL static analysis |
| `Validate PR Title` | `pr-lint.yml` | Conventional Commits PR title |

**Why just these 5 and not 12?**

`ci (all checks)` is an aggregate job in `ci.yml` (line 358) with `needs: [typecheck, lint, test, migration-check, schema-drift, bundle-size, file-size]`. Listing the individual jobs as required checks is redundant — if any of them fail, the aggregate fails. The 5-check shortlist is the minimum cover; expand only if you find an aggregate-bypass path (you shouldn't, the `if: always()` + `needs:` shape is correct).

### Intentionally NOT required (do not add)

| Check | Why not required |
|---|---|
| `E2E — critical flows` | Runs against deployed origins (Vercel preview / Fly). Intermittent failures from upstream hiccups (CDN, deploy timing) shouldn't block PRs that touch unrelated surfaces. Treat as advisory; investigate red E2E separately. |
| `Vercel Preview Comments` | Vercel-side, not a code-correctness signal. |
| `PR summary`, `Check PR Size` | Optional QoL checks; making them required adds merge friction without correctness benefit. Keep as soft warnings. |
| `CodeQL` (the wrapper) vs `Analyze (javascript-typescript)` (the actual job) | The job name is what gates; the wrapper is just the workflow listing. |
| Individual jobs already covered by `ci (all checks)` | Redundant — see above. |

### Other rules

- [x] **Require conversation resolution before merging**
- [ ] **Require signed commits** (recommended; off by default if your contributors aren't set up for GPG. Skip until contributor count > 1.)
- [x] **Require linear history** (PRs MUST squash or rebase merge — keeps `git log --first-parent main` clean.)
- [ ] Require deployments to succeed (skip — `deploy-prod.yml` runs on push to main AFTER merge, not before)
- [x] **Do not allow bypassing the above settings** (no admin override path; force-mute the gate via PR comment instead if a true emergency arises)
- [x] **Restrict who can push to matching branches** — only GitHub Actions + the repo owner.
- [ ] Allow force pushes — **OFF**
- [ ] Allow deletions — **OFF**

---

## After first workflow run

Required-check names appear in the GitHub dropdown **only after** each workflow has run on the default branch at least once. CI has been functional since 2026-05-07 (PR #57/#58/#59/#60/#62 all completed end-to-end), so all 5 required checks should be visible in the dropdown now. If one is missing:

1. Trigger it on a throwaway PR.
2. Wait for the green checkmark.
3. Refresh GitHub Settings → Branches → main → required checks dropdown.

## If a check is consistently flaky

Option A: fix the flake. See `docs/CI-KNOWN-FLAKES.md`.
Option B: temporarily move it from "required" to "optional" via the same Branch Protection UI while you fix — don't merge past a real failure just because a check is noisy. Add an entry to `CI-KNOWN-FLAKES.md` with the date moved + the planned fix.

## Why linear history

Linear history means every PR squash-merges — no merge commits in `git log --first-parent main`, which is what release notes and `git bisect` consume.
