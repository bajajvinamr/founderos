# FounderOS Release Process (Wave 22D)

## Overview

The release automation runs on every push to `main`. It:

1. **Analyzes commits** since the last git tag using Conventional Commits rules
2. **Bumps the version** in `package.json` (semantic versioning)
3. **Creates a git tag** with the new version
4. **Generates CHANGELOG** entry with commit list grouped by type
5. **Creates a GitHub Release** with the changelog excerpt
6. **Uploads Sentry release marker** (if `SENTRY_AUTH_TOKEN` is set) and sourcemaps from `ui/dist/`

## Conventional Commits → Version Bump

| Commit Type | Bump | Example |
|---|---|---|
| `feat:` | MINOR | `feat: add user export` → v1.1.0 |
| `fix:`, `perf:`, `refactor:` | PATCH | `fix: race condition in auth` → v1.0.1 |
| `BREAKING CHANGE:` footer or `!:` | MAJOR | `feat!: remove legacy API` → v2.0.0 |
| `chore:`, `docs:`, `test:`, `style:`, `ci:` | NONE | No version bump, but still in CHANGELOG |

## Automatic Release (on main merge)

```
Push to main
    ↓
Trigger workflow on GitHub Actions
    ↓
Analyze git log since last tag
    ↓
Bump version in package.json
    ↓
Create git tag v<version>
    ↓
Append CHANGELOG.md
    ↓
Create GitHub Release page
    ↓
Upload Sentry release marker + sourcemaps
    ↓
Done—no manual steps
```

### Commit Message Format

Always use the Conventional Commits format:

```
<type>(<scope>): <description>

<optional body>
<optional footer with BREAKING CHANGE>
```

**Examples:**

- `feat(auth): add SSO via OAuth2`
- `fix: race condition in user export`
- `perf: optimize query in dashboard`
- `BREAKING CHANGE: remove /api/v1/legacy endpoint`

Or with the `!` shorthand:

- `feat!: restructure data model` (automatically treated as MAJOR)

## Manual Release (if needed)

### Trigger workflow manually

```bash
# Push a commit to main with a valid Conventional Commit message
git commit -m "feat: my feature"
git push origin main

# Wait ~5 minutes for GitHub Actions to complete
# Check Actions tab: https://github.com/founderos/founderos/actions
```

### Create a release for a past commit

```bash
# Tag the commit manually
git tag v1.2.3 abc1234
git push origin v1.2.3

# Workflow will NOT trigger (tag creation doesn't fire the push event)
# Manually create the GitHub Release on the releases page
```

## Rollback a Bad Release

### Remove the tag locally and from GitHub

```bash
# Delete local tag
git tag -d v1.2.3

# Delete remote tag
git push origin :v1.2.3
```

### Revert the CHANGELOG commit

```bash
# Find the commit that updated CHANGELOG
git log --oneline | grep "update CHANGELOG"

# Revert it
git revert abc1234 --no-edit
git push origin main
```

### Re-tag if needed

```bash
# Bump version back down manually in package.json if needed
git tag v1.2.2
git push origin v1.2.2
```

## Sentry Integration

The release automation uploads sourcemaps from `ui/dist/` to Sentry automatically.

### Prerequisites

Set these secrets in GitHub repo settings:
- `SENTRY_AUTH_TOKEN` — your Sentry org auth token
- `SENTRY_ORG` — Sentry org slug (defaults to `founderos`)
- `SENTRY_PROJECT` — Sentry project slug (defaults to `founderos-web`)

### Sourcemap Upload

```
GitHub Release created
    ↓
Sentry action runs (if SENTRY_AUTH_TOKEN is set)
    ↓
Creates release marker with git SHA
    ↓
Uploads ui/dist/ sourcemaps
    ↓
Links to traces via git SHA
```

In Sentry, errors now show:
- Release version (e.g., v1.2.3)
- Git commit hash
- Linked sourcemap for original source lines

## Verification

### Check that a release was created

```bash
# List recent tags
git tag -l --sort=-version:refname | head -5

# Verify CHANGELOG was updated
git log --oneline | grep "CHANGELOG"
```

### Check Sentry release

1. Go to Sentry project dashboard
2. Look for the version in the "Releases" tab
3. Verify sourcemaps uploaded (should show "1 release" with a green checkmark)

## FAQ

### My PR title doesn't follow Conventional Commits. Will it block merging?

No—the version bump is based on **commit messages**, not PR titles. However, Wave 22E adds PR-lint to enforce titles as well. Best practice: use Conventional Commits in both PR title and commit message.

### Can I skip the version bump?

Use `[skip ci]` in the commit message to skip the entire workflow. Rarely needed.

```bash
git commit -m "chore: internal refactor [skip ci]"
```

### What if no commits since last tag?

The workflow detects this and exits early. No version bump, no new tag, no release.

### How do I manually bump to a specific version?

Edit `package.json` directly:

```json
{
  "version": "2.0.0"
}
```

Then tag and push:

```bash
git add package.json
git commit -m "chore(release): bump to v2.0.0 [skip ci]"
git tag v2.0.0
git push origin main v2.0.0
```

---

**Wave 22D Release Automation**  
Last updated: 2026-04-21
