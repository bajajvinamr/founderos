# @founderos/adapter-openai-api

Scaffold for the OpenAI API HTTP-wrapper adapter. The wrapper script (`bin/openai-api-runner.mjs`) lets the dispatcher spawn a subprocess that bridges Anthropic-style stream-json to OpenAI's chat completions endpoint, so the adapter handler interface stays uniform across CLI-based and HTTP-based providers (decision E1=A, see `.planning/decisions/2026-05-08-s7-pre-impl-recs.md`).

## Status

Skeleton only. Implementation lands in S7.B.3 (wrapper script) and S7.B.4 (handler).

## Why a wrapper script

Keeping `AdapterSpawnHandler` as the single dispatch contract means HTTP providers are subprocesses too, not a special case in the runner.
