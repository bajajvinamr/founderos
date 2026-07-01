#!/usr/bin/env bash
# verify.sh — local definition-of-done gate for FounderOS.
#
# Runs every locally-runnable check and exits non-zero if ANY blocking check
# fails. Mirrors the deploy-prod.yml "preflight" job (typecheck + tests),
# which is the structural backstop on the deploy path, plus a full build.
#
# The complete gate (including checks that need prod access) is in DONE.md.
#
# Usage:
#   ./verify.sh          # full gate: typecheck + tests + build
#   ./verify.sh --fast   # preflight parity only: typecheck + tests (skip build)

set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

RESULTS=()
FAILED=0

run_check() {
  local name="$1"; shift
  echo ""
  echo "════════════════════════════════════════════════════"
  echo "  CHECK: ${name}"
  echo "════════════════════════════════════════════════════"
  if "$@"; then
    RESULTS+=("PASS  ${name}")
  else
    RESULTS+=("FAIL  ${name}")
    FAILED=1
  fi
}

# ── Preconditions ────────────────────────────────────────────────────
if ! command -v pnpm >/dev/null 2>&1; then
  echo "FATAL: pnpm not found — cannot run any check." >&2
  exit 2
fi
if [ ! -d node_modules ]; then
  echo "FATAL: node_modules missing — run 'pnpm install' first." >&2
  exit 2
fi

# ── Gate (mirrors .github/workflows/deploy-prod.yml preflight job) ───
# 1. Typecheck — same as CI "pnpm -r typecheck"; root script also runs
#    the workspace-links preflight that CI depends on.
run_check "typecheck (pnpm typecheck)" pnpm typecheck

# 2. Unit/integration tests — same as CI "pnpm test:run" (vitest run).
run_check "tests (pnpm test:run)" pnpm test:run

# 3. Full monorepo build. Not part of the deploy-prod preflight job
#    (Fly builds in its own step), but a broken build must never reach
#    a deploy attempt. Skipped with --fast.
if [ "$FAST" -eq 0 ]; then
  run_check "build (pnpm build)" pnpm build
else
  RESULTS+=("SKIP  build (--fast)")
fi

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════"
echo "  VERIFY SUMMARY — founderos"
echo "════════════════════════════════════════════════════"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo ""
if [ "$FAILED" -ne 0 ]; then
  echo "  RESULT: FAIL — do not ship. See DONE.md for the full gate."
  exit 1
fi
echo "  RESULT: PASS (local gate). Remote checks remain — see DONE.md."
exit 0
