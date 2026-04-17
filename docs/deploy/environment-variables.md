---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that FounderOS uses for server configuration.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `FOUNDEROS_BIND` | `loopback` | Reachability preset: `loopback`, `lan`, `tailnet`, or `custom` |
| `FOUNDEROS_BIND_HOST` | (unset) | Required when `FOUNDEROS_BIND=custom` |
| `HOST` | `127.0.0.1` | Legacy host override; prefer `FOUNDEROS_BIND` for new setups |
| `DATABASE_URL` | (embedded) | PostgreSQL connection string |
| `FOUNDEROS_HOME` | `~/.founderos` | Base directory for all FounderOS data |
| `FOUNDEROS_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `FOUNDEROS_DEPLOYMENT_MODE` | `local_trusted` | Runtime mode override |
| `FOUNDEROS_DEPLOYMENT_EXPOSURE` | `private` | Exposure policy when deployment mode is `authenticated` |

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `FOUNDEROS_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw) |
| `FOUNDEROS_SECRETS_MASTER_KEY_FILE` | `~/.founderos/.../secrets/master.key` | Path to key file |
| `FOUNDEROS_SECRETS_STRICT_MODE` | `false` | Require secret refs for sensitive env vars |

## Agent Runtime (Injected into agent processes)

These are set automatically by the server when invoking agents:

| Variable | Description |
|----------|-------------|
| `FOUNDEROS_AGENT_ID` | Agent's unique ID |
| `FOUNDEROS_COMPANY_ID` | Company ID |
| `FOUNDEROS_API_URL` | FounderOS API base URL |
| `FOUNDEROS_API_KEY` | Short-lived JWT for API auth |
| `FOUNDEROS_RUN_ID` | Current heartbeat run ID |
| `FOUNDEROS_TASK_ID` | Issue that triggered this wake |
| `FOUNDEROS_WAKE_REASON` | Wake trigger reason |
| `FOUNDEROS_WAKE_COMMENT_ID` | Comment that triggered this wake |
| `FOUNDEROS_APPROVAL_ID` | Resolved approval ID |
| `FOUNDEROS_APPROVAL_STATUS` | Approval decision |
| `FOUNDEROS_LINKED_ISSUE_IDS` | Comma-separated linked issue IDs |

## LLM Provider Keys (for adapters)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude Local adapter) |
| `OPENAI_API_KEY` | OpenAI API key (for Codex Local adapter) |
