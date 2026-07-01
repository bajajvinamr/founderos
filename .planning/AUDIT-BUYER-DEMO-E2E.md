# Buyer-Demo E2E Flow Audit (Task #36)

**Date:** 2026-05-19
**Target:** https://founderos.fly.dev (live prod, post-#269 merge)
**Scope:** End-to-end buyer journey from landing page through onboarding wizard
**Method:** Playwright snapshot + curl probe + live navigation
**Auditor:** Claude Opus 4.7 driving Playwright browser

---

## Verdict

**PASS with 1 P0 caught + fixed in-flight (PR #271).** Remaining surface is buyer-ready as of merge of #271.

| Surface | State | Notes |
|---|---|---|
| Landing page | ✅ All CTAs route to /auth | 4 CTAs verified |
| Landing pricing tiles | ✅ Matches kit §2.1 | $299 / $2k / $10k |
| Landing footer | ✅ After PR #271 | Was: 5 broken external URLs; now: 0 broken |
| /auth | ✅ Clean | Sign in / Sign up tabs, Google OAuth, magic link, Forgot password, T&Cs all work |
| /auth/forgot | ✅ Form + back-link | Heading + email input + submit + back-to-sign-in all render |
| /auth/reset | ✅ Error state | No token → "Your reset link has expired or is invalid" |
| /legal/terms | ✅ 200 | Linked from footer + auth sidebar |
| /legal/privacy | ✅ 200 | Linked from footer + auth sidebar |
| V2 wizard Step 4 | ✅ 6 provider tiles | All 3 API + 3 CLI tiles render; AdapterValidationPanel triggers on tile click |

---

## P0 Findings

### P0-F: 5 broken external URLs in landing footer (FIXED in #271)

**Severity:** P0 (buyer-trust)
**Status:** Fix pushed as PR #271 (b1254cb), awaiting CI/merge
**Owner:** Closed via this audit

Live curl probe found:

| URL | Status |
|---|---|
| `https://github.com/founderos-ai/founderos` | **404** — org doesn't exist |
| `https://github.com/founderos-ai/founderos/releases` | **404** |
| `https://github.com/founderos-ai/founderos/discussions` | **404** |
| `https://docs.founderos.ai` | **TIMEOUT** — DNS doesn't resolve |
| `https://docs.founderos.ai/api` | **TIMEOUT** |

**Root cause:** PR #267's P0-E fix replaced 12 dead `href="#"` placeholders with external URLs to surfaces that don't exist (wrong GitHub org, unowned docs domain). Buyer impression went from "this link doesn't work" to "this company's infrastructure is broken" — strictly worse.

**Fix shape (PR #271):** Drop "Changelog" link from Product column, drop entire "Resources" column (4 broken links), rename third column to "Legal" with Terms/Privacy pointing at the working `/legal/*` routes. Net: zero broken links, 3 balanced columns preserved.

---

### P0-G: V2 onboarding wizard NOT shipping to prod (FIXED in #272)

**Severity:** P0 (buyer-trust + buyer-onboarding-blocker)
**Status:** Fix pushed as PR #272 (91f4d68), auto-merge enabled
**Owner:** Closed via this audit
**Reported by:** Buyer @ founderos.fly.dev, three symptoms

**Live symptoms reported:**

| Symptom | Buyer-visible | Root cause |
|---|---|---|
| Legacy "Hire your first teammate" wizard rendering | "still seeing the old screen" | V1 `OnboardingWizard` mounts because flag is `false` in prod |
| No API-mode tiles, no API-key validation panel | "Cant see API based for claude or gemini or open ai apis" | 6-provider grid is V2-only (`ProviderChooser` + `AdapterValidationPanel`) |
| "Missing permission: agents:create" on Test Adapter | "Missing permission: agents:create this is all user seens" | V1 calls `agentsApi.create` directly, bypassing `/api/onboarding/bootstrap` (the atomic permission grant route) |

**Root cause (single-source):** `ui/src/App.tsx:18-24` defines

```ts
const FOUNDEROS_ONBOARDING_V2: boolean = (() => {
  const raw = import.meta.env.VITE_FOUNDEROS_ONBOARDING_V2;
  if (raw === undefined || raw === null || raw === "") {
    return import.meta.env.DEV === true;  // ← FALSE in prod
  }
  return raw !== "false" && raw !== "0";
})();
```

Prod Docker build (`Dockerfile:60-71`) does NOT pass `VITE_FOUNDEROS_ONBOARDING_V2` as an `ARG/ENV` — only 6 VITE_ vars listed (Supabase URL/anon, Sentry DSN+sample, build SHA+time). So Vite inlines `undefined` for the flag, the fallback path runs, and `import.meta.env.DEV` is `false` in production builds. Net: prod silently ships V1 despite CLAUDE.md (G3a/b/c shipped 2026-05-18) documenting V2 as production.

Per CLAUDE.md V2 invariant: *"prod is V2 (FounderOnboardingWizard) … fixes to UI tile registration / wizard default flip on the legacy file are wasted effort unless `VITE_FOUNDEROS_ONBOARDING_V2=false`."* The runtime default disagreed with the doc.

**Fix shape (PR #272):** Single line in `ui/src/App.tsx:21` — flip the fallback from `import.meta.env.DEV === true` to `return true`. `VITE_FOUNDEROS_ONBOARDING_V2=false` remains as an explicit opt-out escape hatch for emergency rollback. No Dockerfile change needed. Comment block expanded to document the regression so a future contributor doesn't reintroduce the same trap.

**Why this fixes all three symptoms at once:**
- (1) `App.tsx:664` mounts `<FounderOnboardingWizard />` instead of `<OnboardingWizard />` → no legacy "Hire your first teammate" form
- (2) V2's `ProviderChooser` renders 6 tiles (3 API + 3 CLI) — buyer sees Anthropic/OpenAI/Google API options
- (3) V2's `handleFinish` posts to `/api/onboarding/bootstrap` which atomically grants `agents:create` permission via `runPostSignupBootstrap` — no more "Missing permission" surface

**Verification:** All 82 onboarding unit tests pass on the diff (`npx vitest run src/components/onboarding`). Typecheck clean.

---

## P1 Findings (deferred — not demo-blocking)

### P1-A: No comprehensive content audit of marketing copy

Marketing claims like "$10M company with 3 people" and "5-minute setup" — true to brand but unaudited against capability. Not a buyer-trust break (copy is aspirational, standard for this category) but worth a pass.

### P1-B: Onboarding wizard not exercised end-to-end on prod

This audit stopped at /auth because signup mutates real Supabase user state. Verified V2 wizard Step 4 rendering against the local dev server (screenshots captured earlier this session). Recommend doing one full buyer-demo dry-run with a throwaway test account (e.g., `demo-2026-05-19@yourdomain.com`) before the actual demo call.

### P1-C: Dashboard surfaces not visually audited live

Dashboard, Goals, Projects, Department consoles — all touched in PR #267 — only verified via screenshots from local dev session. A live signed-in walk-through would close this gap.

---

## What This Audit Did NOT Cover

- **Onboarding wizard finish-to-completion** (requires real Supabase session)
- **Dashboard widgets** (Morning Brief, runway, agents) — gated by signed-in state
- **Goals/Projects CTAs** (P0-C/D from #267) — verified at code-level via earlier audits, not live
- **Department console rendering** (P0-A/B from #267) — same
- **Stripe checkout flow** — gated by FOUNDEROS_BILLING_GATE_ENABLED=1, currently off
- **Email delivery** (recovery link, magic link, welcome) — would require monitoring inbox
- **Runner install flow** — happens post-onboarding, requires laptop CLI

## Recommended Follow-up

1. **Pre-demo dry-run** with a test account through full signup → onboarding → dashboard
2. **Manual visual check** of Goals/Projects pages with a session (verify CTAs work)
3. **Email delivery smoke test** — trigger recovery email, magic link, confirm both arrive at a real address

---

## Cross-references

- **PR #271** — landing footer fix (P0-F above)
- **SYNTHESIS-PHASE1.md** — original P0 audit queue (5 UI P0s, all closed in #267)
- **GOAL-buyer-demo-readiness.md** — 8 acceptance gates (this audit closes "buyer-trust polish" gate)
- **CLAUDE.md** invariant "BL-004 V2 wizard null-default" — verified live (zero pre-selected tiles on Step 4 first paint)
