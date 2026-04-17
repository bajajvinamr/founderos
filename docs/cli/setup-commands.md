---
title: Setup Commands
summary: Onboard, run, doctor, and configure
---

Instance setup and diagnostics commands.

## `founderos run`

One-command bootstrap and start:

```sh
pnpm founderos run
```

Does:

1. Auto-onboards if config is missing
2. Runs `founderos doctor` with repair enabled
3. Starts the server when checks pass

Choose a specific instance:

```sh
pnpm founderos run --instance dev
```

## `founderos onboard`

Interactive first-time setup:

```sh
pnpm founderos onboard
```

If FounderOS is already configured, rerunning `onboard` keeps the existing config in place. Use `founderos configure` to change settings on an existing install.

First prompt:

1. `Quickstart` (recommended): local defaults (embedded database, no LLM provider, local disk storage, default secrets)
2. `Advanced setup`: full interactive configuration

Start immediately after onboarding:

```sh
pnpm founderos onboard --run
```

Non-interactive defaults + immediate start (opens browser on server listen):

```sh
pnpm founderos onboard --yes
```

On an existing install, `--yes` now preserves the current config and just starts FounderOS with that setup.

## `founderos doctor`

Health checks with optional auto-repair:

```sh
pnpm founderos doctor
pnpm founderos doctor --repair
```

Validates:

- Server configuration
- Database connectivity
- Secrets adapter configuration
- Storage configuration
- Missing key files

## `founderos configure`

Update configuration sections:

```sh
pnpm founderos configure --section server
pnpm founderos configure --section secrets
pnpm founderos configure --section storage
```

## `founderos env`

Show resolved environment configuration:

```sh
pnpm founderos env
```

This now includes bind-oriented deployment settings such as `FOUNDEROS_BIND` and `FOUNDEROS_BIND_HOST` when configured.

## `founderos allowed-hostname`

Allow a private hostname for authenticated/private mode:

```sh
pnpm founderos allowed-hostname my-tailscale-host
```

## Local Storage Paths

| Data | Default Path |
|------|-------------|
| Config | `~/.founderos/instances/default/config.json` |
| Database | `~/.founderos/instances/default/db` |
| Logs | `~/.founderos/instances/default/logs` |
| Storage | `~/.founderos/instances/default/data/storage` |
| Secrets key | `~/.founderos/instances/default/secrets/master.key` |

Override with:

```sh
FOUNDEROS_HOME=/custom/home FOUNDEROS_INSTANCE_ID=dev pnpm founderos run
```

Or pass `--data-dir` directly on any command:

```sh
pnpm founderos run --data-dir ./tmp/founderos-dev
pnpm founderos doctor --data-dir ./tmp/founderos-dev
```
