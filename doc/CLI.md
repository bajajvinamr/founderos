# CLI Reference

FounderOS CLI now supports both:

- instance setup/diagnostics (`onboard`, `doctor`, `configure`, `env`, `allowed-hostname`)
- control-plane client operations (issues, approvals, agents, activity, dashboard)

## Base Usage

Use repo script in development:

```sh
pnpm founderos --help
```

First-time local bootstrap + run:

```sh
pnpm founderos run
```

Choose local instance:

```sh
pnpm founderos run --instance dev
```

## Deployment Modes

Mode taxonomy and design intent are documented in `doc/DEPLOYMENT-MODES.md`.

Current CLI behavior:

- `founderos onboard` and `founderos configure --section server` set deployment mode in config
- server onboarding/configure ask for reachability intent and write `server.bind`
- `founderos run --bind <loopback|lan|tailnet>` passes a quickstart bind preset into first-run onboarding when config is missing
- runtime can override mode with `FOUNDEROS_DEPLOYMENT_MODE`
- `founderos run` and `founderos doctor` still do not expose a direct low-level `--mode` flag

Canonical behavior is documented in `doc/DEPLOYMENT-MODES.md`.

Allow an authenticated/private hostname (for example custom Tailscale DNS):

```sh
pnpm founderos allowed-hostname dotta-macbook-pro
```

All client commands support:

- `--data-dir <path>`
- `--api-base <url>`
- `--api-key <token>`
- `--context <path>`
- `--profile <name>`
- `--json`

Company-scoped commands also support `--company-id <id>`.

Use `--data-dir` on any CLI command to isolate all default local state (config/context/db/logs/storage/secrets) away from `~/.founderos`:

```sh
pnpm founderos run --data-dir ./tmp/founderos-dev
pnpm founderos issue list --data-dir ./tmp/founderos-dev
```

## Context Profiles

Store local defaults in `~/.founderos/context.json`:

```sh
pnpm founderos context set --api-base http://localhost:3100 --company-id <company-id>
pnpm founderos context show
pnpm founderos context list
pnpm founderos context use default
```

To avoid storing secrets in context, set `apiKeyEnvVarName` and keep the key in env:

```sh
pnpm founderos context set --api-key-env-var-name FOUNDEROS_API_KEY
export FOUNDEROS_API_KEY=...
```

## Company Commands

```sh
pnpm founderos company list
pnpm founderos company get <company-id>
pnpm founderos company delete <company-id-or-prefix> --yes --confirm <same-id-or-prefix>
```

Examples:

```sh
pnpm founderos company delete PAP --yes --confirm PAP
pnpm founderos company delete 5cbe79ee-acb3-4597-896e-7662742593cd --yes --confirm 5cbe79ee-acb3-4597-896e-7662742593cd
```

Notes:

- Deletion is server-gated by `FOUNDEROS_ENABLE_COMPANY_DELETION`.
- With agent authentication, company deletion is company-scoped. Use the current company ID/prefix (for example via `--company-id` or `FOUNDEROS_COMPANY_ID`), not another company.

## Issue Commands

```sh
pnpm founderos issue list --company-id <company-id> [--status todo,in_progress] [--assignee-agent-id <agent-id>] [--match text]
pnpm founderos issue get <issue-id-or-identifier>
pnpm founderos issue create --company-id <company-id> --title "..." [--description "..."] [--status todo] [--priority high]
pnpm founderos issue update <issue-id> [--status in_progress] [--comment "..."]
pnpm founderos issue comment <issue-id> --body "..." [--reopen]
pnpm founderos issue checkout <issue-id> --agent-id <agent-id> [--expected-statuses todo,backlog,blocked]
pnpm founderos issue release <issue-id>
```

## Agent Commands

```sh
pnpm founderos agent list --company-id <company-id>
pnpm founderos agent get <agent-id>
pnpm founderos agent local-cli <agent-id-or-shortname> --company-id <company-id>
```

`agent local-cli` is the quickest way to run local Claude/Codex manually as a FounderOS agent:

- creates a new long-lived agent API key
- installs missing FounderOS skills into `~/.codex/skills` and `~/.claude/skills`
- prints `export ...` lines for `FOUNDEROS_API_URL`, `FOUNDEROS_COMPANY_ID`, `FOUNDEROS_AGENT_ID`, and `FOUNDEROS_API_KEY`

Example for shortname-based local setup:

```sh
pnpm founderos agent local-cli codexcoder --company-id <company-id>
pnpm founderos agent local-cli claudecoder --company-id <company-id>
```

## Approval Commands

```sh
pnpm founderos approval list --company-id <company-id> [--status pending]
pnpm founderos approval get <approval-id>
pnpm founderos approval create --company-id <company-id> --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]
pnpm founderos approval approve <approval-id> [--decision-note "..."]
pnpm founderos approval reject <approval-id> [--decision-note "..."]
pnpm founderos approval request-revision <approval-id> [--decision-note "..."]
pnpm founderos approval resubmit <approval-id> [--payload '{"...":"..."}']
pnpm founderos approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm founderos activity list --company-id <company-id> [--agent-id <agent-id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard Commands

```sh
pnpm founderos dashboard get --company-id <company-id>
```

## Heartbeat Command

`heartbeat run` now also supports context/api-key options and uses the shared client stack:

```sh
pnpm founderos heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100] [--api-key <token>]
```

## Local Storage Defaults

Default local instance root is `~/.founderos/instances/default`:

- config: `~/.founderos/instances/default/config.json`
- embedded db: `~/.founderos/instances/default/db`
- logs: `~/.founderos/instances/default/logs`
- storage: `~/.founderos/instances/default/data/storage`
- secrets key: `~/.founderos/instances/default/secrets/master.key`

Override base home or instance with env vars:

```sh
FOUNDEROS_HOME=/custom/home FOUNDEROS_INSTANCE_ID=dev pnpm founderos run
```

## Storage Configuration

Configure storage provider and settings:

```sh
pnpm founderos configure --section storage
```

Supported providers:

- `local_disk` (default; local single-user installs)
- `s3` (S3-compatible object storage)
