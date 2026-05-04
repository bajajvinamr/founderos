#!/usr/bin/env bash
# check-deployed-supabase.sh — fail-fast detector for the 2026-05-04 incident class.
#
# Usage: check-deployed-supabase.sh <ORIGIN>
#   e.g.  check-deployed-supabase.sh https://founderos.fly.dev
#
# Exits 0 if the deployed SPA's JS assets do NOT contain the placeholder
# Supabase host. Exits 1 (with diagnostic output) if they do.
#
# Why this exists: a missing VITE_SUPABASE_URL build arg causes the Vite
# bundle to ship the literal sentinel "placeholder.supabase.co", which
# DNS-NXDOMAINs at runtime and silently breaks every auth flow. The Vite
# build-time guard in ui/vite.config.ts catches this in the build, but a
# runtime check on the deployed origin is the last-line defense before
# users see "Failed to fetch" / "DNS_PROBE_FINISHED_NXDOMAIN".

set -euo pipefail

ORIGIN="${1:?usage: check-deployed-supabase.sh <ORIGIN>}"
# Match the URL form, not the bare host. The bare host `placeholder.supabase.co`
# also appears in the runtime sentinel constant in src/lib/supabase.ts (used by
# the validator to detect bad bundles). Matching the URL form catches the actual
# bug — `createClient("https://placeholder.supabase.co", ...)` — without flagging
# healthy bundles that just import the sentinel string.
PLACEHOLDER='https://placeholder.supabase.co'

echo "→ Fetching SPA shell from ${ORIGIN}/"
HTML="$(curl -sS -m 30 "${ORIGIN}/")" || {
  echo "FAIL: could not fetch SPA shell"
  exit 1
}

# Pull every <script src="..."> path. Vite emits hashed asset names
# (e.g. /assets/index-BnnYyfnv.js) so we discover them dynamically rather
# than hard-coding.
ASSETS="$(echo "$HTML" | grep -oE 'src="[^"]*\.js"' | sed -E 's/src="([^"]+)"/\1/' | head -20)"
if [[ -z "$ASSETS" ]]; then
  echo "FAIL: no <script src> assets found in ${ORIGIN}/ — is the SPA being served?"
  exit 1
fi

echo "→ Scanning $(echo "$ASSETS" | wc -l | tr -d ' ') JS assets for the placeholder host..."

FOUND=0
while IFS= read -r asset_path; do
  [[ -z "$asset_path" ]] && continue
  # Resolve relative paths against the origin
  if [[ "$asset_path" == /* ]]; then
    url="${ORIGIN}${asset_path}"
  else
    url="${ORIGIN}/${asset_path}"
  fi

  # Stream the asset to a temp file, then grep. Avoids two pitfalls:
  #  • SIGPIPE from `grep -q` early-exit when `set -o pipefail` is on
  #  • bash variable-size limits when buffering 1MB+ JS bundles into a var
  tmp="$(mktemp)"
  if ! curl -sS -m 30 "$url" -o "$tmp"; then
    echo "WARN: failed to download ${url}"
    rm -f "$tmp"
    continue
  fi
  if grep -qF "$PLACEHOLDER" "$tmp"; then
    echo "FAIL: $url contains the placeholder host '${PLACEHOLDER}'"
    FOUND=1
  fi
  rm -f "$tmp"
done <<< "$ASSETS"

if [[ "$FOUND" -ne 0 ]]; then
  echo ""
  echo "─────────────────────────────────────────────────────────"
  echo " Deployed bundle is broken. Auth will fail for every user."
  echo "─────────────────────────────────────────────────────────"
  echo " Root cause: the Vite build did not receive VITE_SUPABASE_URL"
  echo " as a build-arg, so the placeholder fallback got embedded."
  echo ""
  echo " Fix: redeploy with the build arg set:"
  echo "   fly deploy --build-arg VITE_SUPABASE_URL=https://<project-ref>.supabase.co \\"
  echo "              --build-arg VITE_SUPABASE_ANON_KEY=<eyJ...> ..."
  echo ""
  echo " See docs/runbooks/supabase-config.md for the full procedure."
  exit 1
fi

echo "OK: deployed bundle does not contain the placeholder Supabase host."
