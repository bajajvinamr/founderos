# Ticket 001 — Composio v3 client migration

**Milestone:** M1 · **Owner:** unassigned · **Created:** 2026-04-23

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

1. **Install `@composio/core` SDK** (`0.6.11` on npm as of 2026-04-24). Clean; Composio owns the shapes. Adds 1 dep.
2. **Keep fetch wrapper, update paths + body shapes to v3.** Zero new deps. Requires a real-key probe against v3 first to capture the exact body shapes (docs punt to SDK for concrete schemas).

## Verification

- **Local:** `pnpm --filter @founderos/server test src/__tests__/composio-client.test.ts` — all pass.
- **Staging:** Connect Slack via the Integrations page, send a test message. Expect it to land in the target channel.
- **Prod health:** `curl -sf https://founderos.fly.dev/api/health/deep | jq '.checks[] | select(.name=="composio_ping")'` still `ok`.

## Dependencies

- A real Composio API key exposed in a scratch terminal to probe v3 body shapes (Fly secret `COMPOSIO_API_KEY` = `ak_fGvzbm946SY4cLYvRTEc`).
- A Slack-connected test account on staging.

## Rollback

`git revert <commit>` + `fly deploy`. Composio config is stateless in FounderOS — no DB-layer rollback needed.
