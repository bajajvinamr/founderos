# ADR-014 — Hermes runner-side CLI adapter deferred

## Status

Accepted (2026-05-07)

Decided as part of the PHASE-S7 multi-CLI runner sprint. Council R1 (Codex
gpt-5.4 + Gemini gemini-3.1-pro-preview) flagged this as a P1 — the
original plan's S7.10/S7.11 tickets would have shipped a broken stub.

## Context

The PHASE-S7 multi-CLI runner sprint extends `@founderos/runner` from a
single-binary Claude spawner to an adapter-aware dispatcher across the
six CLIs we list in `AGENT_ADAPTER_TYPES`: Claude, Codex, Gemini,
OpenCode, Pi, Cursor, plus a slot for Hermes (`hermes_local`).

Hermes is unique in this set:

- The type slot `hermes_local` exists in
  `packages/shared/src/constants.ts:AGENT_ADAPTER_TYPES`,
  `packages/adapter-utils/src/session-compaction.ts:LEGACY_SESSIONED_ADAPTER_TYPES`,
  and `ui/src/adapters/adapter-display-registry.ts`.
- The runtime `hermes-paperclip-adapter` (npm `^0.2.0`) is already a
  server dependency in `server/package.json:72` and is registered via
  `server/src/adapters/registry.ts:71-82`.
- There is **no `packages/adapters/hermes-local/` package** parallel to
  `claude-local`, `codex-local`, `gemini-local`, etc.
- There is **no `hermes` CLI binary** spawned as a child process.

In other words: hermes today runs cloud-side inside the paperclip
runtime, not as a child-process CLI the runner can spawn. Writing a
runner-side `@founderos/adapter-hermes-local` package from scratch in
the same shape as the other CLI adapters (the original S7.10/S7.11
tickets) would have produced a stub with no real binary to invoke —
the council called this out as the load-bearing P1 on the plan.

## Decision

We defer the runner-side Hermes CLI adapter. Hermes execution remains
cloud-side via the paperclip runtime in the canonical Fly deploy.
Specifically:

1. **Keep** `hermes-paperclip-adapter` in `server/package.json` and the
   server-side registration in `server/src/adapters/registry.ts`. No
   change to existing hermes agent execution.
2. **Do NOT** create `packages/adapters/hermes-local/`. The runner
   dispatcher (S7.A) will reject `hermes_local` jobs with a clear
   "this adapter runs cloud-side, not via the local runner" message.
3. **Keep** the `hermes_local` type slot in `AGENT_ADAPTER_TYPES`,
   `LEGACY_SESSIONED_ADAPTER_TYPES`, and the UI display registry. The
   slot is real — the *runner-side* shim is what's missing, and we're
   choosing not to build it.
4. **Revisit** if a design partner or buyer-driven requirement explicitly
   asks for runner-mode Hermes. Track in CLAUDE.md Phase 1 backlog.

## Consequences

What gets easier:
- The PHASE-S7 sprint compresses by ~6 days (S7.10 + S7.11 deleted).
- No risk of shipping a stub adapter that fails the dispatcher in
  production for any agent that picks `hermes_local` from the wider
  onboarding picker post-S7.4.
- The cloud-side hermes path (already in production) keeps working
  unchanged.

What gets harder:
- Buyers / design partners who want to run Hermes on their local laptop
  with their own subscription cannot do so today. Cloud-side execution
  bills the FounderOS instance (Fly), not the user's Hermes account.
- The asymmetry between "all 7 CLIs have a runner-side adapter EXCEPT
  hermes" needs to be documented in the onboarding UI and buyer
  handover docs (`docs/ops/design-partner-onboarding-kit.md`).

New risks:
- Adapter parity drift. As new versions of Hermes ship CLI features,
  runner-side users of other CLIs get them automatically; hermes
  users do not. Mitigation: document hermes as cloud-only and
  re-evaluate when the demand signal arrives.
- Agent configuration confusion. A founder who picks `hermes_local`
  in Settings expecting laptop-spawn semantics will get cloud-spawn
  semantics. Mitigation: the onboarding wizard surfaces the asymmetry
  (S7.4); the dispatcher rejects with a clear message (S7.A).

Downstream changes required:
- S7.A dispatcher (`packages/runner/src/spawn.ts`) must include a
  rejection path for `hermes_local` with a clear error message
  pointing the founder at the cloud-side path.
- S7.4 onboarding UI must label `hermes_local` as "cloud-side
  execution" rather than rendering it identically to the runner-side
  CLI cards.

## Alternatives considered

- **Option A — Build `packages/adapters/hermes-local/` from scratch
  using gemini-local as a template.** Rejected: there is no `hermes`
  CLI binary to spawn. The package would need to either invoke the
  paperclip runtime via a subprocess (architecturally backwards —
  cloud-side runtime running in a runner-side wrapper) or wrap a
  fictional binary that doesn't exist. Council R1 P1 #4 was clear
  on this; this is what would have shipped a broken stub.

- **Option B — Externalize hermes execution from the cloud entirely
  to runner-side, requiring users to install a hermes CLI on their
  laptop.** Rejected: doesn't exist as a shipping product today.
  Treating it as a real CLI parallel to `gemini` / `codex` would
  require us to inherit responsibility for shipping the binary,
  which is out of scope for the FounderOS sprint and for the
  $4k buyer-funded MVP.

- **Option C — Defer (chosen).** Keep paperclip-bundled cloud-side
  execution. Mark hermes_local as cloud-only. Revisit on demand
  signal. This matches the project's "ship > perfect" working mode
  and the ADR-011 principle that runner-mode is for adapters where
  the user's local subscription is the auth boundary; for hermes
  that's not the buying-decision today.

## References

- PHASE-S7 plan: `.planning/PHASES/PHASE-S7-multi-cli-runner.md`
- Council decision log: `~/.gstack/projects/bajajvinamr-founderos/decisions.md`
  entry "PHASE-S7 multi-CLI runner sprint plan" (2026-05-07)
- Server-side hermes registration: `server/src/adapters/registry.ts:71-82`
- Type slot: `packages/shared/src/constants.ts:AGENT_ADAPTER_TYPES`
- Original (now-removed) S7.10/S7.11 tickets in council R1 review
