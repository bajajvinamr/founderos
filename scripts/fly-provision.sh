#!/usr/bin/env bash
#
# fly-provision.sh — spin up a new single-tenant FounderOS deployment on Fly.io.
#
# Usage:
#   ./scripts/fly-provision.sh <customer-slug> [--region bom] [--db-url <postgres-url>]
#
# What it does:
#   1. Creates a new Fly app named "founderos-<slug>"
#   2. Attaches a 3 GB persistent volume for instance state
#   3. Sets required secrets (DATABASE_URL + generated FOUNDEROS_SECRETS_MASTER_KEY)
#   4. Deploys from the current source
#   5. Prints the public URL
#
# Prereqs on the machine running this:
#   - flyctl installed and logged in (`fly auth login`)
#   - A Postgres DATABASE_URL for this customer (Supabase / RDS / self-hosted)
#   - Optional: CLERK_*, ANTHROPIC_API_KEY, etc. to pre-set via env
#
# This is the operational half of the PRD's "one Fly app per customer"
# single-tenant model.

set -euo pipefail

# Error handler — provide helpful context on failure
trap 'echo "Error on line $LINENO: command failed with exit code $?" >&2; exit 1' ERR

# ────────────────────────────────────────────────────────────────────────
# CLI parsing
# ────────────────────────────────────────────────────────────────────────
SLUG=""
REGION="bom"
DB_URL="${DATABASE_URL:-}"
VOLUME_SIZE_GB="3"
VM_MEMORY="1gb"
AUTO_DEPLOY="true"

print_usage() {
  cat <<EOF
Usage: $0 <customer-slug> [options]

Required:
  <customer-slug>     Short kebab-case identifier (e.g. "acme-corp")

Options:
  --region <id>       Fly region (default: bom — Mumbai)
  --db-url <url>      DATABASE_URL for this tenant. Can also be set via env.
  --memory <size>     VM memory (default: 1gb)
  --volume <size-gb>  Persistent volume size in GB (default: 3)
  --no-deploy         Provision app + secrets only; skip the deploy step.
  -h, --help          Show this help.

Examples:
  $0 acme-corp
  $0 acme-corp --region sin --memory 2gb
  DATABASE_URL=postgres://... $0 acme-corp --no-deploy
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)      print_usage; exit 0 ;;
    --region)       REGION="$2"; shift 2 ;;
    --db-url)       DB_URL="$2"; shift 2 ;;
    --memory)       VM_MEMORY="$2"; shift 2 ;;
    --volume)       VOLUME_SIZE_GB="$2"; shift 2 ;;
    --no-deploy)    AUTO_DEPLOY="false"; shift ;;
    -*)             echo "Unknown option: $1" >&2; print_usage; exit 1 ;;
    *)              if [[ -z "$SLUG" ]]; then SLUG="$1"; else echo "Unexpected arg: $1" >&2; exit 1; fi; shift ;;
  esac
done

if [[ -z "$SLUG" ]]; then
  echo "Error: <customer-slug> is required" >&2
  print_usage
  exit 1
fi

# Normalize slug — lowercase + kebab.
SLUG="$(echo "$SLUG" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | sed 's/--*/-/g' | sed 's/^-//; s/-$//')"

# Validate slug length — Fly enforces max 30 chars for app names, plan for "founderos-" prefix
if [[ ${#SLUG} -gt 20 ]]; then
  echo "Error: slug normalized to '$SLUG' is too long (max 20 chars, allowing 10 for 'founderos-' prefix)" >&2
  exit 1
fi

APP_NAME="founderos-${SLUG}"

# ────────────────────────────────────────────────────────────────────────
# Preflight
# ────────────────────────────────────────────────────────────────────────
echo "→ Checking prerequisites..."

if ! command -v fly >/dev/null 2>&1; then
  echo "✗ flyctl not installed. See https://fly.io/docs/flyctl/install/" >&2
  exit 1
fi

if ! fly auth whoami >/dev/null 2>&1; then
  echo "✗ Not logged into Fly. Run: fly auth login" >&2
  exit 1
fi

if [[ -z "$DB_URL" ]]; then
  echo "✗ DATABASE_URL not set. Pass --db-url or export DATABASE_URL." >&2
  echo "   Example: ./scripts/fly-provision.sh $SLUG --db-url 'postgres://user:pass@db.example.com/founderos'" >&2
  exit 1
fi

# Validate DATABASE_URL format
if [[ ! "$DB_URL" =~ ^postgres:// ]]; then
  echo "✗ DATABASE_URL must start with postgres:// (got: ${DB_URL:0:20}...)" >&2
  exit 1
fi

echo "✓ Prerequisites met"

echo "──────────────────────────────────────────────────"
echo " FounderOS · provisioning new customer instance"
echo "──────────────────────────────────────────────────"
echo " Customer slug:   $SLUG"
echo " Fly app name:    $APP_NAME"
echo " Region:          $REGION"
echo " VM memory:       $VM_MEMORY"
echo " Volume:          ${VOLUME_SIZE_GB}gb"
echo " Auto-deploy:     $AUTO_DEPLOY"
echo "──────────────────────────────────────────────────"

# ────────────────────────────────────────────────────────────────────────
# 1. Create the app
# ────────────────────────────────────────────────────────────────────────
if fly apps list 2>/dev/null | awk '{print $1}' | grep -qx "$APP_NAME"; then
  echo "✓ App $APP_NAME already exists — reusing"
else
  echo "→ Creating Fly app $APP_NAME"
  fly apps create "$APP_NAME" >/dev/null
fi

# ────────────────────────────────────────────────────────────────────────
# 2. Attach a persistent volume
# ────────────────────────────────────────────────────────────────────────
existing_volume=$(fly volumes list --app "$APP_NAME" 2>/dev/null | awk '$2=="founderos_data" {print $1}' | head -1)
if [[ -n "$existing_volume" ]]; then
  echo "✓ Volume founderos_data already exists ($existing_volume)"
else
  echo "→ Creating ${VOLUME_SIZE_GB}gb volume in region $REGION"
  fly volumes create founderos_data \
    --app "$APP_NAME" \
    --region "$REGION" \
    --size "$VOLUME_SIZE_GB" \
    --yes >/dev/null
fi

# ────────────────────────────────────────────────────────────────────────
# 3. Set secrets
# ────────────────────────────────────────────────────────────────────────
echo "→ Setting DATABASE_URL secret"
fly secrets set "DATABASE_URL=$DB_URL" --app "$APP_NAME" --stage >/dev/null

if ! fly secrets list --app "$APP_NAME" | grep -q "^FOUNDEROS_SECRETS_MASTER_KEY"; then
  MASTER_KEY="$(openssl rand -base64 32)"
  echo "→ Generating FOUNDEROS_SECRETS_MASTER_KEY"
  fly secrets set "FOUNDEROS_SECRETS_MASTER_KEY=$MASTER_KEY" --app "$APP_NAME" --stage >/dev/null
else
  echo "✓ FOUNDEROS_SECRETS_MASTER_KEY already set — preserving"
fi

# Pass-through optional secrets from environment if set
OPTIONAL_SECRETS=(
  CLERK_SECRET_KEY
  CLERK_PUBLISHABLE_KEY
  ANTHROPIC_API_KEY
  OPENAI_API_KEY
  GEMINI_API_KEY
  RESEND_API_KEY
  SENTRY_DSN
  BETTER_AUTH_SECRET
)

OPTIONAL_COUNT=0
for optional in "${OPTIONAL_SECRETS[@]}"; do
  if [[ -n "${!optional:-}" ]]; then
    echo "→ Setting $optional from environment"
    fly secrets set "$optional=${!optional}" --app "$APP_NAME" --stage >/dev/null
    ((OPTIONAL_COUNT++))
  fi
done

if [[ $OPTIONAL_COUNT -eq 0 ]]; then
  echo "ℹ  No optional secrets set. You can add them later with: fly secrets set KEY=value --app $APP_NAME"
fi

echo "✓ Secrets staged"

# ────────────────────────────────────────────────────────────────────────
# 4. Deploy
# ────────────────────────────────────────────────────────────────────────
if [[ "$AUTO_DEPLOY" == "true" ]]; then
  echo "→ Deploying app (fly deploy --app $APP_NAME)"
  if ! fly deploy --app "$APP_NAME" --regions "$REGION"; then
    echo "✗ Deploy failed. Check logs with: fly logs --app $APP_NAME" >&2
    exit 1
  fi
  echo ""
  echo "──────────────────────────────────────────────────"
  echo " ✓ Provisioned!"
  echo "──────────────────────────────────────────────────"
  URL="https://${APP_NAME}.fly.dev"
  echo " URL:           $URL"
  echo " Liveness:      $URL/api/healthz"
  echo " Readiness:     $URL/api/readyz"
  echo " Status JSON:   $URL/api/health"
  echo ""
  echo " Next steps:"
  echo " 1. Wait 30s for machine startup, then: curl $URL/api/readyz"
  echo " 2. Open in browser: $URL"
  echo " 3. Check logs:      fly logs --app $APP_NAME --follow"
  echo "──────────────────────────────────────────────────"
else
  echo ""
  echo "✓ App + volume + secrets staged. Run when ready:"
  echo "  fly deploy --app $APP_NAME"
fi
