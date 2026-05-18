# @founderos/adapter-anthropic-api

Anthropic API adapter — wraps `@anthropic-ai/sdk` `messages.create({ stream: true })` behind the FounderOS `ServerAdapterModule` contract.

## Status

Phase 1 shipped 2026-05-18. Closes the gap flagged at `packages/shared/src/constants.ts:90-91` ("anthropic_api currently still collapses to claude_local").

## When to use

- Founder has an Anthropic API key configured in Settings -> API Keys (family = `anthropic`, mode = `api`).
- You want server-side execution that runs on Fly without depending on a local `claude` CLI binary being present in the container PATH.

## When not to use

- Founder has `claude` CLI already authenticated via Claude Code (use `claude_local`).
- Founder wants OAuth/CLI-credential-based access (use BYO Runner or `claude_local`).

## Contract

Mirrors `@founderos/adapter-openai-api`:

- API key resolved at run time via `config.apiKeyResolver("anthropic", "api")` -- injected by `server/src/services/heartbeat.ts` from `instanceApiKeysService.getDecrypted("anthropic", "api")`.
- Stateless -- no session codec, each run is independent.
- Streams output tokens to the run log as they arrive.
- Records `inputTokens`, `outputTokens`, `cachedInputTokens` (from prompt-caching reads), and `costUsd` in the run summary.
- Returns `errorCode: "no_api_key"` (with `exitCode: null`) when the resolver returns null/empty -- this is a config failure, not a run failure.

## Configuration

| Field | Type | Default | Notes |
|---|---|---|---|
| `model` | string | `claude-opus-4-7` | Any Anthropic model id. See `models` export for known ids. |
| `maxTokens` | number | 4096 | Required by the Anthropic API. Max output tokens. |
| `timeoutSec` | number | 120 | Per-run timeout. AbortController fires on the SDK call. |
| `promptTemplate` | string | (default agent prompt) | Supports `{{agent.id}}`, `{{agent.name}}`, `{{agent.companyId}}`. |
| `thinking` | object \| null | `{type: "adaptive"}` on opus models | Pass `null` to disable. See https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking |

## Pricing

Cost estimation uses the same per-1M pricing table as the platform models view (Opus 4.7 / 4.6 / Sonnet 4.6 / Haiku 4.5). Unknown model ids yield `costUsd: null` rather than guessing.
