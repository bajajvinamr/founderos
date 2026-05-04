# @founderos/runner

Local execution runner for [FounderOS](https://founderos.fly.dev). Polls the FounderOS cloud for queued AI-agent jobs, spawns the `claude` CLI under your existing Claude Pro subscription, streams events back, and reports completion.

> **Why this exists.** FounderOS runs as a hosted control plane, but the actual LLM execution happens on _your_ machine — under _your_ authed CLI session and _your_ subscription billing. The cloud never sees your Anthropic API keys; it just enqueues work and reads back the events. See [ADR-011](https://github.com/founderos-ai/founderos/blob/main/docs/adr/011-byo-runner.md) for the full rationale.

## Install

```bash
npm install -g @founderos/runner
```

You also need:

- **Node.js ≥ 20**
- **`claude` CLI** installed and authenticated (`claude --version` should work in your shell)

## Configure

The runner reads everything from environment variables:

| Var | Required | Default | Notes |
|---|---|---|---|
| `FOUNDEROS_RUNNER_URL` | yes | — | Cloud base URL, e.g. `https://founderos.fly.dev` |
| `FOUNDEROS_RUNNER_TOKEN` | yes | — | Bearer token (`fos_<32 chars>`) issued from the FounderOS dashboard |
| `FOUNDEROS_CLAUDE_BIN` | no | `claude` | Override if `claude` isn't on `PATH` |
| `FOUNDEROS_RUNNER_TIMEOUT_SEC` | no | `600` | Per-job hard ceiling |
| `FOUNDEROS_RUNNER_LOG_LEVEL` | no | `info` | `debug \| info \| warn \| error` |

Issue a token from the FounderOS dashboard → Settings → Runner Tokens. The plaintext is shown **once** at issuance — store it in a secret manager or password vault.

## Run

```bash
export FOUNDEROS_RUNNER_URL=https://founderos.fly.dev
export FOUNDEROS_RUNNER_TOKEN=fos_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
founderos-runner start
```

Output:

```
[info ] founderos-runner v0.1.0 starting {"serverUrl":"https://founderos.fly.dev","claudeBin":"claude"}
[info ] got job {"jobId":"...","agent":"Sarah"}
[info ] job completed {"jobId":"...","status":"completed","exitCode":0}
```

The process loops until you `^C` it; SIGINT/SIGTERM finishes the current job before exiting.

## Run as a service (macOS)

```bash
# ~/Library/LaunchAgents/dev.founderos.runner.plist
cat > ~/Library/LaunchAgents/dev.founderos.runner.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.founderos.runner</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/founderos-runner</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>FOUNDEROS_RUNNER_URL</key><string>https://founderos.fly.dev</string>
    <key>FOUNDEROS_RUNNER_TOKEN</key><string>fos_...</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
EOF
launchctl load ~/Library/LaunchAgents/dev.founderos.runner.plist
```

## Run as a service (Linux, systemd)

```ini
# /etc/systemd/system/founderos-runner.service
[Unit]
Description=FounderOS local runner
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/founderos-runner start
Restart=always
Environment="FOUNDEROS_RUNNER_URL=https://founderos.fly.dev"
Environment="FOUNDEROS_RUNNER_TOKEN=fos_..."
User=YOUR_USER

[Install]
WantedBy=default.target
```

## What does the runner do, exactly?

1. **Long-poll** `GET /api/runner/jobs/next` (≤ 30 s) for queued work.
2. **Atomic claim** `POST /api/runner/jobs/:id/claim` — the cloud transitions the job from `queued` → `claimed` in a single SQL `UPDATE…WHERE status='queued'`. Multiple runners polling the same token race; the lowest-latency one wins.
3. **Spawn** `claude --print --output-format stream-json --verbose` with the prompt on stdin. If the cloud passed `--resume sessionId`, it threads through.
4. **Stream events** — every line of stream-json (assistant messages, tool uses, tool results, the final result) is parsed and POSTed in 50 ms / 32-event batches to `POST /api/runner/jobs/:id/events`.
5. **Complete** — when claude exits, post the exit code, total cost (parsed from the `result` event), `sessionId` (for `--resume` next time), and CLI version to `POST /api/runner/jobs/:id/complete`.

## Security

- Token is hashed at rest server-side (sha256). Constant-time compare on every request.
- Tokens scope to a single company. A token issued for company A cannot read jobs for company B.
- Plaintext tokens are never logged. Audit-log entries store an 8-char preview only.
- Revoke from the dashboard whenever a machine is decommissioned; revoked tokens get a 401 on the next request.

See the [runner threat model](https://github.com/founderos-ai/founderos/blob/main/docs/security/runner-threat-model.md).

## Local development

```bash
pnpm install
pnpm --filter @founderos/runner test     # unit tests, no live spawn
pnpm --filter @founderos/runner build    # tsc → dist/
```

## License

MIT
