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

Two complementary audits produced on 2026-05-10:

**`.planning/DESIGN-AUDIT-2026-05-10.md` — visual + conversion lens.** Tone of an ex-Stripe designer: copy, type, accessibility, conversion cliffs. Top 10 fixes ranked by impact/effort, all UI-side.

**`.planning/PRODUCT-AUDIT-2026-05-10.md` — product + UX lens.** Tone of an ex-Notion designer: JTBD coverage, glossary land mines, recovery-from-failure. Top 5 P0 actions ranked by ROI per engineering hour.

### Combined fix list status (verified 2026-05-12)

**6 of 7 cheap audit items already shipped** in the 2 days since the audit. One remaining + bigger P0s still open:

| # | From | File | Status |
|---|---|---|---|
| 1 | Product | `ui/src/main.tsx:8/47/77` | ✅ shipped — `ErrorBoundary` wraps `<App />` |
| 2 | Design | `ui/src/pages/Auth.tsx:170` | ✅ shipped — copy reads "connect your AI provider" |
| 3 | Design | `ui/src/pages/Landing.tsx:286` | ✅ shipped — "Measurable revenue growth in 14 to 30 days" |
| 4 | Product | RunnerStatusBanner | ⏳ open — "Your runner is not connected" persistent banner (2-3 hr) |
| 5 | Product | `ui/src/pages/Landing.tsx:1093` | ✅ shipped (de-escalated) — FAQ now reads "Coming soon — email hello@founderos.dev for manual export". No more false advertising |
| 6 | Product | Sidebar Inbox + count endpoint | ⏳ open — notification badge polled 30s (3-4 hr) |
| 7 | Design | `ui/src/pages/Auth.tsx:174-207` | ✅ shipped — tab buttons use `min-h-[40px]` + `px-4 py-2` |
| 8 | Design | `ui/src/pages/Landing.tsx:205-211` | ✅ shipped in this PR — `min-h-[44px] flex items-center` on each nav `<a>` |
| 9 | Product | Onboarding adapter chooser | ⏳ open — rewrite with per-tile requirements + disable broken tiles (4-6 hr) |
| 10 | Design | `ui/src/App.tsx:332,670` | ✅ shipped — `NotFoundPage` mounted at both board and global catch-alls |

**The remaining three open items** (#4 RunnerStatusBanner, #6 notification badge, #9 adapter chooser rewrite) are the bigger P0s — collectively ~10 hr. The cheap cluster is now closed.

The earlier CONTINUE.md claim of "neither shipped yet" was wrong — the prior session didn't verify against current code. Lesson: always grep current state before declaring audit findings open.

## Active threads (blocking-ranked)

### 1. Canary 401 on `/api/companies` — ROOT CAUSE FOUND ✅

**It's a spec race, not a prod auth bug.** Confirmed 2026-05-12 by cross-referencing `gh run list` (3/8 runs succeed, 5/8 fail — pattern rules out hard config issue) and reading `e2e/tests/auth-round-trip.spec.ts:86-95`.

`page.waitForResponse` is registered BEFORE the sign-in button is clicked. Its predicate matches the FIRST `/api/companies` GET after promise creation. When a React effect on the `/auth` page mount (or the redirect-transition state) fires a `GET /api/companies` before the Supabase JWT is stored client-side, that pre-auth call correctly returns 401 — and the spec catches THAT response instead of the real post-auth one.

**Fix in this PR:** filter the predicate on `Authorization: Bearer ...` header presence. Pre-auth fetches are ignored (no bearer header); real bearer-token regressions still trigger via the 20s timeout. Same pattern as the "1-strike public probe → structural false positive" invariant from the sales-agent-publisher cloudflared incident.

Prod auth is healthy. The canary was paging on-call ~5×/day for a test-layer race.

Also fixed in this PR: `docs/runbooks/auth-canary.md` updated from documented `canary@founderos.dev` to the actually-provisioned `bajajvinamr+canary@gmail.com`.

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
