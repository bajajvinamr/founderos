# SYNTHESIS-PHASE1 — Buyer-Demo Readiness Fix Queue

**Generated:** 2026-05-19 (synthesizer pass over 5 of 6 audit docs in `.planning/`)
**Inputs:** `CODEBASE-GRAPH.md` · `AUDIT-UI.md` · `AUDIT-SERVER.md` · `AUDIT-PROMISES.md` · `AUDIT-CONFIG.md`
**Pending:** `AUDIT-COVERAGE.md` (agent `a13aa26dca0e17d98` still running — appended once delivered)
**Contract authority:** `docs/adr/012-mvp-cutover-doubtbuddy.md` + `docs/ops/design-partner-onboarding-kit.md`

---

## TL;DR

The engineering side of the cutover is **structurally sound**. Server audit finds **zero P0 demo blockers** — no missing tenant guards, no Composio cross-org leak, no bypassable billing path. The buyer-demo risk clusters in three categories, in descending order of severity:

1. **Marketing/contract drift** (P0 — credibility cliff) — Landing.tsx + kit promises (3 vs 5 departments, $299 vs $500–1,000, 50k actions/mo with zero enforcement) contradict each other and the shipped product.
2. **UI dead-ends on demo journeys** (P0 — visible during demo) — Goals/Projects pages have no creation CTAs; 3 specialized department consoles ship 100% mock data with "Coming soon — Wave 5" toasts; 12 dead footer anchors on Landing.
3. **Demo-server config gaps** (P0 — feature dark on prod) — Stripe trio + `RESEND_API_KEY` + `EMAIL_UNSUBSCRIBE_SECRET` unset on Fly. Billing/email surfaces are silently dark.

**Score against G1–G8 acceptance gates:** G1 promised features (mostly Y, 3 broken), G3 demo script (blocked by P0s above), G4 P0/P1 bugs (16 open: 5 UI + 3 promise + 3 config + 5 server), G5 canary 401 (CLOSED — merged), G6 runner SIGKILL (worktree fix verified, not yet integrated to main), G7 config (3 P0s open), G8 docs (kit §2.1 has 2 doc-vs-code drift items).

**Time to demo-ready:** ~6–8 focused hours of UI fixes + ~30 min of `fly secrets set` (requires buyer's Stripe + Resend keys) + buyer answer on 2 contract questions (departments count, actions/mo metering posture). The big unknown is whether the buyer **wants 3 or 5 departments** in their pricing tier — that's a sales conversation, not an engineering one.

---

## Cross-audit contradiction (must reconcile)

`AUDIT-CONFIG.md` §7 row "Webhook raw-body mount" claims kit §2.1 references `routes/webhooks/stripe.ts` and verdicts ✅ "matches invariants doc."

`AUDIT-PROMISES.md` row 11 + §5 correctly identifies that `server/src/routes/webhooks/stripe.ts` **does not exist**; the actual handler is at `server/src/routes/billing.ts:165` and the raw-body capture mechanism is `express.json({ verify })` not `express.raw(...)` ordered before `express.json()`.

**Promise audit is right.** Config audit's "current verdict" on kit §2.1 should be downgraded to "PARTIAL — paths drift, mechanism equivalent." Fix in the kit doc (point at `routes/billing.ts:165` and document the `verify` callback pattern instead).

---

## P0 Fix Queue (must close before buyer demo)

Ordered by `(buyer-impact × ease-to-fix)`. Each row tagged with effort estimate + who has to do it.

| # | Item | Source | Effort | Authority | Status |
|---|---|---|---|---|---|
| 1 | **Goals page: mount NewGoalDialog + "+ New Goal" button** | UI P0-C | 20 lines, ~15 min | Me | TODO |
| 2 | **Projects page: mount NewProjectDialog + "+ New Project" button** | UI P0-D | 20 lines, ~15 min | Me | TODO |
| 3 | **Landing footer: hide or mailto/redirect 12 dead anchors** | UI P0-E | ~40 lines, ~20 min | Me | TODO |
| 4 | **DepartmentConsole: collapse KPIs/Workflows/Decisions tabs on non-specialized depts** | UI P0-B | ~30 lines, ~30 min | Me | TODO |
| 5 | **Department consoles (CRM, Content, Finance): gate mocked widgets behind connect-prompt empty-state** | UI P0-A | ~150 lines (3 files), ~90 min | Me | TODO — cheapest version: redirect those routes to `/departments/growth` until S4 lands |
| 6 | **`fly secrets set EMAIL_UNSUBSCRIBE_SECRET=$(openssl rand -hex 48)`** | Config P0 #3 | 1 command | Me, with confirm | NEEDS CONFIRM |
| 7 | **`fly secrets set STRIPE_SECRET_KEY=… STRIPE_WEBHOOK_SECRET=… STRIPE_PRICE_ID_PRO=…`** (test keys for demo) | Config P0 #1 | 1 command | User (provide keys) | BUYER INPUT NEEDED |
| 8 | **`fly secrets set RESEND_API_KEY=…`** | Config P0 #2 | 1 command | User (provide key) | BUYER INPUT NEEDED |
| 9 | **Kit doc fix: §2.1 paths point at `routes/billing.ts:165` + `app.ts:186-192` verify callback** | Promise P0 #3 / Doc drift | ~50 lines kit edit | Me | TODO |
| 10 | **Pricing reconciliation: Landing says $299, kit sells $500–1,000** | Promise P0 marketing | Decision then ~10 lines edit | User decides which is true | BUYER INPUT NEEDED |
| 11 | **Departments count reconciliation: kit says "3", product ships 5+2** | Promise P0 #1 | Decision then ~5 lines kit edit OR feature-flag 2 depts off for Beta | User decides | BUYER INPUT NEEDED |
| 12 | **"50,000 actions/mo" promise vs zero enforcement** | Promise P0 #2 | Decision: (a) drop the number from copy, (b) ship counter, (c) manual invoice | User decides; (a) is cheapest | BUYER INPUT NEEDED |
| 13 | **Integrate runner SIGKILL fix from worktree → fix/runner-sigkill-escalation branch off main** | GOAL G6 (independent of audits, but blocks v0.1.2 publish) | Cherry-pick + reconcile spawn-e2e.test.ts (a-g already on main) + test (h) un-skip + bump version + `pnpm publish` | Me + /council per CLAUDE.md dispatcher rule | NEXT |

**Total Me-only effort:** ~3 hours UI + ~1 hour kit doc + ~30 min runner integration ≈ 4.5 hours focused work.
**Total Buyer-input items:** 4 decisions + 3 keys.

---

## P1 Queue (close pre-demo if time, else doc as known-gap)

| # | Item | Source | Why P1 not P0 |
|---|---|---|---|
| P1-1 | `/api/billing/status` + `/checkout` lack `assertBoard` | Server F-2 | Webhook is sig-verified; LLM-cost gate at `wakeup`+`heartbeat/invoke` IS closed. Risk is rate-limit-only on unauth surfaces. |
| P1-2 | ~348 direct 4xx `res.status().json()` responses bypass `errorHandler.withRequestId` | Server F-1 | Doesn't break demo; support-time slowdown post-demo |
| P1-3 | ~200 mutating routes skip `validate(schema)` middleware | Server F-6 | Drizzle's runtime narrows shapes; buyer won't hit edges |
| P1-4 | `Alerts.tsx` 2 of 4 tabs are explicit "Coming soon — activates after S2.7/S3.2" placeholders | UI P1 | Already framed as roadmap; buyer-acceptable if not clicked into |
| P1-5 | `Dashboard.tsx` `CapitalAllocationCard` is a placeholder S1.2 widget | UI P1 | Visible on every dashboard load |
| P1-6 | `AiConnections.tsx` is half-placeholder (default-for-new-work picker disabled) | UI P1 | Nested in instance settings; lower discovery rate |
| P1-7 | Landing hardcoded social proof — "18 founders live", three fake testimonials | UI P1 + Promise P1 | Sophisticated buyer may dismiss; could soften to "Early access · Est 2026" |
| P1-8 | Landing claim: "your company gets its own Fly machine and its own Postgres" vs shared-instance reality | Promise §4 row 4 | Per-tenant isolation IS real at DB-row level; copy implies infra-level isolation |
| P1-9 | Landing FAQ "Company export — Coming soon" but export IS shipped | Promise §4 row 5 | Stale doc — delete the FAQ line |
| P1-10 | Landing claim: "If one provider goes down, the next one picks up." No multi-provider fallback router found | Promise §8 | Strongest unsupported claim after per-tenant-Fly-machine |
| P1-11 | V2 onboarding wizard does not hydrate from `onboarding_drafts` on reload | UI P1 + Promise row 15 + CLAUDE.md | Cleanly deferred to v1.1 per ADR-012 |
| P1-12 | `Today.tsx` Friday weekly link is `<a href="#weekly">` with no matching anchor | UI P2 | 1-click broken; lower-discovery |
| P1-13 | `/c/:trackingId` public redirect has no rate limit | Server F-4 | DB-write per click vulnerable to bot-scrape |
| P1-14 | `integrationDlqRoutes` is defined but never mounted in `app.ts` | Server F-3 | Dead code; future "I'll wire this" is a P0 risk |

---

## v1.1 deferred items per ADR-012 — re-confirmation needed

These are documented deferrals from the buyer contract. **All confirmed deferrable per ADR-012; do NOT panic-build.** But surface explicitly in the buyer's hand-off:

1. **UI bell + WS push** — **HALF-SHIPPED:** `NotificationBell.tsx` IS mounted in `BreadcrumbBar.tsx` and runs 30s REST poll. Only WebSocket push is missing. Re-confirm with buyer that polling-only counts as "shipped."
2. **Slack daily summary cron** — cleanly deferred. `deliverMorningBriefToSlack()` reachable only via manual `routes/integrations.ts:131`.
3. **Email-template magic-link issuance** — cleanly deferred. Service exists; no email transport mounts a template.
4. **`/brief` route token consumption** — cleanly deferred. Authenticated `/brief` works.
5. **Wizard draft hydration** — cleanly deferred. Backend route lives at `routes/onboarding-draft.ts:35`; V2 wizard does not call it on mount (documented in `FounderOnboardingWizard.tsx:290-293`).
6. **Embedder for memory cosine recall** — cleanly deferred. No vector pipeline.

---

## Decisions the buyer (or you-as-buyer-proxy) must make

Bundled here so they can be answered together rather than one at a time:

1. **Pricing public face:** Landing shows $299/mo Solo Founder; kit sells Beta at $500–$1,000. Pick one truth.
   - (a) Landing is right → edit kit to $299. Risk: buyer may resist a price-down narrative.
   - (b) Kit is right → edit Landing Pricing section to $500–$1,000 or remove the $299 number. Risk: public reduces conversion.
   - (c) Both are right (two tiers, Solo + Beta) → keep both but make the distinction explicit on Landing.
2. **Departments count in Beta tier:** Kit says "3"; product ships 5 always-on + 2 opt-in.
   - (a) Match kit: feature-flag 2 of the 5 always-on off for Beta tenants. Engineering work.
   - (b) Match product: edit kit to say "5 core + 2 opt-in." Doc-only change.
   - (c) Hide the count from the kit; sell on departments-shipped-this-week instead. Doc-only + a small narrative shift.
3. **"50,000 actions/mo" inclusion:** No metering exists.
   - (a) Drop the number from copy — say "high-volume" or "unmetered during Beta." Cheapest.
   - (b) Ship a counter: action-log table + heartbeat-layer increment + display in `CompanySettings`. ~4 hours.
   - (c) Honor-system: manually invoice for overage. Doc-only but bills can surprise the buyer.
4. **Demo environment posture:** Demo on `founderos.fly.dev` (shared) or stand up a `doubtbuddy.fly.dev` whitelabel? — already implicitly answered "founderos.fly.dev" but worth re-confirming with buyer.
5. **Composio toolkits to demo:** All 8 (slack, gmail, github, googlecalendar, googlesheets, googledrive, notion, linkedin) or a subset?

---

## Recommended sequencing (next 24h)

```
Now (no buyer input needed)
  ├─ Branch off main: fix/buyer-demo-readiness-p0s
  ├─ Fix P0-C (Goals "+ New Goal")
  ├─ Fix P0-D (Projects "+ New Project")
  ├─ Fix P0-E (Landing footer dead anchors)
  ├─ Fix P0-B (DepartmentConsole tabs)
  ├─ Fix P0-A (Department consoles connect-prompt — cheap version: redirect)
  ├─ Edit kit §2.1 path/mechanism drift
  ├─ Commit + open PR → CI gates pass → merge to main → deploy-prod
  └─ /council on the PR per CLAUDE.md dispatcher rule (only the SIGKILL fix is the dispatcher hot path; this PR doesn't touch dispatcher so council is optional)

Parallel (separate branch + PR)
  ├─ Cherry-pick runner SIGKILL fix from worktree-agent-afb91fbb1de41666f
  ├─ Reconcile spawn-e2e.test.ts (a-g exist on main, test h needs un-skip)
  ├─ /council per dispatcher hot-path rule
  ├─ Bump @founderos/runner to 0.1.2
  └─ pnpm publish (NEEDS USER CONFIRM)

Then (needs buyer input)
  ├─ Resolve the 4 contract decisions above
  ├─ Get Stripe test-mode trio + RESEND_API_KEY from buyer
  ├─ fly secrets set (NEEDS CONFIRM — this is "push to remote")
  └─ Generate + set EMAIL_UNSUBSCRIBE_SECRET locally (NEEDS CONFIRM)

Then (Phase 3 — dress rehearsal)
  ├─ Build 7 critical-flow Playwright scripts (one per demo journey)
  ├─ Capture screencasts/screenshots at 375 + 1440
  └─ Write .planning/DEMO-SCRIPT.md walkthrough

Then (Phase 4 — hand-off)
  ├─ Final 5-min smoke on founderos.fly.dev
  ├─ Send buyer: PR list, demo URL, demo script, kit, CONTINUE.md
  └─ Open "Buyer Sign-Off" tracking issue
```

---

## Open question for the user (only ONE — others can be batched)

**The cheapest path to demo-ready is to keep the buyer contract intact and fix only the visible-during-demo P0s.** That means:
- Fix P0-C, P0-D, P0-E, P0-B, P0-A (UI), and the kit §2.1 doc drift NOW.
- Accept the pricing/departments/actions contradictions as **doc fixes after demo**, NOT engineering work pre-demo.
- Set Stripe **test-mode** keys for the demo, not live keys. (Per ADR-012 — live keys are post-buyer-sign one-way door.)

If that's right, I proceed without further questions on the UI fixes + kit doc + runner SIGKILL integration. The Stripe/Resend keys + final pricing decisions wait for the buyer.

**Alternative:** if you want me to also do (b) ship the actions/mo counter or (b) feature-flag 2 departments to match the kit → that's engineering work to add to the queue. Speak up if so.

---

---

## Appendix A — Coverage findings (folded in 2026-05-19 after agent `a13aa26dca0e17d98` returned)

### State of the world

| Package | Line% | Branch% | Notes |
|---|---:|---:|---|
| server | 55.00 | 67.47 | Solid for a route-heavy package |
| ui | **21.75** | 66.16 | Dominant gap |
| runner | 74.35 | 66.97 | Recent E2E uplift (G2 work) |
| shared | 78.57 | 71.25 | Mostly clean |
| db | 23.40 | 66.09 | Misleading — 11 seed files (~8.6K lines) dominate denominator. Excluding seeds, db is ~80% |
| templates | 99.66 | 100.00 | At target |
| adapter-api-* (anthropic/openai/gemini) | 54–62% | — | Small surface, three of three new since 2026-05-18 |
| adapter-cli-* (claude/codex/opencode/pi) | 15–29% | — | E2E layer missing — same pattern as runner before this week |

**Weighted global: ~40% line / 67% branch.** The path to 99% line goes through `ui/`. There is no other way.

### Top 5 critical-path coverage gaps (RED on demo journeys)

| # | File / journey | Status | Why it matters |
|---|---|---|---|
| 1 | `ui/src/pages/Auth.tsx` (0% line, no `Auth.test.tsx`) | RED on signup journey #1 | Server has `auth-*.test.ts`, UI shell is naked |
| 2 | Goals service + routes — **no `goals.test.ts` server-side, no Playwright spec** | RED on goals journey #6 | Both UI P0-C (this synthesis) and coverage agree: goals is the most exposed end-to-end |
| 3 | `ui/src/pages/Agents.tsx` (0%) | RED on agents journey #3 | Server has 20+ agent tests; UI page has zero |
| 4 | `ui/src/pages/IssueDetail.tsx` (0%, 1995 uncovered lines) | YELLOW on inbox journey #5 | Largest single coverage gap in the repo |
| 5 | `server/src/routes/access.ts` (41.5%) | YELLOW | Security-critical permission enforcement under-tested |

### G2 acceptance gate — re-negotiation needed

**The GOAL doc target (99% line / 95% branch) is structurally infeasible inside the buyer-demo timeline.** Closing the gap requires lifting `ui/` from 22% → 85% (~270 files × component-test work × ~30 min/file ≈ 130+ hours of focused test writing). That's not a buyer-demo-blocking effort — that's a multi-week quality sprint.

**Three honest paths forward** (recommended ordering):

| Option | Target | Effort | Buyer-demo impact |
|---|---|---|---|
| (a) **Council §1 floor: UI 80/70, server 90/80, global ~75%** | Realistic in 2-3 days of focused test work | ~25 hours | None — buyer doesn't see coverage |
| (b) **Critical-path-only: 100% on the 7 demo journeys via Playwright + RTL** | Per-journey gates, not per-file | ~12 hours (Playwright is most leverage per hour) | High confidence in demo flow correctness |
| (c) **Defer coverage closure to post-buyer-sign sprint** | Document current state in CONTINUE.md; revisit after demo | 0 hours pre-demo | Acceptable — coverage is internal hygiene, not a buyer promise |

**Recommendation:** (b) + (c). Build the 7 Playwright critical-flow specs (Phase 3 of GOAL doc) as the demo-readiness gate; defer broader UI coverage work to a v1.0.1 sprint. **Update G2 in `GOAL-buyer-demo-readiness.md` accordingly.**

### Exemptions to apply now (low-risk, high-impact denominator cleanup)

These are recommended by the coverage audit as legitimate exemptions per the council §2 policy. Each tightens the global percentage without writing a single test:

| Path | Reason |
|---|---|
| `packages/db/src/seed-*.ts` (11 files, ~8.6K lines) | Demo seeds, non-shipping |
| `packages/plugins/examples/**` | Buyer-facing demo plugins |
| `ui/src/components/ui/**` (22 shadcn primitives) | Library code, not application logic |
| `ui/src/pages/DesignGuide.tsx` | Internal dev surface |
| `ui/src/pages/Landing.tsx` | Covered by Playwright `critical-flows.spec.ts` |
| `ui/src/components/OnboardingWizard.tsx` + `OnboardingWizardNew.tsx` | Legacy variants; V2 is canonical |
| Build/lint configs | Per-file `/* c8 ignore file */` with comment |

**Effort:** ~30 min to add `coverage.exclude` entries + write the policy doc at `docs/runbooks/test-coverage-policy.md` per G2 of the GOAL.

### Adapter naming inconsistency (separate task)

`packages/adapters/gemini-api` uses bare `@founderos/gemini-api`; rest use `@founderos/adapter-*`. Standardize so `pnpm --filter '@founderos/adapter-*' exec vitest run --coverage` works as one batch. Side benefit: future coverage reporting is one command, not nine.

---

## Appendix B — Updated open question (consolidated)

Of the 5 questions in the main synthesis body, one is now elevated by the coverage data:

**Q (new): G2 coverage target.** Do you want to (a) keep 99/95 as the stated goal and accept this is multi-week work, (b) downgrade G2 to "80/70 UI + 90/80 server + critical-path Playwright" and ship a coverage-policy doc, or (c) defer coverage to post-buyer-sign entirely?

My recommendation is (b) — gives a defensible floor without burning days of demo-prep on test writing. Combined with the existing (a) recommendation in the body ("UI P0 fixes only, doc drift, runner SIGKILL"), this is the cheapest path to a demo-ready buyer hand-off.

---

## Appendix C — Council verdict on this synthesis (2026-05-19, FULL mode)

**Verdict:** **BLOCK** — synthesis missed two demo-blocking items + mis-classified one P0 as v1.1 deferred. Re-rank P0 queue before continuing implementation.

**Mode:** FULL (Codex `gpt-5.4` + Gemini `gemini-2.5-pro`, both healthy)
**Rounds:** R1 + R2 converged (R2 surfaced 2 net-new P2s, no new P1s)

### Confirmed by both models

1. **[P1] Self-serve company-creation path is broken.** `Layout.tsx:140` suppresses auto-open of `FounderOnboardingWizard` for `deploymentMode === "authenticated"` (the hosted Fly mode). `Dashboard.tsx:108-110` renders **`OnboardingWizardNew`** for zero-company users — a third wizard variant. The V2 wizard hardening we shipped applies only to `/onboarding` route, not to the actual self-serve zero-company landing flow. **Verified via Read of Layout.tsx:138-145 + Dashboard.tsx:108-115.**
2. **[P2] Runner SIGKILL fix should be in the first P0 tranche.** It's the only listed item that directly blocks "first agent run" (step #9 of the self-serve flow). Fix exists in worktree-agent-afb91fbb1de41666f.
3. **[P2] Kit §2.1 is NOT just doc drift.** `routes/health.ts` exposes no `stripe_connectivity` probe but kit §2.1 asserts that signal exists. Either (a) implement the probe in `/api/health/deep`, or (b) change the kit's checklist signal to `/api/billing/status` + signed-webhook smoke.
4. **[P2] G2 coverage downgrade unsafe without Auth.tsx Playwright spec.** `ui/src/pages/Auth.tsx` at 0% line coverage + no dedicated forgot-password E2E spec is a self-serve-journey blocker. The downgrade is defensible ONLY if Phase 3 Playwright work covers Auth + Agents page.
5. **[P2] V2 wizard draft hydration is P0, not v1.1.** Tab refresh wiping wizard state mid-onboarding is a self-serve conversion-killer.

### Disputed — resolved

- **Gemini R1 [P1] "no password reset flow"**: FALSE POSITIVE. `ui/src/pages/Auth.tsx:272`, `ForgotPassword.tsx`, `ResetPassword.tsx` exist. Codex caught the dispute. The real gap is (a) `e2e/tests/auth-round-trip.spec.ts:43` claims password reset coverage but no separate spec, (b) `docs/runbooks/user-guide.md:249` stale text says password reset isn't self-serve.

### New in R2

- **[P2] (Codex)** `e2e/tests/auth-round-trip.spec.ts:43` falsely claims forgot/reset coverage. Add a dedicated recovery E2E or remove the misleading claim.
- **[P3] (Codex)** `docs/runbooks/user-guide.md:249` stale "password reset isn't self-serve" line — UI does expose self-serve reset.
- **[P2] (Gemini, DISPUTED — unverified)** Claims `server/src/routes/providers.ts:98` returns 500 on empty data. Verified line 98 is part of `validate-key` error handler, NOT a `GET /api/providers` list endpoint. **Treat as unverified.**

### Re-ranked P0 queue (final, post-council)

| # | Item | Source | Effort | Authority |
|---|---|---|---|---|
| 1 | **Self-serve company-creation flow: verify `OnboardingWizardNew` works for self-serve hosted users OR route them to V2 path** | Council P1 | 2-3 hr (trace deps + fix) | Me |
| 2 | **Runner SIGKILL 0.1.2 fix + publish** | GOAL G6 + Council P2 | Cherry-pick + reconcile + publish | Me |
| 3 | **V2 wizard draft hydration on mount** | Council P2 (was P1 v1.1) | ~1 hr | Me |
| 4 | **Kit §2.1: implement `stripe_connectivity` probe OR change kit signal** | Council P2 | ~1 hr | Me |
| 5 | Auth.tsx + ForgotPassword + ResetPassword Playwright round-trip | Council P2 | ~2 hr | Me |
| 6 | Goals/Projects creation + Landing footer + DepartmentConsole | UI P0-A through E | Done in PR #267 | Done |
| 7 | Set Stripe + Resend + EMAIL_UNSUBSCRIBE_SECRET on Fly | Config P0 | 30 min once keys are in hand | User → Me |
| 8 | Remove `auth-round-trip.spec.ts:43` stale claim OR add spec | Council R2 P2 | 30 min | Me |
| 9 | Update `docs/runbooks/user-guide.md:249` stale text | Council R2 P3 | 5 min | Me |

### Model health (Tier 6 #17 — mandatory)

- **Codex:** HEALTHY (model=gpt-5.4, R1≈68s, R2≈42s)
- **Gemini:** HEALTHY (model=gemini-2.5-pro, R1≈74s, R2≈58s)

### Synthesis: what matters most and why

The self-serve mandate exposed an audit blind spot we wouldn't have caught without council. Both models triangulated the same root cause from different angles — Codex traced the code path (`Layout.tsx:140` → `Dashboard.tsx:108` → `OnboardingWizardNew`), Gemini surfaced the lockout symptom. The V2 wizard hardening we shipped is for a route the self-serve buyer never lands on. **Before any kit/secrets work, verify which onboarding wizard a self-serve buyer actually sees** and make that path bulletproof. Doc/secret work is downstream of confirming the wizard variant.
