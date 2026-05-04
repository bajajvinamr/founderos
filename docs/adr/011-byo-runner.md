# ADR-011 — BYO Runner: outbound polling for hosted-cloud + local-execution split

## Status

Accepted (2026-05-04). Expires 2026-08-04 (re-evaluate after first 5 paying customers).
Supersedes the implicit assumption that `claude_local` was the only execution path. Does not supersede ADR-005 (BYO key) — that ADR applies to the future hosted-API tier; this ADR applies to the current shippable runtime.

## Context

The 2026-05-04 architecture council surfaced a 7-month-old gap: every registered adapter (`claude_local`, `codex_local`, `cursor`, `gemini_local`, etc.) spawns a CLI binary via `runChildProcess` (`packages/adapter-utils/src/server-utils.ts:1049`). The Fly container at `founderos.fly.dev` has none of those binaries installed, so a hosted signup creates a company that cannot run a single agent. `server/src/services/onboarding-bootstrap.ts:201` hardcodes `adapterType="claude_local"` regardless of `adapterChoice`, and `adapter-resolver.ts:163` references a `claude_api` adapter that was never registered.

`doc/PRODUCT.md` always framed FounderOS as "control plane, not execution plane" — Paperclip's mental model is "founder runs server on their authed laptop." We added Fly hosting without re-architecting the runtime, then spent 7 months polishing the control plane around an empty engine slot.

The week-1 ship constraint is hard: Path B (hosted `anthropic_api` adapter) is a 4-6 week build that reimplements the ReAct loop, tool execution, session memory, and skills materialization that Anthropic's CLI already handles for free. Path A (`npx founderos` full-local server) ships in days but loses cloud signup, multi-device access, and the entire Phase 0 hardening that just merged.

## Decision

Adopt the **outbound-polling thin-runner** architecture: cloud control plane stays on Fly + Supabase, agent execution moves to a small `@founderos/runner` package that the founder installs on their own machine and that polls cloud REST endpoints for work.

Mechanism:

1. Founder signs up at founderos.fly.dev (existing flow).
2. Onboarding wizard issues a long-lived bearer token (`fos_<32-char>`) scoped to the company.
3. Founder runs `npx @founderos/runner --token=<token>` once on their laptop.
4. Runner long-polls `GET /api/runner/jobs/next` every 5s.
5. On a hit, runner spawns `claude --print --output-format stream-json --resume <sid> -p "$PROMPT"` (the exact flag set used by `claude-local/src/server/execute.ts:432`), captures stream-JSON output, and POSTs events back to `/api/runner/jobs/:id/events`.
6. On exit, runner POSTs `/api/runner/jobs/:id/complete` with exit code + cost.

Authentication piggybacks on the user's existing `claude login` (OAuth → ~/.claude/) — no API key changes hands. The user's Claude Pro/Max subscription pays for the tokens. Cloud's COGS stays flat.

A new adapter type `byo_runner` is registered. Its server-side `execute()` is a no-op that just enqueues a `runner_jobs` row; the runner does the actual work. From the heartbeat scheduler's perspective, `byo_runner` is structurally identical to a slow CLI adapter that takes "however long until the runner picks it up" to return.

The architecture is gated behind `FOUNDEROS_BYO_RUNNER_ENABLED` for safe rollout. Default off in prod until Friday E2E green; flip on in a separate PR after 24h soak.

## Consequences

- **Cloud control plane preserved.** All Phase 0 hardening (observability, atomic admin, OAuth state CSRF binding, env-validation, single-origin Fly cutover) stays load-bearing. Multi-device dashboard access stays. Composio v3 integrations stay.
- **Zero token cost to FounderOS.** Customer's CLI auth pays. Unit economics work at $99-299/mo. No metering, no overage handling, no margin death.
- **Runner install becomes the new onboarding friction.** "Paste this in Terminal" is the first step where non-technical users could drop. Mitigation: copy-to-clipboard UX, clear error messages on `claude not found`, follow-up `founderos-runner.app` Mac installer in month 2.
- **User's laptop has to be on for agents to run.** Visible status in dashboard ("Sarah is sleeping — your laptop is offline"). Acceptable for the technical-founder buyer. The "Always-On" $299/mo hosted-execution tier becomes a real follow-up product (Path B revisited) once 5+ paying customers prove demand.
- **Tool-call governance moves to the REST boundary.** `heartbeat.ts:2235` post-facto stdout parsing for tool gating becomes server-side allow/deny on the runner's event POSTs. Cleaner security model — though v0 mirrors current trust assumptions and tightens in a follow-up.
- **Skills sync gap.** `byo_runner` has no `listSkills`/`syncSkills` in `registry.ts:146-153`. v0 expects the user to `claude install-skill X` themselves; cloud-driven skill manifest sync follows in v2.
- **No AWS migration.** Both council models converged: the runtime architecture was the problem, not the cloud vendor. Fly + Supabase + Postgres remain correct.

## Alternatives considered

- **Path A — `npx founderos` full-local server.** Distribute the entire FounderOS server as a desktop app or `npx` package. Runs on the user's laptop with their authed CLI. Architecture already supports this. Rejected because: loses cloud signup, multi-device access, Phase 0 hardening; inherits post-facto stdout governance (`heartbeat.ts:2235`); breaks the SaaS thesis the dashboard depends on; distribution-as-product is its own multi-week build (auto-update, code signing, native installer). The runner is Path A's compromise — local execution without local control plane.
- **Path B — hosted `anthropic_api` adapter.** Build a real `anthropic_api` adapter using `@anthropic-ai/sdk` directly. Read company secret, run inference in the Fly server process, stream through existing run/heartbeat machinery. Rejected because: 4-6 weeks minimum scope to reach feature parity with the CLI (full ReAct loop, tool execution, session memory, skills, prompt cache); token-economics inversion (passthrough customer key works only with strict spend caps that aren't built); loses Pro/Max subscription support (OAuth doesn't transfer to remote machines). Reconsidered as the v3+ "Always-On" tier.
- **Path C-WebSocket — repurpose `openclaw_gateway` adapter as-is.** Existing adapter is cloud-initiated WebSocket *to* the user's URL (`packages/adapters/openclaw-gateway/src/server/execute.ts:455`). Rejected because: requires inbound tunnel (ngrok or equivalent) on the user's machine; terrible UX for non-technical founders. The accepted Path C-Outbound uses a thin runner that originates connections — no inbound networking on user side.
- **Self-hosted runner via Docker image.** User runs a FounderOS Docker container that includes the CLI. Rejected because: most of our buyer segment doesn't run Docker; the user's existing `claude login` OAuth state on `~/.claude/` doesn't trivially mount into a container; loses the upgrade path where the runner becomes a Mac/Windows installer.

## References

- Council 2026-05-04 (R1+R2 converged, Codex `gpt-5.3-codex` + Gemini `gemini-3-pro-preview`)
- `~/.gstack/projects/founderos/decisions.md` 2026-05-04 entry
- API contract: `docs/api/runner-openapi.yaml`
- Threat model: `docs/security/runner-threat-model.md`
