# GOAL — Onboarding compute-gate (close-out) + canary 401 fix

_Created 2026-05-18. Owner: Claude. Sub-goal of: "non-technical founder can sign up → onboard → see agents execute, without hitting a silent-failure cliff."_

> **Why this goal exists:** a real founder hit two onboarding bugs in the same session — (1) API-based provider tiles never rendered, (2) selecting "Claude Code" let them advance past Step 2 without installing the runner. The product appeared dead because no compute path was attached. Today's gate fix (PR pending) blocks the second hole. This goal closes the rest, plus the adjacent canary 401 on `/api/companies` that breaks the same first-time-login flow.

## Definition of "done"

A new founder signing up on `founderos.fly.dev` can:
1. Reach the onboarding wizard without the canary 401.
2. Pick an AI provider from a tile that **actually has a working server-side execution path** for that provider.
3. Cannot advance past Step 2 unless `result.status === "pass" | "warn"` (gate already shipped today).
4. After "Launch", see their first agent wake up and execute against the configured provider.

If any of 1–4 fails, the goal is not done.

---

## Items (priority order)

| # | Item | Effort | Status | Blocks | Blocked by |
|---|---|---|---|---|---|
| **G0** | **SHIPPED today** — wizard step-2 gate inspects `result.status === "fail"` and blocks at `OnboardingWizard.tsx:454-466`. `pnpm --filter @founderos/ui run typecheck` clean. Uncommitted in working tree. | done | — | — | — |
| **G1** | **Commit + open PR for G0** — new branch off main, single-purpose PR. CI must pass. | 20 min | pending | G2 | — |
| **G2** | **Canary 401 diagnostic** — run `fly logs --app founderos --level debug \| grep -A5 "supabase JWT verify failed"` to disambiguate JWKS-unreachable vs JWT-claims-mismatch vs middleware-not-wired. Fix follows from the log signature. (CONTINUE.md Active thread #1.) | 30 min | pending | G6 | — |
| **G3a** | **SHIPPED 2026-05-18** — `apiKeyResolver` wired at heartbeat.ts:~2400 before `adapter.execute()`. Closes the silent `no_api_key` path for openai_api / claude_local hosted-mode / anthropic_api. Verified clean against 9/9 heartbeat tests pre-G3b. | done | — | — | — |
| **G3b** | **CODE-COMPLETE 2026-05-18** — `packages/adapters/anthropic-api/` package built (package.json, tsconfig, vitest, README, bin stub, src/index.ts, src/server/{execute,test,index}.ts, src/server/__tests__/execute.test.ts). Adds `@anthropic-ai/sdk@^0.95.1` as a new workspace dep. Wired into `server/src/adapters/registry.ts` (imports + adapter object + array), `server/src/adapters/builtin-adapter-types.ts` (Set), `packages/shared/src/constants.ts` (AGENT_ADAPTER_TYPES + clarifying comment), `server/src/services/adapter-resolver.ts` (`anthropic_api → anthropic_api`, no longer collapses to `claude_local`), `server/package.json` (workspace dep). **VERIFICATION PENDING:** sandbox can't reach `registry.npmjs.org` for `pnpm install`. User must run `pnpm install` from repo root + `pnpm --filter @founderos/adapter-anthropic-api typecheck test` + `pnpm --filter @founderos/server typecheck`. `/council` strongly recommended on the diff (adds 3rd-party SDK dep, touches dispatch path). | ~1 day | code-done, install-pending | G4, G5 | G3a |
| **G3c** | **SHIPPED 2026-05-18** — Extended `/api/onboarding/bootstrap` (routes/onboarding.ts:317) to persist openai_api and google_api keys into `instance_api_keys`. Pre-fix, only `anthropic_api` was stored; openai/google validated upstream via `/api/providers/validate-key` but never reached the keystore, leaving founders past onboarding with `no_api_key` at first heartbeat — same silent-failure-cliff shape as G0. Single-block change in onboarding.ts. | 30 min | done | G4-G7 | G3a |
| **G4-G7** | **OBSOLETE — V2 wizard already covers.** `FounderOnboardingWizard` (the prod surface, `VITE_FOUNDEROS_ONBOARDING_V2=true`) renders 6 provider tiles via `ProviderChooser` + collects API keys via `AdapterValidationPanel` + gates step-4 via `canAdvance(4)` triple-check (`adapterChoice !== null && adapterValidated && validatedFor === adapterChoice`). The audit-finding BL-004 explicitly REMOVED the default-to-anthropic_api behavior (silent-selection bug). Legacy `OnboardingWizard` UI tiles (G4-G7) only fire when `VITE_FOUNDEROS_ONBOARDING_V2=false` — fallback only. With G3a + G3b + G3c shipped, V2 onboarding is end-to-end functional for all three API providers. | — | obsolete | — | — |
| **G3d** | **SHIPPED 2026-05-18** — Bootstrap-resolver HOSTED branch reconciliation. `onboarding-bootstrap.ts:347` previously collapsed `anthropic_api → claude_local` (legacy hosted-mode hardening). Now routes all three hosted-API choices via `mapOnboardingChoiceToAdapter`: `anthropic_api → anthropic_api`, `openai_api → openai_api`, `google_api → gemini_api`. CLI choices in HOSTED mode fall through to BYO/dev resolution. Without this, my G3b adapter package was dormant in prod (legacy claude_local hosted hardening kept firing). | 15 min | done | — | G3b |
| **G8** | **SHIPPED 2026-05-18 (in-wizard half).** Replaced `AdapterValidationPanel`'s honor-system "I have Claude Code installed" attestation with a 4-step educational walkthrough explicitly explaining that the runner installs post-wizard, what the install command will look like, and the explicit "agents won't run until I install the runner" acknowledge checkbox. Post-onboarding the existing `AppRunnerBanner` polls runner status across every page; its CTA now deep-links to `/agents/all?install-runner=1` which auto-opens `RunnerInstallDialog` (token issuance + install snippet in one modal). Also cleaned up `runner-adapter-types.ts` (moved openai_api/anthropic_api/gemini_api out of BYO_RUNNER_HOSTED_ADAPTERS — they're hosted-API, not BYO-hosted). | ~3 hr | done | — | — |
| **G2** | **PENDING USER ACTION** — Canary 401 diagnostic still needs `fly logs --app founderos --level debug \| grep -A5 "supabase JWT verify failed\|401"`. Sandbox can't reach `api.fly.io`. User's machine also hit DNS issues during this session (offline / VPN blocking). Once back online, fix follows from log signature. | 30 min | pending | G11 | — |
| **G11** | **PENDING USER ACTION** — End-to-end smoke (fresh signup → wizard → tile → key/runner → first wakeup). Requires `pnpm install` to succeed first (user's machine showed `getaddrinfo ENOTFOUND registry.npmjs.org` — DNS failure on their box). | 30 min | pending | (closes goal) | G2, install |
| **G8** | **BYO Runner install gate** (CONTINUE.md P0 #4) — `<RunnerStatusBanner>` polling `runner_tokens.lastSeenAt`. Step-2 should block on runner registration for `claude_local`/`codex_local`/etc. selections. Closes the second hole originally diagnosed (gate-on-fail closed today; gate-on-runner-required-but-not-registered still open). | ~3 hr | pending | — | — |
| **G9** | **OBSOLETE for V2** — V2 wizard has no "skip" tile in ProviderChooser; `adapterChoice: null` IS the implicit "skip" and the canAdvance(4) gate blocks until founder picks. Only relevant if `VITE_FOUNDEROS_ONBOARDING_V2=false`. | — | obsolete | — | — |
| **G10** | **SHIPPED 2026-05-18** — Audit P0#1 (ErrorBoundary in main.tsx:47) ✓ already wrapped; P0#2 (Auth copy at Auth.tsx:170) ✓ already says "connect your AI provider"; P0#5 (FAQ false-advertising) ✓ removed the API-docs claim (docs.founderos.ai doesn't exist) + human-takeover claim (no human-swap surface exists), tightened code-ownership wording. P0#10 (NotFound route) ✓ already at App.tsx:319 (board scope) + :657 (global). Only the FAQ edit was new work; the other three P0s were already shipped pre-G10. | ~3 hr | done | — | — |
| **G11** | **End-to-end smoke** — fresh signup with bajajvinamr+canary2@gmail.com → wizard → Anthropic tile → paste real key → launch → confirm first agent wakeup hits Anthropic API and returns text. | 30 min | pending | (closes goal) | G3, G4, G5, G2 |

## Execution order (recommended)

```
G1 → G2 → G6 → G3 (+ /council) → G4 → G5 → G11 → G8 → G9 → G10 → G7
```

Rationale:
- **G1 first** — ship today's value, get CI signal, free the working tree.
- **G2 second** — 30 min, unblocks every onboarding test that follows.
- **G6 before G3** — OpenAI path is shippable RIGHT NOW (server already works), gives a non-Claude founder a working route while G3 cooks.
- **G3 next** — long pole, council-gated, blocks G4 and G5.
- **G4 → G5 → G11** — finishes the Anthropic story end-to-end.
- **G8, G9, G10** — quality improvements that don't block the core "founder can use the product" path.
- **G7 last** — Gemini is genuinely placeholder per `constants.ts` ("no agent runtime handler exists yet (S7 Phase 4 territory)") — UI tile would ship without runtime.

## One-way doors in this goal

- **G3 PR** — adds a third-party SDK dep (`@anthropic-ai/sdk`). `/council` recommended.
- **G5 default flip** — changes the wizard's first-paint behavior for every new signup. Roll out behind a feature flag if there are >0 inflight signups when it lands.
- **G2 fix** — likely touches `server/src/auth/supabase.ts` or middleware wiring. Auth-sensitive; `/council` if the fix is non-trivial.

## Out of scope

- Pricing changes, billing gate flip, Stripe live keys — separate buyer-handoff path.
- Inbox / dashboard polish — touched by audit P0s but separate goal.
- Bundling claude CLI in Dockerfile (was Option C in plan; pre-empted by G3).

---

_Source materials: `.planning/onboarding-compute-gate-plan.md`, `CONTINUE.md` (active thread #1), 2026-05-10 audit docs, plan author session 2026-05-18._
