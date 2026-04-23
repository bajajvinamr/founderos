#!/usr/bin/env bash
#
# scripts/ci/rollback-verify.sh — run AFTER a `flyctl releases rollback`.
# Re-runs the smoke harness one more time. If the rollback target is ALSO
# broken (smoke still red), exits with code 2 and prints a loud banner
# telling the operator to escalate — the last known-good release is no
# longer healthy and a human has to step in.
#
# Usage:
#   scripts/ci/rollback-verify.sh \
#     --url https://founderos.fly.dev/api/healthz \
#     --url https://founderos-bice.vercel.app/ \
#     --url https://founderos-bice.vercel.app/api/healthz
#
# Exit codes:
#   0 — rollback target is healthy, we stabilised
#   1 — invocation error
#   2 — rollback target also broken; ESCALATE
#
# The underlying probing is delegated to scripts/ci/smoke.sh so logic stays
# consistent across pre-deploy and post-rollback checks.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SMOKE="$SCRIPT_DIR/smoke.sh"

if [[ ! -x "$SMOKE" ]]; then
  # Fall back to invoking via bash if exec bit was dropped (e.g. Windows checkout).
  SMOKE="bash $SCRIPT_DIR/smoke.sh"
fi

if [[ $# -eq 0 ]]; then
  echo "usage: $0 --url <u> [--url <u> ...]" >&2
  exit 1
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " rollback-verify: checking rollback target is healthy"
echo "═══════════════════════════════════════════════════════════════"

# Give Fly a moment to route traffic to the rolled-back release before we probe.
# Machines redeploy on rollback; 15s is a reasonable grace period.
sleep 15

set +e
# Use slightly more generous retries here — a rolled-back release may still
# be warming back up (cold-start on auto-stopped machines).
$SMOKE --retries 5 --initial-delay 3 --timeout 45 "$@"
rc=$?
set -e

if [[ "$rc" -eq 0 ]]; then
  echo ""
  echo "rollback-verify: target release is healthy. System stabilised."
  exit 0
fi

cat >&2 <<'EOF'

═══════════════════════════════════════════════════════════════
 ESCALATE: rollback target is ALSO broken.
═══════════════════════════════════════════════════════════════
 The most recent release failed smoke. We rolled back to the
 previous release. That release is also failing smoke.

 Next steps for the on-call human:
   1. Check Fly status:   flyctl status --app founderos
   2. Check Fly releases: flyctl releases list --app founderos
   3. Roll back further:  flyctl releases rollback <older-version>
   4. Check upstream dependencies (Postgres, Supabase, LLM providers)
   5. If still red, page a teammate — this is likely infra, not code.

EOF
exit 2
