---
title: Branch Protection Rules
summary: Exact GitHub settings to apply to protect `main` and `dev` branches
---

The automation shipped in Wave 22 only works if the corresponding GitHub branch protection rules are set. This doc tells you what to tick and where.

## Where to configure

GitHub → **Settings** → **Branches** → **Add rule** (or edit existing).

Apply to both `main` and `dev`. Differences noted below.

---

## Rules for `main`

**Branch name pattern:** `main`

- [x] **Require a pull request before merging**
  - [x] Require approvals (minimum `1`)
  - [x] Dismiss stale pull request approvals when new commits are pushed
  - [x] Require review from Code Owners
  - [ ] Require approval of the most recent reviewable push (optional — tighten when team grows)
- [x] **Require status checks to pass before merging**
  - [x] Require branches to be up to date before merging
  - **Required checks** (add these names exactly as they appear in the Checks tab after first run):
    - `install`
    - `typecheck`
    - `lint`
    - `test`
    - `migration-check`
    - `schema-drift`
    - `bundle-size`
    - `ci` (the aggregator job)
    - `codeql`
    - `gitleaks`
    - `npm-audit`
    - `pr-lint`
- [x] **Require conversation resolution before merging**
- [x] **Require signed commits** (recommended; off by default if your contributors aren't set up for GPG)
- [x] **Require linear history** (keeps main clean — all PRs squash/rebase merge)
- [ ] Require deployments to succeed (skip — our deploy workflow runs on push to main AFTER merge, not before)
- [x] **Do not allow bypassing the above settings**
- [x] **Restrict who can push to matching branches** — only GitHub Actions (for the release automation's `[skip ci]` commit) + yourself.
- [ ] Allow force pushes — **OFF**
- [ ] Allow deletions — **OFF**

## Rules for `dev`

**Branch name pattern:** `dev`

Same as `main` except:

- Required approvals: `0` (self-merge allowed for rapid iteration)
- You can skip `Require review from Code Owners`
- Keep all status checks required — CI is the gate

---

## After first workflow run

The check names ("install", "typecheck", etc.) only appear in the GitHub dropdown **after** each workflow has run at least once. Flow:

1. Merge this doc + the Wave 22 workflows to `dev`
2. Open a throwaway PR to trigger `ci.yml`, `codeql.yml`, etc.
3. Once the Checks tab shows all of them, come back to Branch Protection and tick them as required.

## Why linear history

The release automation (`release-main.yml`) creates an auto-commit with `[skip ci]` for CHANGELOG updates. Linear history ensures these land cleanly without merge-commit clutter.

## If a check is consistently flaky

Option A: fix the flake. See `docs/CI-KNOWN-FLAKES.md`.
Option B: move it from "required" to "optional" via the same Branch Protection UI while you fix — don't merge past a real failure just because a check is noisy.
