# Dispatcher v2 rollout (PHASE-S7)

**Status:** flag scaffolded 2026-05-08 (S7.A.0). The flag is wired end-to-end
but the v2 multi-adapter dispatcher itself ships incrementally across
S7.A.1..S7.D.6. Until S7.A.5 lands, a truthy flag value still falls back to
the legacy `runClaude` path with a warn log line.

## What the flag does

`FOUNDEROS_DISPATCHER_V2` gates the PHASE-S7 multi-provider dispatcher in
`@founderos/runner`. When truthy, the runner will (once handlers land) route
agent jobs through provider-specific adapters: Claude, Gemini, Codex, Cursor,
OpenCode, OpenAI-API wrapper. When unset / falsy, the runner uses the legacy
single-provider `runClaude` path — the behavior the runner has shipped with
since v0.1.

- **Truthy values** (case-insensitive, trimmed): `"1"`, `"true"`, `"yes"`.
  Anything else — including unset, empty string, `"0"`, `"false"` — is the
  safe default and selects v1.
- **Single source of parsing:** `packages/runner/src/config.ts:isDispatcherV2Enabled`.
  Do not re-implement the parse elsewhere — when the truthy set evolves, it
  evolves there.
- **Read site:** `packages/runner/src/main.ts` inside `runRunnerLoop()`.
  Selection happens once at startup and is logged as
  `[dispatcher] v1 (legacy runClaude)` or `[dispatcher] v2 (multi-adapter)`.

The server-side `env-validation.ts` entry is INFO-severity — the flag is
purely advisory at the cloud layer; the runtime decision happens on the
founder's machine where `@founderos/runner` reads the env directly.

## Flip procedure

The flag is read by the runner process, which is typically:

- **Fly-deployed runner** (post-S7 cutover, when the cloud-side runner ships):
  ```bash
  fly secrets set FOUNDEROS_DISPATCHER_V2=1 -a founderos
  fly deploy -a founderos --strategy immediate
  ```
  Confirm uptake in the boot logs:
  ```bash
  fly logs -a founderos | grep '\[dispatcher\]'
  ```
  You want to see `[dispatcher] v2 (multi-adapter)` on every machine boot
  after the deploy finishes.

- **BYO Runner on a founder's laptop** (current architecture, ADR-011):
  ```bash
  export FOUNDEROS_DISPATCHER_V2=1
  founderos-runner start
  ```
  The first log line is `[dispatcher] v2 (multi-adapter)`. If the founder
  uses a launchd / systemd unit, set the env var in the unit file and
  restart the service.

In both cases, ABSENCE of the env var is the rollback — see below.

## Soak period

**Minimum 24h of green telemetry before declaring the rollout stable.**
This is the same soak the runner adapter (`byo_runner`) had pre-cutover.

What to watch in `fly logs -a founderos` (or local stdout for BYO runners):

1. Boot lines for every runner show `[dispatcher] v2 (multi-adapter)` —
   confirms env was actually picked up. (A common pre-S7.A.5 signal:
   `[dispatcher] v2 path requested but not yet implemented; falling back
   to v1` is EXPECTED until S7.A.5 lands; once S7.A.5+ is in, this line
   should disappear.)
2. **Agent-spawn error rate** — track `runner_jobs.status = 'failed'` in
   the 24h window vs the prior 24h. Spike = roll back.
3. **Cost-event volume** unchanged — `cost_events` table per-day count
   should be flat (the dispatcher is a routing layer, not a cost layer).
4. **Runner queue depth stable** — `select count(*) from runner_jobs
   where status = 'queued'`. If jobs are sticking in queue under the v2
   path, the dispatcher is rejecting work and falling through; roll back.

## Rollback

If any of the soak signals trip, unset the flag — absence MUST always be
the safe default (this is the primary invariant of the rollout):

- **Fly:**
  ```bash
  fly secrets unset FOUNDEROS_DISPATCHER_V2 -a founderos
  fly deploy -a founderos --strategy immediate
  ```
  Verify rollback in the boot logs:
  ```bash
  fly logs -a founderos | grep '\[dispatcher\]'
  # expect: [dispatcher] v1 (legacy runClaude)
  ```

- **BYO Runner on a founder's laptop:**
  ```bash
  unset FOUNDEROS_DISPATCHER_V2
  # then restart the runner
  ```

No DB migration, no schema change, no data backfill required to roll back —
the flag gates only the dispatcher selection at process start, and `runClaude`
remains intact and side-effect-free until S7.A.5.

## Success criteria

Treat the rollout as successful when ALL of the following hold over a 24h
window with the flag set:

- [ ] No spike in `runner_jobs.status = 'failed'` (≤ baseline + 10%).
- [ ] `cost_events` volume per provider is non-zero for at least Claude
      (so we know a real adapter handled traffic, not an instant
      pass-through).
- [ ] No new Sentry issue clusters tagged with the runner package.
- [ ] `runner_jobs` queue depth stable (no monotonic growth).
- [ ] Boot log shows `[dispatcher] v2 (multi-adapter)` consistently across
      every machine restart.

## Lifecycle

This flag is read by every downstream PHASE-S7 ticket — S7.A.1 through
S7.D.6. **Do NOT remove it until S7.D.6 (week-after-soak post-cutover
trigger drop).** That ticket owns the cleanup: deletes the env-validation
entry, removes the `isDispatcherV2Enabled` helper, removes the legacy
`runClaude` import + branch, and updates this runbook to a tombstone.

Until then, the flag is the rollback escape hatch for every adapter that
lands in S7. Removing it earlier means there is no rollback for any of
those tickets — every downstream ticket reads this flag.

## References

- PHASE plan: `.planning/PHASES/PHASE-S7-multi-provider.md`
- Runtime parse: `packages/runner/src/config.ts:isDispatcherV2Enabled`
- Runtime read: `packages/runner/src/main.ts` (inside `runRunnerLoop`)
- Server-side discovery: `server/src/lib/env-validation.ts` (INFO entry)
- Test: `packages/runner/src/__tests__/dispatcher-flag.test.ts`
