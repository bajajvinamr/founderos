# BYO Runner Smoke Test (manual)

End-to-end verification of the BYO Runner loop: founder issues a token in
the UI → installs `@founderos/runner` locally → runner polls the cloud
control plane → an enqueued job is claimed, executed via the local
`claude` CLI, and the events stream back to the UI.

Run this after any change that touches:

- `server/src/routes/runner.ts` (job + token endpoints)
- `server/src/middleware/runner-auth.ts` (token verification)
- `server/src/services/adapter-resolver.ts` (byo_runner family routing)
- `packages/runner/**` (the runner package itself)
- `ui/src/components/RunnerInstallDialog.tsx` / `RunnerStatusPill.tsx`
- the `runner_tokens` / `runner_jobs` tables

## Why this is manual, not CI

The runner spawns a real `claude --print --output-format stream-json` process,
which requires the founder's authenticated Anthropic CLI subscription on the
host machine. GitHub-hosted runners don't have a logged-in `claude` CLI, and
provisioning one per CI run is operationally infeasible. The unit tests in
`packages/runner/src/__tests__/` cover everything below the CLI boundary;
this smoke covers the boundary itself.

A 10-minute manual smoke after BYO-runner changes is the right trade-off.

## Prerequisites

1. **Anthropic Claude CLI installed and authenticated:**
   ```bash
   claude --version
   echo "test" | claude --print
   ```
   The second command should print a real model response. If it prompts for
   login, run `claude /login` first.

2. **Logged-in Founder OS account** with at least one company.

3. **`FOUNDEROS_BYO_RUNNER_ENABLED=1`** set on the target deploy
   (or run locally with the flag in `.env.local`).

4. **Tail the cloud logs:**
   ```bash
   fly logs -a founderos | grep -E "runner|byo"
   ```

## The smoke

### 1. Issue a runner token

1. Open the Agents page on the target deploy.
2. The **status pill** should be visible only if at least one agent on the
   selected company already has `adapterType = byo_runner`.
   - If not present, create a new agent with `claude_local` adapter — the
     onboarding bootstrap rewrites it to `byo_runner` when the flag is on.
   - Refresh; pill should appear with **rose dot + "Install runner"**.
3. Click the pill → install dialog opens.
4. Enter a label like `smoke-$(hostname)`, click **Issue new token**.
5. The amber banner should appear with:
   - A `fos_<32 alnum>` token.
   - An install snippet that includes the API origin matching the deploy.
   - A working **Copy** button (toast confirms).

### 2. Install and start the runner

```bash
# Install once
npm install -g @founderos/runner

# Start with the credentials from the dialog (paste the snippet)
export FOUNDEROS_RUNNER_TOKEN="fos_..."
export FOUNDEROS_API_URL="https://founderos.fly.dev"   # or local host
founderos-runner start
```

Expected stdout:
```
[runner] starting v0.1.0
[runner] connected to https://founderos.fly.dev
[runner] waiting for jobs...
```

If you see `error: invalid token (401)` → the token regex failed; verify
the env var has no quotes and starts with `fos_`. Exit code 2 is expected
on auth failure.

### 3. Verify liveness

Within 10s of the runner starting, the **Agents page pill** should flip to
**emerald dot + "Runner online"**. Refresh if it doesn't update — the
useQuery refetches on a 10s interval.

In the dialog token list, the row for the new token should show **Online**
with a `Last seen Xs ago` timestamp.

### 4. Trigger a job through a byo_runner agent

Pick or create an issue assigned to the byo_runner agent and run it
through the existing run-issue flow. Watch:

| Where | What to look for |
|---|---|
| `fly logs` tail | `[runner-auth] token=...` then `[runner] job claimed: <jobId>` |
| Local runner stdout | `[runner] claimed job <jobId>` then `[claude] stream event: ...` |
| UI run viewer | events arrive incrementally (not in one batch) — proves the events endpoint is being hit during the run, not on completion |
| `fly logs` again | `[runner] job complete: <jobId> exit=0` |

### 5. Revoke the token

1. Open the install dialog again.
2. Click the trash icon next to the token row.
3. Confirm the toast: `Token revoked`.
4. Within ~10s, the runner stdout should print `error: token revoked (401)`
   and the process should exit with code 2.
5. The pill should flip to **rose dot + "Install runner"**.

### 6. Cleanup

```bash
# Stop the runner (Ctrl+C if still running)
# Remove the global package if you don't want it left installed
npm uninstall -g @founderos/runner
```

## What to look for in `fly logs`

| Signal | Meaning |
|---|---|
| `runner-auth] reject: token-not-found` | DB lookup miss — token never issued or revoked |
| `runner-auth] reject: token-revoked` | Revocation took effect |
| `runner] long-poll timeout` | Healthy idle — runner waited the full 25s, nothing to do |
| `runner] job claim conflict` | Another runner instance won the race — expected with multiple runners |
| `runner] complete with non-zero exit` | The local `claude` CLI exited non-zero — usually auth or model rate limit on the founder's subscription |

## Known soft-failures (don't block ship)

- **First poll delay**: the runner sleeps up to 1s before the first request
  to stagger reconnects. Pill may stay rose for one cycle.
- **Clipboard API in Safari ITP**: the **Copy** button silently no-ops
  if the page isn't user-activated. The plaintext is still selectable —
  fall back to manual select-all.

## On failure

1. Capture the runner stdout (with `RUNNER_LOG_LEVEL=debug` if needed).
2. Capture the matching `fly logs` window (filter by `requestId` from the
   401 response body).
3. File against `BYO-` ticket prefix; attach both logs and the exact
   sequence of UI clicks. The ALS-propagated `requestId` ties UI → BE →
   runner-side log lines.

## Regression checkpoint after S8 P0.1

S8 P0.1 introduces server-side hosted execution (`claude_local` adapter
spawning on Fly) alongside the existing `byo_runner` laptop-runner path.
The hosted rollout is gated by `FOUNDEROS_HOSTED_AGENTS_ENABLED`; existing
customers who onboarded before the flag flipped stay on `byo_runner`
indefinitely. **The byo_runner code path MUST keep working through the
rollout** — paying customers using the laptop runner today must not see
any behavior change.

This checkpoint runs after every PR that touches the runner surface and
before each `release/s8-p01-*` branch is cut.

### Automated regression net

Four canonical baseline tests live in
`server/src/__tests__/byo-runner-baseline.test.ts`. They run in CI on every
commit and lock in the four scenarios that must not regress:

| # | Scenario | What it pins |
|---|---|---|
| 1 | Issuing a runner token works | POST `/api/companies/:id/runner-tokens` returns `fos_<32 alnum>`; only sha256 hash persisted |
| 2 | `runner_jobs` row written for byo_runner heartbeat | Adapter materializes row with `adapter_type='byo_runner'`, queued status, prompt + runtimeConfig |
| 3 | Laptop runner can claim and complete a job | `/jobs/:id/claim` flips queued → claimed; `/jobs/:id/complete` flips claimed → completed |
| 4 | `runner_tokens.lastSeenAt` updates on every claim | Real `runnerAuthMiddleware` writes lastSeenAt; UI liveness pill depends on this |

Run locally:

```bash
npx vitest --run server/src/__tests__/byo-runner-baseline.test.ts
```

Detailed coverage of the same surface lives in:
- `runner-auth.test.ts` (BYO-101 — token validation, expiry, debounce)
- `runner-routes.test.ts` (BYO-104 — full REST contract for all 7 endpoints)
- `byo-runner-adapter.test.ts` (BYO-103 — adapter polling state machine)

If any baseline scenario fails, **investigate before merging** — these are
the load-bearing happy paths. Do not skip or weaken assertions to get
green CI; fix the regression in the changed code.

### Manual smoke checklist (pre-merge feature-branch deploy)

Run this before merging any PR that lands on a `feat/s8-p01-*` branch
which touches runner code, after the feature-branch's preview deploy is
healthy:

- [ ] **Issue token** — open the Agents page on the preview deploy with
      `FOUNDEROS_BYO_RUNNER_ENABLED=1`. Click the runner pill. The Issue
      dialog shows a `fos_<32 alnum>` token exactly once. `Copy` works.
- [ ] **Install runner locally** — `npm install -g @founderos/runner` (or
      use the version from the PR if the runner package itself changed).
      Export `FOUNDEROS_RUNNER_TOKEN=fos_...` and `FOUNDEROS_API_URL=<preview-host>`.
      Start `founderos-runner start` and confirm the stdout shows
      `connected to <preview-host>` and `waiting for jobs...`.
- [ ] **Trigger heartbeat** — kick a heartbeat for a `byo_runner` agent
      (e.g. assign an issue, click "Run Now", or fire the dev kick command).
      Within ~10s the runner stdout should show `[runner] claimed job <jobId>`
      followed by `[claude] stream event: ...` lines as the local CLI runs.
- [ ] **Confirm CLI execution** — verify the job reaches a terminal state
      visible in the run viewer (not stuck in `claimed` or `streaming`).
      Exit code 0 = clean run; non-zero = re-check Anthropic CLI auth on
      the host.
- [ ] **Confirm liveness pill** — within 30s of the runner's first poll,
      the Agents-page status pill flips from rose → emerald with
      "Runner online".
- [ ] **Revoke token** — click the trash icon. Within 30s the runner
      stdout prints `error: token revoked (401)` and exits with code 2.
      Pill flips back to rose.

### Sign-off

Once both gates are green (automated baseline + manual smoke):

```
S8 P0.1 byo_runner regression checkpoint:
- baseline tests:   PASS / FAIL
- manual smoke:     PASS / FAIL
- engineer:         <name>
- preview deploy:   <fly-app-name>
- date:             <YYYY-MM-DD>
```

Drop this block in the PR body before requesting final review. The
manual smoke is required for any PR that touches `runner-auth.ts`,
`runner.ts` (routes), `adapter-resolver.ts`, or `packages/runner/**`;
PRs that only touch tests or unrelated code can rely on the automated
baseline alone.

