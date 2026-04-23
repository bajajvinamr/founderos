#!/usr/bin/env bash
#
# scripts/ci/smoke.sh — post-deploy smoke harness.
#
# Hits one or more URLs, expects HTTP 200, retries with exponential backoff,
# and prints a table of {endpoint, status, latency_ms, attempts}. Exits
# non-zero on any failure. Portable across macOS and Linux (no bashisms that
# break on macOS 3.2 bash — we use /usr/bin/env bash which is 5.x on runners;
# but the script itself avoids associative arrays and mapfile to stay safe
# when someone runs it locally on an older macOS bash).
#
# Usage:
#   scripts/ci/smoke.sh \
#     --url https://founderos.fly.dev/api/healthz \
#     --url https://founderos-bice.vercel.app/ \
#     --url https://founderos-bice.vercel.app/api/healthz
#
# Flags:
#   --url <u>           Endpoint to probe (repeatable).
#   --timeout <sec>     Per-request timeout. Default 30.
#   --retries <n>       Max attempts per URL. Default 3.
#   --initial-delay <s> Initial backoff (sec). Default 2. Doubles each retry.
#   --expect <code>     Required status code. Default 200.
#   --json <path>       Optionally write machine-readable results as JSON.
#   --quiet             Suppress per-attempt logging (keeps final table).
#   -h | --help         Show this help.
#
# Exit codes:
#   0  — all URLs returned the expected status within the retry budget.
#   1  — one or more URLs failed. stderr contains the failed curl command
#        and the last response body for each failure (for reproduction).
#   2  — bad invocation (missing --url, unknown flag, etc.).
#
# Idempotent + safe to run locally — no side effects beyond HTTP GETs and
# (optionally) a JSON file write.

set -euo pipefail

URLS=()
TIMEOUT=30
RETRIES=3
INITIAL_DELAY=2
EXPECT=200
JSON_OUT=""
QUIET=0

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)           URLS+=("$2"); shift 2 ;;
    --timeout)       TIMEOUT="$2"; shift 2 ;;
    --retries)       RETRIES="$2"; shift 2 ;;
    --initial-delay) INITIAL_DELAY="$2"; shift 2 ;;
    --expect)        EXPECT="$2"; shift 2 ;;
    --json)          JSON_OUT="$2"; shift 2 ;;
    --quiet)         QUIET=1; shift ;;
    -h|--help)       usage 0 ;;
    *)               echo "unknown flag: $1" >&2; usage 2 ;;
  esac
done

if [[ ${#URLS[@]} -eq 0 ]]; then
  echo "error: at least one --url is required" >&2
  usage 2
fi

log() { [[ "$QUIET" -eq 1 ]] || echo "$@" >&2; }

# Portable high-resolution clock in milliseconds. macOS date doesn't have %N,
# so prefer python3 (present on runners + macOS). Falls back to seconds.
now_ms() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import time;print(int(time.time()*1000))'
  else
    # Second-resolution fallback; latency reported will round to seconds.
    echo $(( $(date +%s) * 1000 ))
  fi
}

# Probe a single URL. Echoes a CSV line: url,status,latency_ms,attempts,ok
# to stdout. Failure body is written to stderr with the exact curl command.
probe() {
  local url="$1"
  local attempt=1
  local delay="$INITIAL_DELAY"
  local status="000"
  local latency_ms=0
  local body=""
  local body_file
  body_file="$(mktemp -t founderos-smoke-body.XXXXXX)"
  # shellcheck disable=SC2064
  trap "rm -f '$body_file'" RETURN

  while [[ "$attempt" -le "$RETRIES" ]]; do
    local start end
    start="$(now_ms)"
    # -sS : silent but show errors; -L : follow redirects; -m : per-request timeout
    # -o : write body to file; -w : write status code to stdout.
    # We capture the command string so we can echo it on failure for repro.
    local curl_cmd="curl -sS -L -m $TIMEOUT -o '$body_file' -w '%{http_code}' '$url'"
    status="$(curl -sS -L -m "$TIMEOUT" -o "$body_file" -w '%{http_code}' "$url" || echo "000")"
    end="$(now_ms)"
    latency_ms=$(( end - start ))

    if [[ "$status" == "$EXPECT" ]]; then
      log "  OK    [$attempt/$RETRIES] $url -> $status (${latency_ms}ms)"
      echo "$url,$status,$latency_ms,$attempt,1"
      return 0
    fi

    log "  RETRY [$attempt/$RETRIES] $url -> $status (${latency_ms}ms); sleeping ${delay}s"
    attempt=$(( attempt + 1 ))
    if [[ "$attempt" -le "$RETRIES" ]]; then
      sleep "$delay"
      delay=$(( delay * 2 ))
    fi
  done

  body="$(head -c 2048 "$body_file" 2>/dev/null || true)"
  {
    echo ""
    echo "FAIL: $url"
    echo "  expected: $EXPECT"
    echo "  got:      $status after $RETRIES attempt(s), last latency ${latency_ms}ms"
    echo "  repro:    $curl_cmd"
    echo "  body:     (first 2048 bytes)"
    echo "----------------------------------------"
    echo "$body"
    echo "----------------------------------------"
  } >&2
  echo "$url,$status,$latency_ms,$(( attempt - 1 )),0"
  return 1
}

log "smoke: probing ${#URLS[@]} endpoint(s) (timeout=${TIMEOUT}s retries=${RETRIES} expect=${EXPECT})"
log ""

RESULTS=()
FAIL_COUNT=0
for u in "${URLS[@]}"; do
  # Don't abort the whole loop on one failure — gather all results first.
  set +e
  line="$(probe "$u")"
  rc=$?
  set -e
  RESULTS+=("$line")
  if [[ "$rc" -ne 0 ]]; then
    FAIL_COUNT=$(( FAIL_COUNT + 1 ))
  fi
done

# ── Render summary table ───────────────────────────────────────────────
log ""
printf "%-60s  %-6s  %-10s  %-8s  %s\n" "ENDPOINT" "STATUS" "LATENCY" "ATTEMPTS" "OK"
printf "%-60s  %-6s  %-10s  %-8s  %s\n" "--------" "------" "-------" "--------" "--"
for r in "${RESULTS[@]}"; do
  IFS=',' read -r url status latency attempts ok <<< "$r"
  # Truncate long URLs for the table but keep full URL in JSON output.
  display_url="$url"
  if [[ "${#display_url}" -gt 60 ]]; then
    display_url="${display_url:0:57}..."
  fi
  ok_label="yes"; [[ "$ok" == "1" ]] || ok_label="NO"
  printf "%-60s  %-6s  %-10s  %-8s  %s\n" "$display_url" "$status" "${latency}ms" "$attempts" "$ok_label"
done
log ""

# ── Optional JSON output ───────────────────────────────────────────────
if [[ -n "$JSON_OUT" ]]; then
  {
    echo "{"
    echo "  \"expect\": $EXPECT,"
    echo "  \"timeout_s\": $TIMEOUT,"
    echo "  \"retries\": $RETRIES,"
    echo "  \"failures\": $FAIL_COUNT,"
    echo "  \"results\": ["
    sep=""
    for r in "${RESULTS[@]}"; do
      IFS=',' read -r url status latency attempts ok <<< "$r"
      # Escape double-quotes in URLs defensively.
      url_esc="${url//\"/\\\"}"
      echo "    ${sep}{\"url\":\"$url_esc\",\"status\":\"$status\",\"latency_ms\":$latency,\"attempts\":$attempts,\"ok\":$([[ "$ok" == "1" ]] && echo true || echo false)}"
      sep=","
    done
    echo "  ]"
    echo "}"
  } > "$JSON_OUT"
  log "wrote $JSON_OUT"
fi

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  echo "smoke: $FAIL_COUNT endpoint(s) failed" >&2
  exit 1
fi

log "smoke: all ${#URLS[@]} endpoint(s) healthy"
exit 0
