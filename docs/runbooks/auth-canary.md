# Auth Canary Runbook

_TC-4, 2026-05-05 — paired with `e2e/tests/auth-round-trip.spec.ts` and
`.github/workflows/e2e-synthetic.yml`._

## What this is

A pre-created Supabase user, used by the `auth-round-trip` Playwright spec
to prove every 15 minutes (and on every prod deploy) that a real
end-to-end sign-in still works against production. Single failure → P0
GitHub issue + Slack `#oncall` page.

## Canary user contract

| Field | Value |
|---|---|
| Email | `canary@founderos.dev` (or a similar address — must be a domain you control) |
| Password | Stored in `CANARY_USER_PASSWORD` GitHub secret + Fly secret; rotated quarterly |
| Email confirmed | Yes — pre-confirmed via Supabase admin API at provisioning |
| Companies | At least 1 (so post-auth lands on `/{PREFIX}/dashboard`, not the empty state) |
| Metadata | `is_canary=true` in `public."user".metadata` (so analytics + cohort queries can exclude it) |
| Role | None (NOT instance_admin) — canary should be the "average user" path |
| Billing | Subscription state = `active` (so the canary doesn't hit the billing 402 gate) |

## One-time provisioning

Done once per environment. Re-run if the canary user is deleted or its
password is lost.

```bash
# 1. Create the Supabase auth.user with email pre-confirmed.
#    Run from anywhere with SUPABASE_SERVICE_ROLE_KEY.
SUPABASE_PROJECT_REF=ggspsiexqppduvsqvpgy
SUPABASE_SERVICE_ROLE_KEY="<service-role-from-vault>"
CANARY_EMAIL="canary@founderos.dev"
CANARY_PW="$(openssl rand -base64 32)"

curl -sX POST \
  "https://${SUPABASE_PROJECT_REF}.supabase.co/auth/v1/admin/users" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "content-type: application/json" \
  -d "{\"email\":\"${CANARY_EMAIL}\",\"password\":\"${CANARY_PW}\",\"email_confirm\":true}"

# 2. Print the password ONCE — store it in 1Password Production/FounderOS
#    + as a GitHub secret + as a Fly secret.
echo "CANARY_USER_EMAIL=${CANARY_EMAIL}"
echo "CANARY_USER_PASSWORD=${CANARY_PW}"

# 3. Wire into GitHub Actions (repo settings → Secrets and variables →
#    Actions → New repository secret), TWO secrets:
#    - CANARY_USER_EMAIL
#    - CANARY_USER_PASSWORD

# 4. Wire into Fly secrets (so future tooling that needs them in-cluster
#    has them). Never logged, never exposed; this is a defense-in-depth
#    duplicate.
fly secrets set --app founderos \
  CANARY_USER_EMAIL="${CANARY_EMAIL}" \
  CANARY_USER_PASSWORD="${CANARY_PW}"

# 5. After the first authenticated request from the canary, the
#    post-signup hook upserts public."user". Update its metadata so
#    analytics excludes it:
psql "$DATABASE_URL" <<SQL
  UPDATE public."user"
     SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{is_canary}', 'true'::jsonb)
   WHERE email = '${CANARY_EMAIL}';
SQL

# 6. Create a company for the canary so the post-auth redirect lands on
#    /{PREFIX}/dashboard. Use the admin CLI or signup flow once.
#    (If signing up via the UI, add a company named "Canary Co" with
#    issuePrefix "CAN".)
```

## Quarterly rotation

The password rotates every 90 days as part of the broader secret-rotation
schedule (`docs/runbooks/secret-rotation.md` will list this once it exists
— G8 in the observability plan). Process:

```bash
NEW_PW="$(openssl rand -base64 32)"
curl -sX PUT \
  "https://${SUPABASE_PROJECT_REF}.supabase.co/auth/v1/admin/users/<canary-user-id>" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "content-type: application/json" \
  -d "{\"password\":\"${NEW_PW}\"}"

# Update both secrets with NEW_PW. Trigger a manual canary run to
# verify the new password works:
gh workflow run e2e-synthetic.yml -f run_auth_canary=true
gh run watch  # wait for it to finish
```

The 15-min cadence means a stale password is detected within 15 min of
rotation if the secret-update is forgotten.

## When the canary fails — playbook

The GitHub issue body (auto-generated) lists these steps too. Repeating
here so the runbook is self-contained.

1. **Triage in 60 seconds.** Pull the
   `auth-canary-report-<run_id>` artifact from the failing GitHub Actions
   run. Open the Playwright HTML report — it has the failing screenshot
   + trace + console logs.

2. **Check the failure mode.**
   - **`/auth` page didn't render the form** → frontend bundle broken,
     likely the `placeholder.supabase.co` class. Run
     `scripts/ci/check-deployed-supabase.sh https://founderos.fly.dev`.
   - **`/api/companies` returned non-200** → check the response status.
     401 = Supabase JWT not accepted; 5xx = backend issue.
   - **No redirect to `/{PREFIX}/dashboard`** → CompanyRootRedirect logic
     broken or canary user has no companies (data drift — re-add a
     company via admin CLI).

3. **Reproduce manually.**
   - From your laptop: `curl -i https://founderos.fly.dev/api/healthz` and
     `curl -i https://founderos.fly.dev/api/readyz`.
   - Sign in to https://founderos.fly.dev/auth as the canary user. Does
     it work? If yes: flake. If no: real outage.

4. **Pull logs.**
   - The Playwright trace has every request's status + timing. Note the
     `requestId` from the `x-request-id` header on the failing request.
   - `fly logs --app founderos | grep <requestId>` — pulls every server
     log line for that exact request.
   - Sentry: filter by `tag:requestId=<requestId>`.

5. **Decide: rollback or fix forward.**
   - **Rollback if** the canary started failing within 5 min of a deploy
     (visible in the GitHub Actions run history) AND the failure
     reproduces manually. Trigger:
     `flyctl releases list --app founderos | head -5` to find the
     previous green version, then
     `flyctl releases rollback <ver> --app founderos --yes`.
   - **Fix forward if** the failure is data-driven (canary user got
     deleted/locked, password expired) — re-run provisioning step 4-6
     from this runbook.

6. **Confirm recovery.**
   - The canary auto-reruns on its 15-min schedule. Or trigger a manual
     run: `gh workflow run e2e-synthetic.yml -f run_auth_canary=true`.
   - When it passes, the GitHub issue auto-closes via
     `e2e-synthetic.yml#canary-incident`.

## Why pre-created vs. fresh signup each run

The original observability-plan G4 spec called for "fresh
`auth-test-${timestamp}@founderos.dev` signups every run, then delete."
The pre-created approach was chosen for TC-4 because:

- **Cleanup-failure risk**: a canary that fails between signup and
  delete leaves a real user in prod every 15 min. Hundreds of orphan
  users per week.
- **Email cost**: every signup hits the Supabase email-send path; over
  4×24 = 96 runs/day × 365 = ~35k extra Supabase emails/year.
- **Surface area**: a fresh-signup canary needs the Supabase admin API
  (`SUPABASE_SERVICE_ROLE_KEY`) wired to the GitHub Actions runner. That
  key is the most powerful credential in the system; broadening its
  exposure for a canary trades off poorly against the marginal
  fidelity gain.
- **What we lose**: the pre-created canary doesn't exercise
  signup-confirmation-flow. That gap is owned by `tests/e2e/` (separate
  config) and tested at PR time, not at canary time.

If a future incident is rooted in the signup flow specifically, revisit
this trade-off.

## Required secrets

| Secret | Where set | Used by |
|---|---|---|
| `CANARY_USER_EMAIL` | GitHub Actions repo secrets | `e2e-synthetic.yml#auth-canary` |
| `CANARY_USER_PASSWORD` | GitHub Actions repo secrets | same |
| `CANARY_USER_EMAIL` | Fly secrets | future in-cluster tooling (defense in depth) |
| `CANARY_USER_PASSWORD` | Fly secrets | same |
| `SLACK_DEPLOY_WEBHOOK_URL` | GitHub Actions repo secrets | canary failure → Slack `#oncall` page |
| `SUPABASE_SERVICE_ROLE_KEY` | 1Password Production/FounderOS only — NOT in GH/Fly | one-time provisioning + rotation |

The fly secrets are NOT consumed by any code today — they exist for
parity with GH and so a future "fly ssh + curl /api/auth" smoke can use
them without re-provisioning. Listed here for the
`vanta-orchestrator` to set up.
