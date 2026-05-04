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
