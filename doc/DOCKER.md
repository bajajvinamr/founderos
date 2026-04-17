# Docker Quickstart

Run FounderOS in Docker without installing Node or pnpm locally.

All commands below assume you are in the **project root** (the directory containing `package.json`), not inside `docker/`.

## Building the image

```sh
docker build -t founderos-local .
```

The Dockerfile installs common agent tools (`git`, `gh`, `curl`, `wget`, `ripgrep`, `python3`) and the Claude, Codex, and OpenCode CLIs.

Build arguments:

| Arg | Default | Purpose |
|-----|---------|---------|
| `USER_UID` | `1000` | UID for the container `node` user (match your host UID to avoid permission issues on bind mounts) |
| `USER_GID` | `1000` | GID for the container `node` group |

```sh
docker build -t founderos-local \
  --build-arg USER_UID=$(id -u) --build-arg USER_GID=$(id -g) .
```

## One-liner (build + run)

```sh
docker build -t founderos-local . && \
docker run --name founderos \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e FOUNDEROS_HOME=/founderos \
  -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  -v "$(pwd)/data/docker-founderos:/founderos" \
  founderos-local
```

Open: `http://localhost:3100`

Data persistence:

- Embedded PostgreSQL data
- uploaded assets
- local secrets key
- local agent workspace data

All persisted under your bind mount (`./data/docker-founderos` in the example above).

## Docker Compose

### Quickstart (embedded SQLite)

Single container, no external database. Data persists via a bind mount.

```sh
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  docker compose -f docker/docker-compose.quickstart.yml up --build
```

Defaults:

- host port: `3100`
- persistent data dir: `./data/docker-founderos`

Optional overrides:

```sh
FOUNDEROS_PORT=3200 FOUNDEROS_DATA_DIR=../data/pc \
  docker compose -f docker/docker-compose.quickstart.yml up --build
```

**Note:** `FOUNDEROS_DATA_DIR` is resolved relative to the compose file (`docker/`), so `../data/pc` maps to `data/pc` in the project root.

If you change host port or use a non-local domain, set `FOUNDEROS_PUBLIC_URL` to the external URL you will use in browser/auth flows.

Pass `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` to enable local adapter runs.

### Full stack (with PostgreSQL)

FounderOS server + PostgreSQL 17. The database is health-checked before the server starts.

```sh
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  docker compose -f docker/docker-compose.yml up --build
```

PostgreSQL data persists in a named Docker volume (`pgdata`). FounderOS data persists in `founderos-data`.

### Untrusted PR review

Isolated container for reviewing untrusted pull requests with Codex or Claude, without exposing your host machine. See `doc/UNTRUSTED-PR-REVIEW.md` for the full workflow.

```sh
docker compose -f docker/docker-compose.untrusted-review.yml build
docker compose -f docker/docker-compose.untrusted-review.yml run --rm --service-ports review
```

## Authenticated Compose (Single Public URL)

For authenticated deployments, set one canonical public URL and let FounderOS derive auth/callback defaults:

```yaml
services:
  founderos:
    environment:
      FOUNDEROS_DEPLOYMENT_MODE: authenticated
      FOUNDEROS_DEPLOYMENT_EXPOSURE: private
      FOUNDEROS_PUBLIC_URL: https://desk.koker.net
```

`FOUNDEROS_PUBLIC_URL` is used as the primary source for:

- auth public base URL
- Better Auth base URL defaults
- bootstrap invite URL defaults
- hostname allowlist defaults (hostname extracted from URL)

Granular overrides remain available if needed (`FOUNDEROS_AUTH_PUBLIC_BASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`, `FOUNDEROS_ALLOWED_HOSTNAMES`).

Set `FOUNDEROS_ALLOWED_HOSTNAMES` explicitly only when you need additional hostnames beyond the public URL host (for example Tailscale/LAN aliases or multiple private hostnames).

## Claude + Codex Local Adapters in Docker

The image pre-installs:

- `claude` (Anthropic Claude Code CLI)
- `codex` (OpenAI Codex CLI)

If you want local adapter runs inside the container, pass API keys when starting the container:

```sh
docker run --name founderos \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e FOUNDEROS_HOME=/founderos \
  -e OPENAI_API_KEY=... \
  -e ANTHROPIC_API_KEY=... \
  -v "$(pwd)/data/docker-founderos:/founderos" \
  founderos-local
```

Notes:

- Without API keys, the app still runs normally.
- Adapter environment checks in FounderOS will surface missing auth/CLI prerequisites.

## Podman Quadlet (systemd)

The `docker/quadlet/` directory contains unit files to run FounderOS + PostgreSQL as systemd services via Podman Quadlet.

| File | Purpose |
|------|---------|
| `docker/quadlet/founderos.pod` | Pod definition — groups containers into a shared network namespace |
| `docker/quadlet/founderos.container` | FounderOS server — joins the pod, connects to Postgres at `127.0.0.1` |
| `docker/quadlet/founderos-db.container` | PostgreSQL 17 — joins the pod, health-checked |

### Setup

1. Build the image (see above).

2. Copy quadlet files to your systemd directory:

   ```sh
   # Rootless (recommended)
   cp docker/quadlet/*.pod docker/quadlet/*.container \
     ~/.config/containers/systemd/

   # Or rootful
   sudo cp docker/quadlet/*.pod docker/quadlet/*.container \
     /etc/containers/systemd/
   ```

3. Create a secrets env file (keep out of version control):

   ```sh
   cat > ~/.config/containers/systemd/founderos.env <<EOL
   BETTER_AUTH_SECRET=$(openssl rand -hex 32)
   POSTGRES_USER=founderos
   POSTGRES_PASSWORD=founderos
   POSTGRES_DB=founderos
   DATABASE_URL=postgres://founderos:founderos@127.0.0.1:5432/founderos
   # OPENAI_API_KEY=sk-...
   # ANTHROPIC_API_KEY=sk-...
   EOL
   ```

4. Create the data directory and start:

   ```sh
   mkdir -p ~/.local/share/founderos
   systemctl --user daemon-reload
   systemctl --user start founderos-pod
   ```

### Quadlet management

```sh
journalctl --user -u founderos -f        # App logs
journalctl --user -u founderos-db -f     # DB logs
systemctl --user status founderos-pod    # Pod status
systemctl --user restart founderos-pod   # Restart all
systemctl --user stop founderos-pod      # Stop all
```

### Quadlet notes

- **First boot**: Unlike Docker Compose's `condition: service_healthy`, Quadlet's `After=` only waits for the DB unit to *start*, not for PostgreSQL to be ready. On a cold first boot you may see one or two restart attempts in `journalctl --user -u founderos` while PostgreSQL initialises — this is expected and resolves automatically via `Restart=on-failure`.
- Containers in a pod share `localhost`, so FounderOS reaches Postgres at `127.0.0.1:5432`.
- PostgreSQL data persists in the `founderos-pgdata` named volume.
- FounderOS data persists at `~/.local/share/founderos`.
- For rootful quadlet deployment, remove `%h` prefixes and use absolute paths.

## Onboard Smoke Test (Ubuntu + npm only)

Use this when you want to mimic a fresh machine that only has Ubuntu + npm and verify:

- `npx founderos onboard --yes` completes
- the server binds to `0.0.0.0:3100` so host access works
- onboard/run banners and startup logs are visible in your terminal

Build + run:

```sh
./scripts/docker-onboard-smoke.sh
```

Open: `http://localhost:3131` (default smoke host port)

Useful overrides:

```sh
HOST_PORT=3200 FOUNDEROSAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
FOUNDEROS_DEPLOYMENT_MODE=authenticated FOUNDEROS_DEPLOYMENT_EXPOSURE=private ./scripts/docker-onboard-smoke.sh
SMOKE_DETACH=true SMOKE_METADATA_FILE=/tmp/founderos-smoke.env FOUNDEROSAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
```

Notes:

- Persistent data is mounted at `./data/docker-onboard-smoke` by default.
- Container runtime user id defaults to your local `id -u` so the mounted data dir stays writable while avoiding root runtime.
- Smoke script defaults to `authenticated/private` mode so `HOST=0.0.0.0` can be exposed to the host.
- Smoke script defaults host port to `3131` to avoid conflicts with local FounderOS on `3100`.
- Smoke script also defaults `FOUNDEROS_PUBLIC_URL` to `http://localhost:<HOST_PORT>` so bootstrap invite URLs and auth callbacks use the reachable host port instead of the container's internal `3100`.
- In authenticated mode, the smoke script defaults `SMOKE_AUTO_BOOTSTRAP=true` and drives the real bootstrap path automatically: it signs up a real user, runs `founderos auth bootstrap-ceo` inside the container to mint a real bootstrap invite, accepts that invite over HTTP, and verifies board session access.
- Run the script in the foreground to watch the onboarding flow; stop with `Ctrl+C` after validation.
- Set `SMOKE_DETACH=true` to leave the container running for automation and optionally write shell-ready metadata to `SMOKE_METADATA_FILE`.
- The image definition is in `docker/Dockerfile.onboard-smoke`.

## General Notes

- The `docker-entrypoint.sh` adjusts the container `node` user UID/GID at startup to match the values passed via `USER_UID`/`USER_GID`, avoiding permission issues on bind-mounted volumes.
- FounderOS data persists via Docker volumes/bind mounts (compose) or at `~/.local/share/founderos` (quadlet).
