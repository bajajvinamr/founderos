#!/usr/bin/env bash
#
# fly-smoke.sh — post-deploy validation for a live FounderOS instance.
#
# Hits the running app and confirms the critical surface area works:
#   - /api/health returns 200 + correct fields
#   - /api/auth/config identifies the expected provider
#   - /api/templates returns the 3 built-in templates
#   - /api/providers returns a provider availability report
#   - /api/templates/spawn works (spawns + deletes a throwaway company if
#     credentials are present)
#
# Usage:
#   ./scripts/fly-smoke.sh <url>
#   ./scripts/fly-smoke.sh founderos-acme-corp      # auto-expands to fly.dev
#
# Exit codes:
#   0 — everything green
#   1 — one or more checks failed
#
# Designed to run in CI after `fly deploy` or locally against any URL.

set -euo pipefail

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo "Usage: $0 <url-or-app-name>" >&2
  exit 1
fi

# If user passed a bare slug like "founderos-acme", expand to fly.dev URL
if [[ "$TARGET" != http* ]]; then
  TARGET="https://${TARGET}.fly.dev"
fi
BASE="${TARGET%/}"

FAIL=0
pass()  { echo "  ✓ $*"; }
fail()  { echo "  ✗ $*" >&2; FAIL=1; }
header() { echo ""; echo "━━ $* ━━"; }

# ────────────────────────────────────────────────────────────────────────
header "Target: $BASE"

# 1. Health
header "1. Health check"
HEALTH=$(curl -sL -m 10 -w "\n%{http_code}" "$BASE/api/health" || echo "000")
STATUS="${HEALTH##*$'\n'}"
BODY="${HEALTH%$'\n'*}"
if [[ "$STATUS" == "200" ]]; then
  pass "HTTP 200"
  if echo "$BODY" | grep -q '"status":"ok"'; then pass "status=ok"; else fail "status not ok: $BODY"; fi
  if echo "$BODY" | grep -q '"authReady":true'; then pass "authReady=true"; else fail "authReady not true"; fi
else
  fail "health returned $STATUS"
fi

# 2. Auth config
header "2. Auth config"
AUTH=$(curl -sL -m 10 "$BASE/api/auth/config" || echo "")
if echo "$AUTH" | grep -qE '"provider":"(clerk|better-auth|local_trusted)"'; then
  pass "provider field present: $(echo "$AUTH" | sed 's/.*"provider":"\([^"]*\)".*/\1/')"
else
  fail "auth config not returned: $AUTH"
fi

# 3. Bootstrap a session (needed for authenticated routes in local_trusted)
header "3. Session bootstrap"
COOKIES=$(mktemp -t founderos-smoke-XXXXXX)
trap "rm -f '$COOKIES'" EXIT
curl -sL -m 10 -c "$COOKIES" "$BASE/" >/dev/null
if [[ -s "$COOKIES" ]]; then pass "cookies received"; else fail "no session cookies"; fi

# 4. Templates API
header "4. Templates API"
T=$(curl -sL -m 15 -b "$COOKIES" "$BASE/api/templates" || echo "[]")
N=$(echo "$T" | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else 0)" 2>/dev/null || echo 0)
if [[ "$N" -ge 3 ]]; then
  pass "$N templates returned"
else
  fail "expected >=3 templates, got $N ($T)"
fi

# 5. Providers API
header "5. Providers API"
P=$(curl -sL -m 15 -b "$COOKIES" "$BASE/api/providers" || echo "{}")
if echo "$P" | grep -q '"availability"'; then
  pass "availability present"
  ANY=$(echo "$P" | python3 -c "import json,sys;print(json.load(sys.stdin).get('availability',{}).get('anyConfigured',False))" 2>/dev/null)
  pass "anyConfigured=$ANY"
else
  fail "providers response malformed"
fi

# 6. Spawn + cleanup (only if any provider configured)
ANY=$(echo "$P" | python3 -c "import json,sys;d=json.load(sys.stdin);print('1' if d.get('availability',{}).get('anyConfigured') else '0')" 2>/dev/null || echo 0)
if [[ "$ANY" == "1" ]]; then
  header "6. Template spawn round-trip"
  SPAWN_NAME="smoke-$(date +%s)"
  SPAWN=$(curl -sL -m 30 -b "$COOKIES" -X POST "$BASE/api/templates/spawn" \
    -H "content-type: application/json" \
    -d "{\"templateId\":\"solo-indie-saas-founder\",\"companyName\":\"$SPAWN_NAME\",\"providerStrategy\":\"mixed\"}" || echo "{}")
  CID=$(echo "$SPAWN" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('companyId',''))" 2>/dev/null)
  if [[ -n "$CID" ]]; then
    pass "spawn succeeded (companyId=$CID)"
    pass "adapters resolved: $(echo "$SPAWN" | python3 -c "import json,sys;d=json.load(sys.stdin);print(', '.join(sorted(set(a['adapterType'] for a in d.get('adaptersUsed',{}).values()))))" 2>/dev/null)"
    # Note: no cleanup endpoint yet — test company will persist. The dogfood
    # playbook calls this out; prod smokes should dedicate a throwaway DB.
    echo "  ℹ Leaving company \"$SPAWN_NAME\" ($CID) behind. Clean up manually in prod."
  else
    fail "spawn failed: $SPAWN"
  fi
else
  header "6. Template spawn round-trip"
  echo "  ⊘ skipped — no provider credentials configured"
fi

# ────────────────────────────────────────────────────────────────────────
header "Summary"
if [[ "$FAIL" == "0" ]]; then
  echo "  ✓ All checks passed. $BASE is healthy."
  exit 0
else
  echo "  ✗ One or more checks failed — investigate before traffic routes here."
  exit 1
fi
