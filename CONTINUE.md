# CONTINUE.md — FounderOS next-step source of truth

_Last updated: 2026-05-12 by Claude. Active branch: `feat/redo-pr-163-adapter-registry`._

## State of the world (one-screen summary)

Prod is **live and healthy** on `founderos.fly.dev`. CI gates are functional after the 2026-05-07 billing restore. The autoloop scaffold is **stopped** (manual-sweep supersession on 2026-05-12) and its STATE.md is closed out on `chore/autoloop-scaffold`. Two audits from 2026-05-10 produced the most concrete usability roadmap to date — neither shipped yet. Canary 401 is the immediate prod-confidence gap.

## What's in flight

**Branch `feat/redo-pr-163-adapter-registry`** — Path A complete, ready to PR. Wires the `openai_api` + `gemini_api` adapters to a working `ServerAdapterModule` contract by adding `testEnvironment` + `models` + `agentConfigurationDoc` exports (matching `openclaw_gateway` shape — stateless API adapters omit `sessionCodec`). The original PR #163 was reverted-then-reapplied by the sweep loop and was leaving main typecheck-broken. Files: `packages/adapters/{openai-api,gemini-api}/src/{index.ts,server/{index.ts,test.ts}}` + registry import cleanup + `server/package.json` deps + `openai-api/package.json` `./server` subpath export. Full workspace `pnpm typecheck` green.

## Recent merges (last 7 days, ordered new→old)

| PR | What it shipped |
|---|---|
| #193 | `pnpm.overrides` → kysely `^0.28.17` (CVE patch); pnpm-lock regenerated; audit clean |
| #192 | Restore main typecheck after sweep loop's admin-bypass merges broke it (`dns/promises` LookupAddress import + 7 Express 5 `req.params` casts) |
| #191 | Reapply #163 adapter registry (typecheck-broken on its own; this branch fixes it) |
| #143 | Company memory CRUD UI (audit P0.3 fix) |
| #124 | Paperclip → Pulse design system migration P1+P2+P3 (closes #13) |

## The 2026-05-10 design audits — Stripe-style + Notion-style

Two complementary audits produced on 2026-05-10, both unshipped:

**`.planning/DESIGN-AUDIT-2026-05-10.md` — visual + conversion lens.** Tone of an ex-Stripe designer: copy, type, accessibility, conversion cliffs. Top 10 fixes ranked by impact/effort, all UI-side.

**`.planning/PRODUCT-AUDIT-2026-05-10.md` — product + UX lens.** Tone of an ex-Notion designer: JTBD coverage, glossary land mines, recovery-from-failure. Top 5 P0 actions ranked by ROI per engineering hour.

### Combined P0 fix list (cross-cutting from both audits)

| # | From | File | Change | Est |
|---|---|---|---|---|
| 1 | Product | `ui/src/main.tsx` | Top-level React `ErrorBoundary` — currently a render error shows a white screen. Single highest-leverage UX fix | 1 hr |
| 2 | Design | `ui/src/pages/Auth.tsx:169-170` | Replace "plug in your Anthropic key" with "connect your AI provider" — biggest non-tech conversion cliff | 5 min |
| 3 | Design | `ui/src/pages/Landing.tsx` (Hero) | Replace "Measurable MRR lift" with "Measurable revenue growth" | 5 min |
| 4 | Product | `ui/src/App.tsx` + new `RunnerStatusBanner` | Post-onboarding "Your runner is not connected" banner. Doesn't fix execution gap — makes it visible. Uses existing `runner_tokens.lastSeenAt` | 2-3 hr |
| 5 | Product | `ui/src/pages/Landing.tsx:1089` | Remove false-advertising FAQ item about company export (no export button exists). Or build a minimal export (4 hr) | 30 min |
| 6 | Product | Sidebar nav + new count endpoint | Notification badge on Inbox nav item, polled 30s. Data layer (S6.6) already exists | 3-4 hr |
| 7 | Design | `ui/src/pages/Auth.tsx:174-198` | Auth tab buttons `py-1.5 text-xs` → `py-2 text-sm` + `min-h-[40px]` wrapper. Currently 28px touch target | 10 min |
| 8 | Design | `ui/src/pages/Landing.tsx` TopBar | `min-h-[44px]` on nav `<a>` at `md` breakpoint. Currently 15px at 768px | 10 min |
| 9 | Product | Onboarding adapter chooser | Rewrite with required-setup-per-tile copy + disable tiles that lack working E2E path | 4-6 hr |
| 10 | Design | Router catch-all | `<NotFound />` for unknown routes instead of redirect-to-auth | 30 min |

**Roughly:** half a day of copy + accessibility fixes (#2, #3, #5, #7, #8, #10) closes the most glaring landing-page and auth gaps. The bigger P0s (#1, #4, #6, #9) are 1-2 days combined and decisively close the "non-tech founder can use this" gap.

## Active threads (blocking-ranked)

### 1. Canary 401 on `/api/companies` (post-deploy synthetic)

Investigation complete (sub-agent report 2026-05-12). User `bajajvinamr+canary@gmail.com` exists in Supabase auth + `public."user"` (Fly MPG) with owner membership in "Canary Co" (company `eeaeffa1-f9ce-4a41-88d6-83816dfc72bb`). The 401 means `req.actor.type === "none"` — Supabase JWT verification is failing OR the session resolver isn't being called.

**Two top hypotheses, ranked:**

1. **JWT verification failure** (highest probability). `verifySupabaseJwt()` returns null on any of: missing `SUPABASE_URL`, missing `SUPABASE_JWT_SECRET`, JWKS unreachable, expired/wrong-aud token. The 401 path triggers when `assertBoard(req)` sees `actor.type === "none"`.

2. **Race condition** in `maybeBootstrapNewUser()` post-signup hook — but that would produce 403, not 401. Lower probability given the 401 signature.

**Recommended next step (not yet executed):**
```bash
fly logs --app founderos --level debug | grep -A5 "supabase JWT verify failed"
```
Confirms whether the 401 is no-session or failed-JWT-decode. If logs show `code: "JWKS.*"` → `SUPABASE_URL` env unreachable. If `code: "JWTClaimsValidationFailed"` → aud/iss mismatch. If silent → middleware not wired.

Files involved: `server/src/routes/companies.ts:78`, `server/src/routes/authz.ts:4-11` (`assertBoard`), `server/src/middleware/auth.ts:33-302` (`actorMiddleware`), `server/src/auth/supabase.ts:339-346` (`resolveSupabaseSession`).

### 2. Hiring context — "2 engineers to redo the frontend"

You mentioned this in the prior session; no decisions.md entry, no docs reference, no memory match. **Need a pointer from you** — Slack thread? Linear ticket? Notion? Once located, surface candidates / scope / start date in CONTINUE.md.

### 3. Audit-driven UX work (from the table above)

Unowned. The 30-min cluster (#2, #3, #5, #7, #8, #10) is the cheapest forward step on real user-facing value. Could be shipped today in one PR.

## Founder-action gates outstanding (cannot be done by Claude)

These persist across sessions. Re-read at session start.

1. **Branch protection switches** — 5 toggles in GitHub UI per `docs/ops/branch-protection.md` (post PR #65).
2. **`FOUNDEROS_BILLING_GATE_ENABLED=1` in prod** — flip once Stripe webhook telemetry is clean.
3. **Stripe live keys** — one-way-door flip per `docs/ops/design-partner-onboarding-kit.md`.
4. **`FLY_API_TOKEN` + `VERCEL_TOKEN` + `SENTRY_AUTH_TOKEN` as GitHub secrets** — enables full release pipeline (Vercel mostly dead now per single-origin cutover, but Sentry sourcemap upload still relevant).
5. **Resend tier upgrade** — when active users hit ~30. Currently free tier 100/day.
6. **Council review of `PROJECT.md` and `ROADMAP.md`** — shadow council flagged 2026-05-06 (planning intent docs that name auth/session/payment/migration). Required before next implementation cycle (post-MVP / v1.1). 38 plans total flagged across the repo.

## Exact next step

Three forks, ranked by leverage:

| Path | Effort | Why pick this |
|---|---|---|
| **A.** PR Path A (adapter registry redux), then triage canary 401 by reading fly logs | 30 min + 30 min | Unblocks adapter dispatch typecheck on main; resolves the most critical prod-confidence gap. **Recommended.** |
| **B.** Ship the 30-min audit cluster (copy + accessibility fixes #2, #3, #5, #7, #8, #10) in a separate PR | 45 min | Tangible user-facing win in <1hr; works while CI runs on Path A |
| **C.** Open `/council` on the canary 401 + the OSS-extract decision from the prior conversation | varies | Saves regret on architectural calls; the canary touches auth |

The historical iteration ledgers (Dream-State LRP, audit-trail surface pinning, Day-7 PRD verification, Composio v3 migration notes) live in git history and `docs/retros/`. They have been pruned from this doc to keep it scannable.
