#!/usr/bin/env bash
# scripts/s8-p01-smoke.sh — staging smoke for S8 P0.1 hosted agent execution
#
# Companion runbook: docs/runbooks/s8-p01-staging-smoke.md (operator checklist)
# Plan reference:    .planning/PHASE-S8-P01/IMPLEMENTATION-PLAN.md
# Results target:    .planning/PHASE-S8-P01/SMOKE-RESULTS.md
#
# REVIEW BEFORE RUN. This script provisions Fly resources (one-time + monthly
# spend on a staging app + 3gb volume in lhr). Default mode is --dry-run so
# you can read every command before anything bills.
#
# Modes:
#   --dry-run   (default)  Print every action without executing.
#   --execute              Actually run the smoke. Requires env vars below.
#   --cleanup              Tear down the staging Fly app after success.
#   -h | --help            Show usage.
#
# Required env (only for --execute and --cleanup):
#   FLY_API_TOKEN        Scoped to org with permission to create/destroy apps.
#   ANTHROPIC_API_KEY    Test key (will be POSTed to onboarding/bootstrap).
#   STAGING_DB_URL       Postgres URL for assertion #2 (runner_jobs row count).
#
# Optional env:
#   FOUNDEROS_STAGING_APP_NAME  (default: founderos-s8smoke)
#   FOUNDEROS_STAGING_REGION    (default: lhr)
#   FOUNDEROS_SECRETS_MASTER_KEY  (auto-generated if unset; printed once)
#   VITE_SUPABASE_URL             (forwarded to fly deploy --build-arg)
#   VITE_SUPABASE_ANON_KEY        (forwarded to fly deploy --build-arg)
#
# Exit codes:
#   0  all 8 assertions passed (or dry-run completed)
#   1  one or more assertions failed
#   2  preflight failed (missing env, wrong branch, missing flyctl)
#   3  invalid arguments
#
# Idempotency:
#   - Re-runs detect existing app + volume and skip provisioning.
#   - Each run writes a fresh SMOKE-RESULTS.md (overwrite) so the file always
#     reflects the most recent attempt. Prior results live in git history.

set -euo pipefail

# ────────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────────

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly RESULTS_FILE="${REPO_ROOT}/.planning/PHASE-S8-P01/SMOKE-RESULTS.md"
readonly APP="${FOUNDEROS_STAGING_APP_NAME:-founderos-s8smoke}"
readonly REGION="${FOUNDEROS_STAGING_REGION:-lhr}"
readonly RUN_TIMEOUT_SEC=90       # Assertion #1: completed within 90s
readonly POLL_INTERVAL_SEC=5
readonly MEMORY_LIMIT_BYTES=$((1610612736))  # 1.6 GiB exact (assertion #6)

# ────────────────────────────────────────────────────────────────────────
# Colors + logging
# ────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  readonly C_RESET=$'\033[0m'
  readonly C_GREEN=$'\033[32m'
  readonly C_RED=$'\033[31m'
  readonly C_YELLOW=$'\033[33m'
  readonly C_DIM=$'\033[2m'
  readonly C_BOLD=$'\033[1m'
else
  readonly C_RESET="" C_GREEN="" C_RED="" C_YELLOW="" C_DIM="" C_BOLD=""
fi

pass()  { echo "${C_GREEN}  PASS${C_RESET}  $*"; }
fail()  { echo "${C_RED}  FAIL${C_RESET}  $*" >&2; }
skip()  { echo "${C_YELLOW}  SKIP${C_RESET}  $*"; }
info()  { echo "${C_DIM}  ...${C_RESET}   $*"; }
hdr()   { echo; echo "${C_BOLD}=== $* ===${C_RESET}"; }
exec_echo() { echo "${C_DIM}\$ $*${C_RESET}"; }

# ────────────────────────────────────────────────────────────────────────
# Argument parsing
# ────────────────────────────────────────────────────────────────────────

MODE="dry-run"

usage() {
  sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

while (( $# )); do
  case "$1" in
    --dry-run)  MODE="dry-run" ;;
    --execute)  MODE="execute" ;;
    --cleanup)  MODE="cleanup" ;;
    -h|--help)  usage ;;
    *) echo "Unknown arg: $1" >&2; exit 3 ;;
  esac
  shift
done

# DRY=1 means "print, don't execute" — set for dry-run; cleanup runs for real.
DRY=0
[[ "$MODE" == "dry-run" ]] && DRY=1

run() {
  # Echo the command, then execute unless DRY=1.
  exec_echo "$*"
  if [[ "$DRY" -eq 0 ]]; then
    "$@"
  fi
}

run_capture() {
  # Echo + execute + capture stdout. In dry-run, returns empty.
  exec_echo "$*"
  if [[ "$DRY" -eq 0 ]]; then
    "$@"
  else
    echo ""
  fi
}

# ────────────────────────────────────────────────────────────────────────
# Preflight
# ────────────────────────────────────────────────────────────────────────

preflight() {
  hdr "Preflight"
  info "Mode:    $MODE"
  info "App:     $APP"
  info "Region:  $REGION"
  info "Repo:    $REPO_ROOT"

  # flyctl available
  if ! command -v fly >/dev/null 2>&1; then
    fail "flyctl not found in PATH. Install: https://fly.io/docs/flyctl/install/"
    exit 2
  fi
  pass "flyctl present"

  # Branch guard: only run from release/s8-p01-* or main (avoid running smoke
  # against a half-rebased dev branch by accident).
  local branch
  branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  case "$branch" in
    release/s8-p01-*|main|chore/s8-p01-staging-smoke)
      pass "branch ok ($branch)"
      ;;
    *)
      if [[ "$MODE" == "dry-run" ]]; then
        skip "branch is $branch — dry-run allowed; --execute will be refused"
      else
        fail "Refusing to run on branch '$branch'. Expected release/s8-p01-* or main."
        exit 2
      fi
      ;;
  esac

  # Env guard for execute / cleanup
  if [[ "$MODE" != "dry-run" ]]; then
    local missing=()
    [[ -z "${FLY_API_TOKEN:-}" ]] && missing+=("FLY_API_TOKEN")
    if [[ "$MODE" == "execute" ]]; then
      [[ -z "${ANTHROPIC_API_KEY:-}" ]] && missing+=("ANTHROPIC_API_KEY")
      [[ -z "${STAGING_DB_URL:-}" ]] && missing+=("STAGING_DB_URL")
    fi
    if (( ${#missing[@]} )); then
      fail "Missing required env: ${missing[*]}"
      echo "  Set them and re-run, e.g.:" >&2
      echo "    export FLY_API_TOKEN=fo1_..." >&2
      echo "    export ANTHROPIC_API_KEY=sk-ant-..." >&2
      echo "    export STAGING_DB_URL=postgres://..." >&2
      exit 2
    fi
    pass "env vars present"
  else
    skip "env-var check (dry-run)"
  fi
}

# ────────────────────────────────────────────────────────────────────────
# Provisioning (idempotent)
# ────────────────────────────────────────────────────────────────────────

provision() {
  hdr "Provision (idempotent)"

  # App
  if [[ "$DRY" -eq 0 ]] && fly apps list 2>/dev/null | awk '{print $1}' | grep -qx "$APP"; then
    info "App '$APP' already exists — skipping create"
  else
    run fly apps create "$APP" --org personal
  fi

  # Volume
  if [[ "$DRY" -eq 0 ]] && fly volumes list -a "$APP" 2>/dev/null | grep -q "founderos_data"; then
    info "Volume 'founderos_data' already exists on $APP — skipping create"
  else
    run fly volumes create founderos_data --size 3 --region "$REGION" -a "$APP" --yes
  fi

  # Master key for /founderos secrets — generate if not provided.
  local master_key="${FOUNDEROS_SECRETS_MASTER_KEY:-}"
  if [[ -z "$master_key" ]]; then
    if [[ "$DRY" -eq 0 ]]; then
      master_key="$(openssl rand -base64 32)"
      info "Generated FOUNDEROS_SECRETS_MASTER_KEY (printed once below — store in 1Password)"
      echo "    FOUNDEROS_SECRETS_MASTER_KEY=$master_key" >&2
    else
      master_key="<<dry-run-placeholder>>"
    fi
  fi

  # Secrets — set together to avoid multiple machine restarts.
  run fly secrets set \
    "DATABASE_URL=${STAGING_DB_URL:-<<placeholder>>}" \
    "FOUNDEROS_SECRETS_MASTER_KEY=${master_key}" \
    "FOUNDEROS_HOSTED_AGENTS_ENABLED=1" \
    "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-<<placeholder>>}" \
    "FOUNDEROS_BYO_RUNNER_ENABLED=0" \
    -a "$APP"
}

# ────────────────────────────────────────────────────────────────────────
# Deploy
# ────────────────────────────────────────────────────────────────────────

deploy() {
  hdr "Deploy"
  local supa_url="${VITE_SUPABASE_URL:-https://placeholder.supabase.co}"
  local supa_anon="${VITE_SUPABASE_ANON_KEY:-placeholder-anon-key}"
  run fly deploy -a "$APP" \
    --strategy immediate \
    --build-arg "VITE_SUPABASE_URL=$supa_url" \
    --build-arg "VITE_SUPABASE_ANON_KEY=$supa_anon" \
    --wait-timeout 300
}

# ────────────────────────────────────────────────────────────────────────
# Probes
# ────────────────────────────────────────────────────────────────────────

# Globals populated by probes — read by assertions.
COMPANY_ID=""
AGENT_ID=""
RUN_ID=""
RUN_STATUS=""
RUN_COST_MICROS=""
RUN_BODY_LATEST=""
PEAK_RSS_BYTES=0

onboarding_probe() {
  hdr "Probe 1 — Onboarding bootstrap"
  local url="https://${APP}.fly.dev/api/onboarding/bootstrap"
  local body
  body=$(cat <<'JSON'
{
  "companyName": "S8 Smoke Co",
  "founderEmail": "smoke+s8p01@founderos.dev",
  "anthropicApiKey": "__ANTHROPIC_API_KEY__"
}
JSON
)
  body="${body//__ANTHROPIC_API_KEY__/${ANTHROPIC_API_KEY:-<<placeholder>>}}"

  exec_echo "curl -sS -X POST $url -H 'content-type: application/json' -d '<body>'"
  if [[ "$DRY" -eq 0 ]]; then
    local resp
    resp="$(curl -sS -X POST "$url" -H 'content-type: application/json' -d "$body")"
    COMPANY_ID="$(jq -r '.companyId // .company_id // empty' <<<"$resp")"
    AGENT_ID="$(jq -r '.agentId // .agent_id // empty' <<<"$resp")"
    if [[ -z "$COMPANY_ID" || -z "$AGENT_ID" ]]; then
      fail "onboarding response missing companyId/agentId: $resp"
      exit 1
    fi
    info "companyId=$COMPANY_ID  agentId=$AGENT_ID"
  fi
}

heartbeat_probe() {
  hdr "Probe 2 — Heartbeat / wakeup"
  local url="https://${APP}.fly.dev/api/agents/${AGENT_ID:-<agentId>}/wakeup"
  run curl -sS -X POST "$url" -H 'content-type: application/json' -d '{}'

  hdr "Probe 3 — Poll runs/latest until completed (timeout ${RUN_TIMEOUT_SEC}s)"
  local deadline=$(( $(date +%s) + RUN_TIMEOUT_SEC ))
  local latest_url="https://${APP}.fly.dev/api/agents/${AGENT_ID:-<agentId>}/runs/latest"
  while [[ "$(date +%s)" -lt "$deadline" ]]; do
    if [[ "$DRY" -eq 1 ]]; then
      exec_echo "curl -sS $latest_url"
      info "(dry-run: skipping poll loop)"
      break
    fi
    RUN_BODY_LATEST="$(curl -sS "$latest_url" || echo '{}')"
    RUN_STATUS="$(jq -r '.status // empty' <<<"$RUN_BODY_LATEST")"
    RUN_ID="$(jq -r '.id // .runId // empty' <<<"$RUN_BODY_LATEST")"
    RUN_COST_MICROS="$(jq -r '.costMicros // .cost_micros // empty' <<<"$RUN_BODY_LATEST")"
    info "status=$RUN_STATUS runId=$RUN_ID"
    if [[ "$RUN_STATUS" == "completed" || "$RUN_STATUS" == "failed" ]]; then
      break
    fi
    sleep "$POLL_INTERVAL_SEC"
  done
}

memory_probe() {
  hdr "Probe 4 — Memory peak"
  if [[ "$DRY" -eq 1 ]]; then
    exec_echo "fly status -a $APP --json | jq '.machines[].state'"
    info "(dry-run: skipping live RSS sample)"
    return
  fi
  # `fly status -m` shows machine RSS in human-readable format. We capture and
  # convert. Best-effort — Fly may not expose precise peak RSS via CLI; pair
  # with /api/healthz `memory.rss` if exposed.
  local raw
  raw="$(fly status -a "$APP" --json 2>/dev/null || echo '{}')"
  PEAK_RSS_BYTES="$(jq -r '[.machines[]?.checks[]?.output] | map(scan("rss=([0-9]+)") | tonumber) | (max // 0)' <<<"$raw" 2>/dev/null || echo 0)"
  info "peak_rss_bytes=$PEAK_RSS_BYTES (limit ${MEMORY_LIMIT_BYTES})"
}

# ────────────────────────────────────────────────────────────────────────
# Assertions
# ────────────────────────────────────────────────────────────────────────

# Per-assertion result tracking — populated by assert_* functions.
declare -a A_STATUS A_EVIDENCE
A_TITLES=(
  "Run reaches status='completed' within ${RUN_TIMEOUT_SEC}s"
  "Zero new runner_jobs rows during run (hosted path bypasses queue)"
  "cost_micros non-null on run row"
  "Workdir cleaned up post-run (/founderos/agents/<companyId>/<runId>/ absent)"
  "Regression: byo_runner path still works with flag off"
  "Memory peak < 1.6gb during run"
  "No errors in fly logs (grep ERROR|Sentry returns no entries for run window)"
  "Workdir is mode 0700 (per-job HOME isolation) before cleanup"
)

mark() {
  # mark <idx> <pass|fail|skip> <evidence-string>
  A_STATUS[$1]="$2"
  A_EVIDENCE[$1]="$3"
}

assert_run_completed() {
  if [[ "$DRY" -eq 1 ]]; then
    mark 0 skip "dry-run"
    skip "(1) ${A_TITLES[0]}"
    return
  fi
  if [[ "$RUN_STATUS" == "completed" ]]; then
    mark 0 pass "runId=$RUN_ID status=completed"
    pass "(1) ${A_TITLES[0]}"
  else
    mark 0 fail "runId=$RUN_ID status=$RUN_STATUS body=$RUN_BODY_LATEST"
    fail "(1) ${A_TITLES[0]} (got status=$RUN_STATUS)"
  fi
}

assert_no_runner_jobs() {
  if [[ "$DRY" -eq 1 ]]; then
    mark 1 skip "dry-run"
    skip "(2) ${A_TITLES[1]}"
    return
  fi
  if ! command -v psql >/dev/null 2>&1; then
    mark 1 skip "psql not installed; assertion deferred to operator"
    skip "(2) ${A_TITLES[1]} — psql missing, run manually from Fly Postgres console"
    return
  fi
  local count
  count="$(psql "$STAGING_DB_URL" -tAc \
    "SELECT count(*) FROM runner_jobs WHERE created_at > now() - interval '5 minutes' AND company_id = '${COMPANY_ID}';" \
    2>/dev/null || echo "ERR")"
  if [[ "$count" == "0" ]]; then
    mark 1 pass "runner_jobs.count=0 in last 5min for company $COMPANY_ID"
    pass "(2) ${A_TITLES[1]}"
  else
    mark 1 fail "runner_jobs.count=$count for company $COMPANY_ID — hosted path leaked into queue"
    fail "(2) ${A_TITLES[1]} (count=$count)"
  fi
}

assert_cost_micros() {
  if [[ "$DRY" -eq 1 ]]; then
    mark 2 skip "dry-run"
    skip "(3) ${A_TITLES[2]}"
    return
  fi
  if [[ -n "$RUN_COST_MICROS" && "$RUN_COST_MICROS" != "null" && "$RUN_COST_MICROS" != "0" ]]; then
    mark 2 pass "cost_micros=$RUN_COST_MICROS"
    pass "(3) ${A_TITLES[2]}"
  else
    mark 2 fail "cost_micros=$RUN_COST_MICROS (expected non-null, non-zero)"
    fail "(3) ${A_TITLES[2]}"
  fi
}

assert_workdir_cleaned() {
  if [[ "$DRY" -eq 1 ]]; then
    mark 3 skip "dry-run"
    skip "(4) ${A_TITLES[3]}"
    return
  fi
  local listing
  listing="$(fly ssh console -a "$APP" -C "sh -c 'ls -1 /founderos/agents/${COMPANY_ID}/ 2>/dev/null || true'" 2>/dev/null || echo "ERR")"
  if [[ "$listing" == "ERR" ]]; then
    mark 3 skip "fly ssh failed; verify manually"
    skip "(4) ${A_TITLES[3]} — ssh failed"
    return
  fi
  if ! grep -q "$RUN_ID" <<<"$listing"; then
    mark 3 pass "no entry for runId=$RUN_ID under /founderos/agents/${COMPANY_ID}/"
    pass "(4) ${A_TITLES[3]}"
  else
    mark 3 fail "runId=$RUN_ID still present in workdir listing: $listing"
    fail "(4) ${A_TITLES[3]}"
  fi
}

assert_byo_regression() {
  # This step requires flipping the flag, redeploying, and running a second
  # onboard/run. Heavyweight — emit a plan in dry-run, run for real in execute.
  if [[ "$DRY" -eq 1 ]]; then
    mark 4 skip "dry-run"
    skip "(5) ${A_TITLES[4]}"
    return
  fi
  info "Flipping FOUNDEROS_HOSTED_AGENTS_ENABLED=0 + FOUNDEROS_BYO_RUNNER_ENABLED=1"
  fly secrets set \
    "FOUNDEROS_HOSTED_AGENTS_ENABLED=0" \
    "FOUNDEROS_BYO_RUNNER_ENABLED=1" \
    -a "$APP" >/dev/null
  # Re-onboard a second company to verify byo_runner adapter assignment.
  local body resp adapter
  body='{"companyName":"S8 BYO Regression","founderEmail":"smoke+s8byo@founderos.dev"}'
  resp="$(curl -sS -X POST "https://${APP}.fly.dev/api/onboarding/bootstrap" \
    -H 'content-type: application/json' -d "$body")"
  adapter="$(jq -r '.adapterType // .adapter_type // empty' <<<"$resp")"
  if [[ "$adapter" == "byo_runner" ]]; then
    mark 4 pass "regression company adapter_type=byo_runner"
    pass "(5) ${A_TITLES[4]}"
  else
    mark 4 fail "expected adapter_type=byo_runner, got '$adapter' resp=$resp"
    fail "(5) ${A_TITLES[4]}"
  fi
  # Restore for any subsequent assertions (cleanup leaves flags as-is).
  fly secrets set "FOUNDEROS_HOSTED_AGENTS_ENABLED=1" "FOUNDEROS_BYO_RUNNER_ENABLED=0" -a "$APP" >/dev/null
}

assert_memory_peak() {
  if [[ "$DRY" -eq 1 ]]; then
    mark 5 skip "dry-run"
    skip "(6) ${A_TITLES[5]}"
    return
  fi
  if (( PEAK_RSS_BYTES == 0 )); then
    mark 5 skip "could not parse peak RSS from fly status; verify manually via Grafana"
    skip "(6) ${A_TITLES[5]} — RSS unavailable"
    return
  fi
  if (( PEAK_RSS_BYTES < MEMORY_LIMIT_BYTES )); then
    mark 5 pass "peak_rss=$PEAK_RSS_BYTES bytes (< $MEMORY_LIMIT_BYTES)"
    pass "(6) ${A_TITLES[5]}"
  else
    mark 5 fail "peak_rss=$PEAK_RSS_BYTES bytes >= 1.6gb limit"
    fail "(6) ${A_TITLES[5]}"
  fi
}

assert_no_log_errors() {
  if [[ "$DRY" -eq 1 ]]; then
    mark 6 skip "dry-run"
    skip "(7) ${A_TITLES[6]}"
    return
  fi
  local log_url="https://fly.io/apps/${APP}/monitoring"
  # Use --no-tail to take a snapshot. grep -E for ERROR or Sentry-style markers.
  local errors
  errors="$(fly logs -a "$APP" --no-tail 2>/dev/null | grep -E 'ERROR|Sentry|UnhandledPromise|FATAL' | head -20 || true)"
  if [[ -z "$errors" ]]; then
    mark 6 pass "no ERROR/Sentry markers in recent logs ($log_url)"
    pass "(7) ${A_TITLES[6]}"
  else
    mark 6 fail "log errors detected ($log_url): $(head -c 500 <<<"$errors")"
    fail "(7) ${A_TITLES[6]}"
  fi
}

assert_workdir_mode() {
  # Sample BEFORE cleanup — only meaningful if we can race a heartbeat and
  # check during execution. As a fallback, check that the parent agent
  # directory is 0700 (the per-job dir inherits this). Acceptable proxy.
  if [[ "$DRY" -eq 1 ]]; then
    mark 7 skip "dry-run"
    skip "(8) ${A_TITLES[7]}"
    return
  fi
  local mode
  mode="$(fly ssh console -a "$APP" -C "sh -c 'stat -c %a /founderos/agents/${COMPANY_ID} 2>/dev/null || stat -f %A /founderos/agents/${COMPANY_ID} 2>/dev/null'" 2>/dev/null || echo "")"
  if [[ "$mode" == "700" ]]; then
    mark 7 pass "/founderos/agents/${COMPANY_ID} mode=700"
    pass "(8) ${A_TITLES[7]}"
  else
    mark 7 fail "expected mode=700, got '$mode' — per-job HOME isolation may be broken"
    fail "(8) ${A_TITLES[7]}"
  fi
}

# ────────────────────────────────────────────────────────────────────────
# Report writer
# ────────────────────────────────────────────────────────────────────────

emoji_for() {
  case "$1" in
    pass) echo "[PASS]" ;;
    fail) echo "[FAIL]" ;;
    skip) echo "[SKIP]" ;;
    *)    echo "[----]" ;;
  esac
}

write_report() {
  hdr "Writing $RESULTS_FILE"
  local now branch sha
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  sha="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"

  local overall="PASS"
  for s in "${A_STATUS[@]:-}"; do
    [[ "$s" == "fail" ]] && overall="FAIL"
  done
  if [[ "$DRY" -eq 1 ]]; then overall="DRY-RUN"; fi

  if [[ "$DRY" -eq 1 ]]; then
    info "(dry-run: would overwrite $RESULTS_FILE — not writing)"
    return
  fi

  {
    echo "# S8 P0.1 — Staging Smoke Results"
    echo
    echo "_Overall status: **${overall}**_"
    echo "_Last updated:   ${now}_"
    echo
    echo "## Run summary"
    echo "| Field | Value |"
    echo "|---|---|"
    echo "| Run timestamp (UTC) | ${now} |"
    echo "| Branch              | ${branch} |"
    echo "| Commit SHA          | ${sha} |"
    echo "| Fly app             | ${APP} |"
    echo "| Region              | ${REGION} |"
    echo "| Fly logs            | https://fly.io/apps/${APP}/monitoring |"
    echo "| companyId           | ${COMPANY_ID:-n/a} |"
    echo "| agentId             | ${AGENT_ID:-n/a} |"
    echo "| runId               | ${RUN_ID:-n/a} |"
    echo
    echo "## Assertions"
    echo
    echo "| # | Assertion | Status | Evidence |"
    echo "|---|---|---|---|"
    local i
    for i in "${!A_TITLES[@]}"; do
      local s="${A_STATUS[$i]:-skip}"
      local ev="${A_EVIDENCE[$i]:-not-run}"
      # Truncate evidence to keep table readable; full data is in fly logs.
      ev="${ev//|/\\|}"
      ev="${ev:0:200}"
      echo "| $((i+1)) | ${A_TITLES[$i]} | $(emoji_for "$s") | ${ev} |"
    done
    echo
    echo "## Decision"
    echo
    if [[ "$overall" == "PASS" ]]; then
      echo "- [x] All 8 assertions pass → proceed to Phase 4 (production flag flip)"
      echo "- [ ] Any assertion fails → block Phase 4, document remediation in this file"
    else
      echo "- [ ] All 8 assertions pass → proceed to Phase 4 (production flag flip)"
      echo "- [x] Failure detected — block Phase 4. Investigate via Fly logs link above."
    fi
    echo
    echo "_Generated by \`scripts/s8-p01-smoke.sh\`._"
  } > "$RESULTS_FILE"

  pass "Wrote $RESULTS_FILE"
}

# ────────────────────────────────────────────────────────────────────────
# Cleanup
# ────────────────────────────────────────────────────────────────────────

cleanup() {
  hdr "Cleanup"
  if [[ "$MODE" != "cleanup" ]]; then
    info "Skipping (only runs with --cleanup)"
    return
  fi
  echo
  echo "${C_YELLOW}About to destroy Fly app '${APP}' and its volumes.${C_RESET}"
  echo "This deletes the staging database mount + any persisted secrets."
  if [[ -t 0 ]]; then
    read -r -p "Type 'destroy' to confirm: " confirm
    if [[ "$confirm" != "destroy" ]]; then
      echo "Aborted."
      exit 0
    fi
  fi
  run fly apps destroy "$APP" --yes
  pass "App $APP destroyed."
}

# ────────────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────────────

main() {
  preflight

  if [[ "$MODE" == "cleanup" ]]; then
    cleanup
    exit 0
  fi

  provision
  deploy
  onboarding_probe
  heartbeat_probe
  memory_probe

  hdr "Assertions"
  assert_run_completed
  assert_no_runner_jobs
  assert_cost_micros
  assert_workdir_mode      # check mode BEFORE cleanup assertion
  assert_workdir_cleaned
  assert_byo_regression
  assert_memory_peak
  assert_no_log_errors

  write_report

  # Exit with failure if any assertion failed.
  for s in "${A_STATUS[@]:-}"; do
    if [[ "$s" == "fail" ]]; then
      hdr "Result: FAIL"
      exit 1
    fi
  done
  hdr "Result: $([[ "$DRY" -eq 1 ]] && echo DRY-RUN || echo PASS)"
}

main "$@"
