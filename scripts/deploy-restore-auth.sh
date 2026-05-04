#!/usr/bin/env bash
# deploy-restore-auth.sh — paste-safe production redeploy with VITE_* build args.
#
# Usage:
#   scripts/deploy-restore-auth.sh <VITE_SUPABASE_ANON_KEY>
#
# Or, if you want to set it once in your shell:
#   export VITE_SUPABASE_ANON_KEY='eyJ...'
#   scripts/deploy-restore-auth.sh
#
# Why this exists: the deploy command has 4 --build-arg flags + a JWT. Pasting
# that into zsh is fragile (smart quotes, line wraps, $-substitution). This
# script is a single short token to invoke and runs the deploy reliably.

set -euo pipefail

ANON_KEY="${1:-${VITE_SUPABASE_ANON_KEY:-}}"
SUPABASE_URL="${VITE_SUPABASE_URL:-https://ggspsiexqppduvsqvpgy.supabase.co}"
SENTRY_DSN="${VITE_SENTRY_DSN:-}"

if [[ -z "$ANON_KEY" ]]; then
  echo "ERROR: anon key required."
  echo "  scripts/deploy-restore-auth.sh '<eyJ... anon JWT or sb_publishable_... key>'"
  echo "  OR  export VITE_SUPABASE_ANON_KEY='...' first"
  exit 2
fi

# Sanity: prevent accidentally deploying a service_role key to the SPA bundle.
# Decode the JWT payload (if it's a legacy JWT) and refuse if role != anon.
if [[ "$ANON_KEY" == eyJ* ]]; then
  payload="$(echo "$ANON_KEY" | cut -d. -f2)"
  # base64url -> base64 (replace - with +, _ with /, pad to length-mod-4)
  pad="$((4 - ${#payload} % 4))"
  if [[ "$pad" -lt 4 ]]; then payload="${payload}$(printf '%*s' "$pad" '' | tr ' ' '=')"; fi
  decoded="$(printf '%s' "$payload" | tr '\-_' '+/' | base64 -d 2>/dev/null || true)"
  if [[ "$decoded" == *'"role":"service_role"'* ]]; then
    echo "REFUSING: this is a SERVICE_ROLE key — would expose admin DB access to every visitor."
    echo "  Get the anon key instead from Supabase dashboard → Project Settings → API."
    exit 3
  fi
elif [[ "$ANON_KEY" == sb_secret_* ]]; then
  echo "REFUSING: sb_secret_ keys are server-only. Use the sb_publishable_ key for the browser bundle."
  exit 3
fi

GIT_SHA="$(git rev-parse HEAD)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "Deploying:"
echo "  SUPABASE_URL = $SUPABASE_URL"
echo "  ANON_KEY     = ${ANON_KEY:0:12}…${ANON_KEY: -4} (length=${#ANON_KEY})"
echo "  GIT_SHA      = $GIT_SHA"
echo "  BUILD_TIME   = $BUILD_TIME"
echo "  SENTRY_DSN   = ${SENTRY_DSN:+set}${SENTRY_DSN:-not set (browser Sentry disabled)}"
echo ""

exec fly deploy \
  --app founderos \
  --ha=false \
  --remote-only \
  --build-arg "VITE_SUPABASE_URL=$SUPABASE_URL" \
  --build-arg "VITE_SUPABASE_ANON_KEY=$ANON_KEY" \
  --build-arg "VITE_SENTRY_DSN=$SENTRY_DSN" \
  --build-arg "VITE_BUILD_GIT_SHA=$GIT_SHA" \
  --build-arg "VITE_BUILD_TIME=$BUILD_TIME"
