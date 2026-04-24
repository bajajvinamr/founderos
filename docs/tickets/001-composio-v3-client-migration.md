# Ticket 001 — Composio v3 client migration — SHIPPED 2026-04-24

**Milestone:** M1 · **Owner:** Claude · **Created:** 2026-04-23 · **Shipped:** 2026-04-24

## Resolution

Migrated `server/src/services/composio-client.ts` to v3. `executeTool`, `initiateConnection`, and `getConnection` now hit `/api/v3/tools/execute/{slug}`, `/api/v3/connected_accounts`, and `/api/v3/connected_accounts/{id}` respectively.

Shipped fetch-wrapper path (approach 2 in the ADR). No SDK dependency, no transitive `openai`/`pusher-js`. Shapes confirmed against `@composio/client@0.1.0-alpha.66` generated resources before writing — authoritative because the Composio SDK generates its client from the same OpenAPI spec the backend serves.

**Architectural shift:** v3 requires a pre-created `auth_config.id` per toolkit. Resolved per-app from `COMPOSIO_AUTH_CONFIG_<APPNAME>` (e.g. `COMPOSIO_AUTH_CONFIG_SLACK`) — admin creates the config once in the Composio dashboard, drops the id into the Fly secret, and `initiateConnection({userId, appName})` works unchanged for callers. Fails loud with a setup-instructive error when missing.

**Caller contract unchanged.** `initiateConnection({userId, appName})` still accepts the same shape; `authConfigId` is optional.

Tests: 13 passing (was 8). New coverage for v3 body shape, explicit connected_account_id override, missing auth_config setup error, env-resolved auth config id, and v3 path of `getConnection`.

Deep health check (`composio_ping`) was already on v3 — unchanged.

## Problem

`server/src/services/composio-client.ts` wraps fetch at `https://backend.composio.dev/api/v1/*`. Composio deprecated all v1 endpoints — every path now returns HTTP 410 with `"This endpoint is no longer available. Please upgrade to v3 APIs."`

Three methods affected:
- `executeTool()` — hits `POST /actions/{toolName}/execute`
- `initiateConnection()` — hits `POST /connectedAccounts/initiate`
- `getConnection()` — hits `GET /connectedAccounts/{id}`

The health check was already migrated to v3 (`/api/v3/toolkits?limit=1`) in commit `7e9438e`. Tool execution is not.

## Success

- `composio.executeTool({ toolName: 'slack_send_message', params: { channel: '#test', text: 'hello' } })` returns `{ ok: true, output: {...} }` against a real Slack-connected test account on staging.
- `initiateConnection()` returns a valid v3 `connectionId` + `redirectUrl`, and completing the OAuth flow results in `getConnection().status === 'active'`.
- `server/src/__tests__/composio-client.test.ts` (4 test files) pass with shapes matching v3 responses.
- `isComposioEnabled()` behavior unchanged — still a single env-var gate.

## Out of scope

- Migration of existing connected accounts in prod — per 2026-04-23 retro, none exist.
- Full SDK rewrite if the fetch wrapper is adequate for v3. Evaluate both paths in an ADR before writing code.

## Edge cases

- Expired tokens → document reconnect flow in `docs/runbooks/` before closing ticket.
- Rate-limited responses → retry with exponential backoff (max 3 attempts, 500ms → 2s → 8s).
- v3 renamed `entityId` → `user_id` in request body — confirm with a real-key probe first.
- Legacy dual typo handling (`successfull` / `successful`) — drop in v3, no back-compat rows to worry about.
- `COMPOSIO_API_BASE_URL` env var still defaults to v1 — update the default and the Fly secret together.

## Approach options (pick in ADR before coding)

1. **Install `@composio/core` SDK** (`0.6.11` on npm as of 2026-04-24, ISC license). Clean; Composio owns the shapes. Adds 1 dep but pulls in `openai` + `pusher-js` transitively.
2. **Keep fetch wrapper, update paths + body shapes to v3.** Zero new deps. Requires a real-key probe against v3 first to capture the exact body shapes (docs punt to SDK for concrete schemas).

## Session notes (2026-04-24, attempted in session but deferred)

Briefly installed `@composio/core@0.6.11` to inspect the API. Finding that blocks a 15-min fix: **v3's `connectedAccounts.initiate(userId, authConfigId, options)` requires a pre-created `authConfigId`** — you no longer pass `appName` ("slack") and have it auto-create a config. Our current `ComposioInitiateConnectionInput = { userId, appName }` does exactly that.

This is an architectural change, not a path rename:
- Need to decide where `authConfigId` lives (FounderOS DB? Looked up per-toolkit? Bootstrapped once per instance?)
- Need to model the auth-config lifecycle (who creates it, who updates it, who deletes it on toolkit removal)
- The 4 existing test files mock v1 fetch shapes — need full rewrite, not patch

Uninstalled `@composio/core` since we're not landing the migration in this session. The fetch wrapper stays on v1 but is **gated off by default** via `COMPOSIO_V3_READY` env flag (see `isComposioEnabled()` in `composio-client.ts`). Without this flag, all composio routes graceful-degrade to "not enabled" instead of 410'ing.

Per the forward plan's process guarantee, this ticket requires a fresh `/clear` session in Plan Mode with TDD inversion. Not snackable.

## Verification

- **Local:** `pnpm --filter @founderos/server test src/__tests__/composio-client.test.ts` — all pass.
- **Staging:** Connect Slack via the Integrations page, send a test message. Expect it to land in the target channel.
- **Prod health:** `curl -sf https://founderos.fly.dev/api/health/deep | jq '.checks[] | select(.name=="composio_ping")'` still `ok`.

## Dependencies

- A real Composio API key exposed in a scratch terminal to probe v3 body shapes (Fly secret `COMPOSIO_API_KEY` = `ak_fGvzbm946SY4cLYvRTEc`).
- A Slack-connected test account on staging.

## Rollback

`git revert <commit>` + `fly deploy`. Composio config is stateless in FounderOS — no DB-layer rollback needed.
