# Onboarding compute-gate — diagnosis & plan

_2026-05-18. Trigger: real founder hit two bugs in the onboarding wizard — (1) API-based connection tiles never rendered, (2) selecting "Claude Code" let them advance without installing the runner, then the product was inert because no compute was attached._

> Status: **diagnosis only, no code yet.** Read this, then pick the fix shape and I'll implement.

---

## TL;DR

Onboarding lets a founder reach the dashboard with **zero working compute path** because:

1. The UI adapter registry was never updated when the shared contract grew to 10 adapter choices. Three of the four MVP tiles (`anthropic_api`, `openai_api`, `google_api`) literally do not render. The shared contract knows them, the server validates them, the keystore stores them — only the React surface is behind.
2. The Step-2 "Next" gate checks _whether the env test returned a result object_, not _whether the result was a pass_. So a `{ status: "fail", checks: [...] }` still advances. Combine that with `claude_local` being the default (and the Fly container not having `claude` in PATH), and the founder ships an agent that can never wake up.

The fix is a single onboarding screen rebuild + one shared contract: "no founder leaves Step 2 without a verifiable compute path." Three possible scopes are spelled out below.

---

## Evidence (file:line)

### Hole 1 — UI registry is behind the shared contract

- `packages/shared/src/constants.ts:116-128` — canonical list of 10 adapter choices including `anthropic_api`, `openai_api`, `google_api`.
- `packages/shared/src/constants.ts:98-100` — 6-tile MVP scope explicitly includes the three `*_api` tiles.
- `server/src/routes/onboarding.ts:284-322` — server validates `anthropic_api` keys live via `validateAnthropicKey()` and persists them to `instance_api_keys` so the "hosted-mode" `claude_local` handler can read them. **The server path works end-to-end.**
- `ui/src/adapters/registry.ts:54-69` — `registerBuiltInUIAdapters()` registers only 10 modules, **none of them `*_api`**. Just local CLI adapters + `process` + `http` + `openclaw_gateway`.
- `ui/src/components/OnboardingWizard.tsx:204-216` — the wizard builds tiles from `listUIAdapters()`. No `*_api` modules registered → no `*_api` tiles rendered. The "use my Anthropic key" path is invisible.

> The CLAUDE.md note that "claude_local hardcodes at onboarding-bootstrap.ts:201 even when user picks anthropic_api" is now **stale** — the constants.ts comment (line 90-91) confirms `anthropic_api` still collapses to a `claude_local` adapter row at provisioning, but the server-side handler reads from `instance_api_keys` in hosted mode. So picking `anthropic_api` would actually work if the tile existed.

### Hole 2 — Step-2 gate is a presence check, not a pass check

```typescript
// ui/src/components/OnboardingWizard.tsx:454-457
if (isLocalAdapter) {
  const result = adapterEnvResult ?? (await runAdapterEnvironmentTest());
  if (!result) return;  // ← only guards against the network call itself failing
}
```

`result.status` is never inspected. A `{ status: "fail", checks: [...] }` payload passes the guard, the agent is created with the failing adapter, and `setStep(3)` fires.

- `NONLOCAL_TYPES = new Set(["process", "http", "openclaw_gateway"])` at line 201 — so `claude_local`, `codex_local`, `gemini_local`, and (would-be) `byo_runner` all go through this same broken gate.
- The default at line 109 (`useState<AdapterType>("claude_local")`) and the reset at line 288 lock in `claude_local` as the wizard's starting adapter. On Fly, the container does not ship `claude` in PATH → env test returns `fail` → founder still advances → agent enqueues a wakeup → handler returns `no_api_key` (or `claude_binary_not_found`) → silent.

### Hole 3 — `claude_local` has two execution modes the wizard never disambiguates

The server-side `claude_local` handler has two execution paths:

1. **Hosted-mode** — reads from `instance_api_keys`, hits the Anthropic API directly. Activated when an `anthropic_api` key was stored during onboarding. **Works on Fly without any CLI install.**
2. **CLI-mode** — spawns `claude` from container PATH. Requires the binary. **Does not work on Fly.**
3. **BYO Runner mode** — separate adapter family (`byo_runner`) per ADR-011 and `packages/runner/README.md`. Enqueues into `runner_jobs`, founder runs `npx @founderos/runner start --token=fos_xxx` on their laptop, jobs pick up there. Requires a registered runner with recent `runner_tokens.lastSeenAt`.

The wizard exposes a single `claude_local` tile that papers over (1) and (2) and never even surfaces (3). A founder who picks "Claude Code" gets path (2), which is broken in prod.

---

## What "verifiable AI compute" should mean

For the wizard to let a founder past Step 2, **at least one** of these must be true for the company being created:

| Mode | Verification |
|---|---|
| API key (any of `anthropic_api`, `openai_api`, `google_api`) | Live key validator returns `valid: true`. Persisted to `instance_api_keys`. |
| Local CLI (`claude_local` etc.) — only meaningful in dev | Server env test `result.status === "pass"`. |
| BYO Runner | A `runner_tokens` row exists for the company AND `lastSeenAt > NOW() - 60s`. The "runner_just_called_home" signal already powers the AppRunnerBanner liveness pill — same query. |

Any other state = "no compute" = blocked.

---

## Three remediation scopes

### Scope A — Minimum unblock (~5 hours, one PR)

Just close the bug class.

1. **Add `anthropicApiUIAdapter` UI module** (~80 lines, mirrors `claudeLocalUIAdapter` shape but with a single `apiKey` config field, validated client-side as `^sk-ant-` prefix + ≥40 chars). Register in `registerBuiltInUIAdapters()`.
2. **Flip the default** from `claude_local` to `anthropic_api` at `OnboardingWizard.tsx:109` and `:288`. Reorder the adapter grid so `anthropic_api` is the first recommended tile and `claude_local` is demoted to "advanced".
3. **Fix the gate** at `OnboardingWizard.tsx:454-457` — change to `if (!result || result.status !== "pass") return;` and surface the failing checks inline ("`claude` binary not found in PATH").
4. **Add the missing live API-key validation** to the new `anthropic_api` tile — block "Next" until the key passes `agentsApi.testEnvironment` (which already exists per line 361). The server already has `validateAnthropicKey()`, just route through it.

What this does NOT fix: `openai_api` + `google_api` tiles still missing, runner-mode is still un-surfaced, copy is still developer-flavored.

### Scope B — Per the 2026-05-10 audit P0 #9 + #4 (~1.5 days)

Rebuild the chooser per CONTINUE.md's prioritized-but-unshipped product audit:

1. All of Scope A.
2. Add `openaiApiUIAdapter` + `googleApiUIAdapter` UI modules. Complete the 6-tile MVP scope from `constants.ts:98-100`.
3. **Required-setup-per-tile copy**: every tile shows its prereq inline ("Paste your Anthropic API key" / "Install `claude` on your machine and run the runner" / etc.). Tiles whose prereq cannot be satisfied in the current environment are visibly disabled with the reason.
4. **Post-onboarding `<RunnerStatusBanner>` (CONTINUE.md P0 #4)** on the dashboard for any company whose chosen path is BYO Runner. Polls the existing `runner_tokens.lastSeenAt` endpoint every 30s. Banner stays up until first `lastSeenAt < 30s`.
5. **BYO Runner as a first-class tile**: explicit "Use my own machine (advanced)" path that walks through `npx @founderos/runner start --token=...` with the token issued inline. "Next" blocks until the runner pings home.

### Scope C — Plan-only escalation

Spike `/council` (vanta) on the unified contract before any code lands. Specifically: should `claude_local` exist as a user-facing tile at all in prod, or should it be hidden behind a `?advanced=1` query string / dev-only? Council convergence-of-opinions on the API-key-vs-runner tradeoff for non-technical founders.

---

## Recommendation

**Scope A this week, Scope B next week, Scope C only if Scope A's PR review surfaces a divergence.**

Reasoning:
- Hole 1 + Hole 2 together are a ship-blocker — Scope A closes both in one tight PR with low blast radius (UI-only changes to one component + one new adapter module + one default flip).
- Scope B is the right north star but the wizard refactor needs a dedicated audit-driven PR per the 2026-05-10 docs already on disk — bundling it with the unblock fix mixes "stop the bleeding" with "redesign the surface."
- Scope C is overkill _unless_ Scope A's review surfaces a real ambiguity. The contract in `constants.ts` is unambiguous; the architecture decision was already made in S7.0.2 + ADR-011.

---

## Verification plan (for whichever scope ships)

Before claiming the fix works:

1. **Local repro**: spin up the wizard against an embedded-pg backend with `claude` not in PATH. Confirm pre-fix that `claude_local` advances to Step 3. Post-fix, confirm it blocks with a visible "claude binary not found" message.
2. **API key path**: paste a known-good Anthropic key into the new tile. Confirm key is validated server-side (200 from `/api/agents/.../test-environment`), persisted to `instance_api_keys` (DB row exists), and the wizard advances. After completing onboarding, fire a test wakeup and confirm the agent actually runs against the stored key.
3. **API key reject path**: paste `sk-ant-FAKEKEY12345...`. Confirm 422 / "Anthropic API key rejected" surfaces in the wizard, and "Next" is disabled.
4. **Synthetic prod check**: deploy to `founderos.fly.dev`, run the post-deploy canary against the new tile path, confirm no `no_api_key` errors on first agent wakeup.
5. **Smoke for the existing canary user** (`bajajvinamr+canary@gmail.com`) per CONTINUE.md "Active thread #1" — the 401 investigation is unrelated but the same smoke covers both.

---

## Open questions (answer before implementation)

1. **Is the hosted-mode `claude_local` handler proven in prod today?** I traced the comment in `onboarding-bootstrap.ts` saying "server-side claude_local handler reads from instance_api_keys" but did not read the handler itself. If hosted-mode is not actually shipped yet, Scope A needs to also add a true `anthropic_api` agent-runtime path. _10 minutes to verify by reading `server/src/services/adapters/claude-local.ts` or wherever the handler lives._
2. **Should `skip` remain an option at all?** It's the third silent-failure path — founder can "defer the decision," reach the dashboard, agents do nothing. If the answer is "no for prod, yes for dev," gate behind `NODE_ENV !== 'production'`.
3. **Do we want the runner-token tile (Scope B) or is API-key the only non-dev path?** Probably both, but worth confirming buyer's intent for the design-partner onboarding kit.

---

## Files that will change (Scope A only)

| File | Change |
|---|---|
| `ui/src/adapters/anthropic-api.ts` (new) | New UI adapter module |
| `ui/src/adapters/registry.ts` | Register `anthropicApiUIAdapter` in `registerBuiltInUIAdapters()` |
| `ui/src/adapters/adapter-display-registry.ts` | Display metadata (icon, label, `recommended: true`) for `anthropic_api` |
| `ui/src/components/OnboardingWizard.tsx` | Default → `anthropic_api`; gate fix at line 454; surface `validateAnthropicKey` failure inline |
| `ui/src/components/OnboardingWizard.test.tsx` (if exists) | Update default expectations + add failing-env-test gate test |

Estimated diff: ~250 lines.

---

_Plan author: Claude (Opus 4.7). Diagnosis based on read of OnboardingWizard.tsx, onboarding.ts, onboarding-bootstrap.ts, constants.ts, registry.ts, use-disabled-adapters.ts, disabled-store.ts, AiConnections.tsx, runner README._

---

## 2026-05-18 update — Path E shipped, anthropic-api adapter deferred

**What changed during implementation:** mid-implementation reading of `packages/adapters/claude-local/src/server/execute.ts:36-46` revealed that hosted-mode `claude_local` still spawns the `claude` CLI. It reads the API key from `instance_api_keys` but does not call the Anthropic API directly. Since the Fly container doesn't ship the claude binary, adding the `anthropic_api` UI tile as planned would have replaced a visible-broken UX with an invisible-broken UX — the wizard would say "connected" but agents would still fail to wake up.

**The only API-key adapter that actually works on Fly today is `openai_api`** (PR #194). Its `execute.ts` calls `chat.completions` over HTTP directly. No Anthropic equivalent exists; `packages/adapters/anthropic-api/` is not a package on disk.

**Path E chosen — gate fix only:**

- `ui/src/components/OnboardingWizard.tsx` step-2 gate hardened: if env-test `result.status === "fail"`, block `setStep(3)` and surface "Adapter environment check failed. Resolve the issues above before continuing, or pick a different adapter." The failing checks already render inline via `<AdapterEnvironmentResult>` (line 977-985), so the founder sees the actual reason; the new error is just the call-to-action.
- `pnpm --filter @founderos/ui run typecheck` clean.

**Deferred — next session:**

1. **Build `packages/adapters/anthropic-api/`** — mirror `packages/adapters/openai-api/` shape exactly:
   - `src/index.ts` — `export { execute }`, `type = "anthropic_api"`, `label`, `DEFAULT_MODEL = "claude-sonnet-4-6"`, `models = [...]`, `agentConfigurationDoc`.
   - `src/server/execute.ts` — call `@anthropic-ai/sdk` `client.messages.create({ stream: true })` with the key resolved via `config.apiKeyResolver("anthropic", "api")`. Stream tokens to `onLog`. Report usage + cost via `onMeta`. Same cache-token handling pattern as `openai-api/execute.ts:42-51`.
   - `src/server/test.ts` — config validators for `model`, `timeoutSec`, `maxTokens`; info check explaining key is resolved at run time from instance keystore.
   - `src/server/index.ts` — `ServerAdapterModule` shape matching PR #194's contract.
   - Register `anthropic_api` in `server/src/adapters/registry.ts` (look for where `openai_api` was added in PR #194).
   - Wire `config.apiKeyResolver` to `instanceApiKeysService.getDecrypted("anthropic", "api")` in the server-side dispatch boundary.

2. **THEN add the UI tile** — `ui/src/adapters/anthropic-api/index.ts` + `config-fields.tsx` (single API-key input). Register in `ui/src/adapters/registry.ts:54-69`. Add `adapter-display-registry` entry (icon = `Sparkles` (Claude convention), `recommended: true`, label = "Anthropic API"). Flip wizard default at `OnboardingWizard.tsx:109` + `:288` from `claude_local` to `anthropic_api`.

3. **Test plan**:
   - Spin up wizard with a known-bad Anthropic key → server returns 422 → wizard blocks at step 2 (the gate fix already handles this; new tile just adds the path).
   - Spin up with a known-good key → status pass → wizard advances → agent created with `adapterType: "anthropic_api"` → fire wakeup → confirm Anthropic API is hit (not the CLI, not OpenAI).
   - Deploy to Fly canary → run the existing post-deploy auth canary → confirm no `no_api_key` or `claude_binary_not_found` errors.

**Estimated next-session effort:** ~1 day (was ~5h in the original Scope A — the +5h delta is building the missing server-side adapter that the plan incorrectly assumed already existed).

**Why this is now the right shape:** stopping the bleeding without shipping a worse bug, while leaving a precise blueprint for the proper fix. The gate-only PR is small enough to land today without a separate code review cycle; the anthropic-api adapter is large enough that it deserves its own PR + adversarial review (council recommended given it touches auth + adds a third-party SDK dep).
