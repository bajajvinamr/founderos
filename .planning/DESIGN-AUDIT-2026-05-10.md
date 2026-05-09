# FounderOS Design Audit — 2026-05-10

## Executive verdict

The visual product is credible and polished at the landing-page and auth surfaces — Pulse design system (Fraunces serif, orange accent, near-black editorial palette, JetBrains Mono data rows) gives the marketing site a clear design point of view that reads as premium. The auth page is clean and conversion-ready. The authenticated app interior uses a second, distinct system (Inter + Instrument Serif + teal) that is intentionally separate and also well-executed. The biggest risk for a non-tech founder is not visual quality but vocabulary and concept load: jargon like "BYO provider keys", "CLI or API", "provider strategy", "adapter", and "shift" appear within the first 30 seconds of reading, before any trust has been built.

---

## Live surface findings

### Landing page (/landing)

**Desktop (1440px):** `.playwright-mcp/page-2026-05-09T19-28-52-166Z.png`
**Mobile (375px):** `.playwright-mcp/page-2026-05-09T19-29-16-567Z.png`
**Tablet (768px):** `.playwright-mcp/page-2026-05-09T19-29-26-185Z.png`

The root URL (`/`) redirects to `/landing`. Any link shared as `https://founderos.fly.dev` arrives at the marketing page.

**What is working well**

- Hero typography is sharp. Fraunces at 144px / 0.94 line-height achieves proper editorial weight. The "3" counter box with dark-rust fill is a clever visual anchor.
- Orange accent is used sparingly (only the italic word "people." and the LED dot). Restraint is correct here — a non-tech founder reads it as confidence, not noise.
- The horizontal-rule grid structure (section separators, hairline columns) reads like a quality editorial publication. Zero card-shadow bloat.
- No horizontal scroll at any tested breakpoint (375px, 768px, 1440px). Layout reflows cleanly.
- Mobile nav collapses to a "MENU" hamburger correctly. The hero stacks into a single column with readable body text (19.2px / 1.5 line-height above the fold).
- 15 content sections give strong surface area for conversion — hero, proof strip, process showcase, use cases, testimonials, pricing, FAQ, contact all present.
- Pricing is transparent and in-page ($299/mo Solo, $2,000/mo Lean Team visible). A non-tech founder does not need to "talk to sales" to learn the number.
- CTA buttons clear 44px touch height (45.5px measured, 65px on pricing tier).

**Issues**

- **[P1] Jargon wall in the hero sub-copy.** "Measurable MRR lift in 14 to 30 days" is the second paragraph a new visitor reads. MRR is startup vocabulary — a 50-year-old founder who runs a services firm or a brick-and-mortar spinoff will not know this acronym. Below the fold: "BYO provider keys", "CLI or API", "Tenancy: Single" (in the auth right panel), "infra", and "Codex" appear within the first scroll. Each one is a small trust cliff.
  - Fix: Replace "Measurable MRR lift" with "Measurable revenue growth" in the hero. Change "BYO provider keys" to "Use your own OpenAI or Claude account". Inline a one-sentence tooltip on "CLI or API" or collapse it into "Any major AI subscription".
  - Priority: P1 — landing-page copy is the single highest-leverage conversion surface.

- **[P2] Nav touch targets at 768px are 15px tall.** The nav links (Product, How it works, Pricing, FAQ, Sign in) each have a rendered height of 15px at 768px viewport. "FAQ" and "Sign in" sit 30px apart horizontally. WCAG 2.5.5 (AAA) and WCAG 2.5.8 (AA, WCAG 2.2) require 24×24px minimum target size; iOS HIG and Android Material recommend 44px. At 768px the desktop nav is shown (not the MENU hamburger), which means a tablet user is tapping 15px links.
  - Fix: Add `py-3` (12px vertical padding) to each `<a>` in the nav — brings to ~39px usable height. Or add a dedicated `min-h-[44px] flex items-center` wrapper to each nav item.
  - Priority: P2 — tablet nav is unusable for fat-finger input.

- **[P2] Page title is plain "FounderOS" with no meta description.** The `<title>` reads "FounderOS" at every route, including `/landing`. No meta description is present. This harms SEO (Google shows the title in SERPs; a non-tech founder's team/advisor Googling the product sees no value proposition in search results) and looks unfinished to a knowledgeable investor.
  - Fix: Set `<title>FounderOS — Run your company with AI</title>` on the landing route. Add `<meta name="description" content="FounderOS gives you a full AI executive team — CEO, growth, ops, finance — for $299/mo. Live in five minutes." />`.
  - Priority: P2 — SEO and first impression in search.

- **[P3] "INDEX 001" label in the hero is opaque to non-tech founders.** The eyebrow reads "INDEX 001 / FOUNDEROS · THE AI COMPANY OS FOR LEAN FOUNDERS · EST 2026". "INDEX 001" and "AI COMPANY OS" are design-speak and internal labeling that non-tech users will not understand. "EST 2026" next to "LIVE – 18 FOUNDERS" in the same visual area creates confusion — is this an established company or a new one?
  - Fix: Replace "INDEX 001" with a product-oriented eyebrow like "EARLY ACCESS · 18 FOUNDERS LIVE" that carries the social-proof meaning.
  - Priority: P3 — visual polish, not a conversion blocker.

- **[P3] Console errors on every page load.** Every page visited logged 1–6 console errors. These were not captured by content (browser console intercept unavailable in this run), but they appear consistently across routes. This suggests API calls failing or missing config. A non-tech founder would never see this, but it is a quality signal for a technical evaluator.
  - Fix: Investigate `.playwright-mcp/console-2026-05-09T19-25-18-957Z.log` — first priority is whether any are auth-critical (vs. benign API 404s on unauthenticated routes).
  - Priority: P3 — no user-visible effect confirmed, but worth auditing.

---

### Auth page (/auth)

**Desktop (1440px):** `.playwright-mcp/page-2026-05-09T19-26-24-392Z.png`
**Sign-up tab (desktop):** `.playwright-mcp/page-2026-05-09T19-26-32-429Z.png`
**Mobile (375px):** `.playwright-mcp/page-2026-05-09T19-27-25-618Z.png`
**Tablet (768px):** `.playwright-mcp/page-2026-05-09T19-27-29-879Z.png`

**What is working well**

- Split-panel layout is cleanly executed. Left: form. Right: editorial value proposition with serif headline, grid of stats (Providers / Onboarding / Tenancy), and footer links. The Instrument Serif "Run a company / *staffed by AI.*" headline in teal italic on dark slate is the strongest single design moment in the authenticated zone.
- Focus ring on the email input is visible and correct — a 3px teal box-shadow ring appears on focus (oklch(0.55 0.085 193) / ~50% opacity). The border also shifts to teal. This meets WCAG 2.4.11.
- Google OAuth button has the G logo, correct bone-white styling, and sufficient height (inputs measured at 48px with min-height coerce rule in CSS).
- Magic link option is present. For a non-tech founder who forgets passwords, this is a meaningful trust signal.
- At mobile (375px), the right editorial panel hides (`display: none`) and the form fills the viewport correctly. No overflow. Touch targets are adequate (min-height: 44px enforced by the `@media (pointer: coarse)` rule in index.css).
- "Sign up" tab correctly relabels heading to "Start your company" — more action-oriented than a generic "Register".

**Issues**

- **[P1] Sign-up subtitle mentions "Anthropic key" before the user has made any decision.** The subtitle reads: *"Create your account. You'll pick a company template and plug in your Anthropic key on the next step."* For a non-tech founder, "Anthropic key" is a blocker they have no mental model for. They will stop here and wonder: "Do I need to buy something? What is Anthropic? Where do I get a key?" This is the first-impression copy shown to every new signup.
  - Fix: Change to "Create your account. You'll choose your starting team and connect your AI provider in a quick five-minute setup." Replace "Anthropic key" entirely — the provider step supports Claude, Codex, and Gemini. "AI provider" is more accessible than a vendor name.
  - Priority: P1 — this is the copy directly preceding the conversion action.

- **[P1] Sign-in button label says "Sign in" but is 12px font-size.** The mode-toggle buttons (Sign in / Sign up) have computed `font-size: 12px` and `border-radius: 5px`. The active state uses `bg-foreground text-background` correctly. However 12px font-size on interactive UI elements is below the recommended 14px minimum for legibility and fails WCAG 1.4.4 (Resize Text) at 12px on non-body elements. The tab buttons are also 6px×12px in padding only — computed height is approximately 28px — below the 44px minimum for touch.
  - Fix: In Auth.tsx line 178-198, change `px-3 py-1.5 text-xs` to `px-4 py-2 text-sm` (14px), bringing to ~36px height. Or use `min-h-[40px]` on the toggle wrapper.
  - Priority: P1 — these are the first interactive elements a user touches.

- **[P2] Right panel stats use jargon.** "Tenancy: Single / One isolated instance per founder" and "Providers: 3 / Claude, Codex, Gemini — CLI or API" both require technical literacy. A non-tech founder reading the sign-up panel will see "Tenancy" and "CLI or API" without context. These read like server specs to a developer, not benefits to a founder.
  - Fix: Replace "Tenancy / Single / One isolated instance per founder" with "Your data / Private / Nobody else touches your company's data". Replace "CLI or API" with "Any AI subscription".
  - Priority: P2 — right panel is supporting copy, not gating, but still sets mental model.

- **[P2] Tablet nav at 768px collapses all nav links into one row alongside "SIGN IN" and "BUILD YOUR COMPANY" CTA.** On the auth page at 768px, the desktop layout is rendered (since it appears to use `md:w-1/2`). The right editorial panel at 768px squashes the Instrument Serif headline into a tight 3-line stack, with the stats block barely readable.
  - Fix: Lower the breakpoint at which the editorial panel is shown from `md` (768px) to `lg` (1024px) — `class="hidden lg:flex"`. The 768px viewport is better served by a full-width form.
  - Priority: P2 — tablet layout is functional but cramped.

- **[P3] No error state visible in the sign-up form when fields are incomplete.** The "Create account" button is rendered with `aria-disabled="true"` and pointer-events:none when the form is incomplete, but there is no visual distinction beyond opacity:50 on the button. There is no inline helper text explaining what is still missing (e.g., "Name is required"). A non-tech founder may assume the button is broken.
  - Fix: Add a form-level `<p>` hint that appears below the submit button when any required field is empty and the user has blurred a field: "Fill in all three fields to continue." This is already partially implemented (the "At least 8 characters" helper under Password exists).
  - Priority: P3 — UX friction, not a blocker since validation text appears on real submit attempt.

---

### Sign-up form error states

Tested by filling email (`notanemail@test`) and password (`password123`) fields via native value setters — the Name field did not accept programmatic fill due to React's synthetic event system. The "Create account" button correctly enters `aria-disabled` until Name is filled. No error banner or toast was observed in this test since the form never submitted.

---

### 404 / unknown routes

Unknown routes (e.g., `/does-not-exist-404`) silently redirect to `/auth?next=/does-not-exist-404`. There is no dedicated 404 page. For a non-tech founder following a stale link, they see the sign-in form with no explanation. Worse: after signing in, they are redirected back to the 404 URL which will then render whatever the router's catch-all produces.

- **[P2] No 404 page.** Create a simple `NotFound.tsx` with a "This page doesn't exist — go to your Dashboard" link. Register it in the router as the catch-all `*` route.

---

## Code-derived findings (auth-gated surfaces)

### Onboarding wizard (`ui/src/components/OnboardingWizardNew.tsx`)

Four-step flow: Welcome → Pick a starting team → Connect an AI provider → Review & launch.

**Layout assessment (from source):**
```
Step 1 Welcome:
  - Left column: Serif 5xl/6xl headline + bullet list
  - Right column: Agenda (01–04 items with labels + sub-text)
  - CTA: "Start setup" button with ArrowRight icon

Step 2 Template:
  - 3-column grid of template cards (icon, category, name, agent count)
  - Import-your-own JSON option (non-tech founder: "What is JSON?")

Step 3 Providers:
  - Shows provider status (configured / not configured)
  - Allows choosing "mixed" / single-provider strategy

Step 4 Review:
  - Company name input
  - Provider strategy summary
  - "Launch" button
```

**Non-tech founder concerns:**

1. Step 2 offers "import your own .template.json file" as an option. The label is developer-facing. A non-tech founder sees the JSON import button and wonders if they are doing it wrong for not having a JSON file. The button should either be hidden behind a "Advanced" disclosure or relabeled "Upload a custom team configuration".

2. Step 3 mentions "Provider strategy: mixed / single-provider". For a non-tech founder, this is a configuration choice with no clear outcome explanation. The source at line 329 shows `<p className="mt-3 max-w-xl text-[14px]...">Each option ships a complete org: a CEO, direct reports...` — this copy is good. But "provider strategy" needs a plain tooltip: "Tells your team which AI accounts to use."

3. The welcome step headline "Build a company. *Staff it with AI.*" uses the `font-display` class (Instrument Serif) correctly — this is consistent with the auth right panel serif tone.

4. The step progress indicator ("01 / 04 · Welcome") is clean and Notion-style. Good.

5. No back-button on Step 1 (Welcome). This is fine. Back is present on Steps 2–4 (line 143, 153, 169).

**Design token usage:** The wizard uses `font-display` (Instrument Serif), `text-muted-foreground`, `border-border`, `bg-card`, `text-foreground` consistently. Token usage is correct throughout. No hardcoded hex values found in the source.

---

### Inbox (`ui/src/pages/Inbox.tsx`)

The Inbox page is the most complex file in the codebase (500+ lines of visible imports alone). It handles approvals, issues, heartbeats, real-time updates, swipe-to-archive, filter popovers, and keyboard shortcuts.

**Non-tech founder concerns:**

1. The Inbox is described in the product tour as "where 90% of your time here will go" — this sets the right expectation.
2. "SwipeToArchive" is present, suggesting mobile gesture support for decisions.
3. Keyboard shortcuts (`hasBlockingShortcutDialog`, `isKeyboardShortcutTextInputTarget`) are wired, implying power-user features. These should be invisible to a non-tech founder by default.
4. The page has tabs: visible from the snapshot: My Issues / All Approvals / Heartbeats / Access. The term "Heartbeats" is not self-explanatory for a non-tech founder — a tooltip or rename to "Team Check-ins" would help.

---

### Goals (`ui/src/pages/Goals.tsx`)

Minimal and well-structured. Empty state has "No goals yet" with "Add Goal" CTA — standard pattern, effective. The `GoalTree` component implies a hierarchy view (OKR-style). No structural concerns. Font and token usage consistent.

---

### Projects (`ui/src/pages/Projects.tsx`)

Standard list view with `EntityRow` pattern. Empty state correctly offers "Add Project" via button. Archived projects are filtered out. No design concerns at the code level.

---

### Daily Brief (`ui/src/pages/DailyBrief.tsx`)

Well-documented intent in the component header: answers three founder questions in 30 seconds. The loading state is a bare `"Loading…"` text string (line 69) — this should be a `<PageSkeleton>` consistent with other pages (Goals and Inbox both use `PageSkeleton`).

- **[P2] `DailyBrief` uses raw text `"Loading…"` instead of `<PageSkeleton>`** at line 68–73. Every other page (Goals, Inbox, Projects, Dashboard) uses `<PageSkeleton variant="list">`. This inconsistency means the Daily Brief flickers differently from every other page.
  - Fix: Replace the `<div className="...text-sm text-muted-foreground">Loading…</div>` at line 68 with `<PageSkeleton variant="list" />`.
  - Priority: P2 — visual inconsistency in the most frequently visited surface.

---

### Agent Detail (`ui/src/pages/AgentDetail.tsx`)

Very large page (80+ imports). Includes tabs for config, activity charts, budget policy, transcript, file tree (`PackageFileTree`), and one-on-ones. 

**Non-tech founder concerns:**

1. "RunButton" and "PauseResumeButton" are clear CTAs.
2. The presence of `PackageFileTree` and `buildFileTree` suggests a code/file browser is exposed to founders. This is appropriate for power users but will confuse non-tech founders browsing their agent's detail. Consider gating it behind a "Developer view" tab that defaults closed.
3. "Budget policy" is good terminology — a non-tech founder understands "budget".
4. `adapterLabels` at line 27 implies that the agent config form exposes adapter type (claude_local, anthropic_api, etc.). The adapter selection UI needs plain-language labels rather than technical adapter IDs.

---

## Pulse design system adoption

**Live site reflects Pulse in the landing page (`/landing`), not in the authenticated app interior.**

- **Landing page:** Full Pulse Builders register. Fraunces display serif (with `font-variation-settings: "SOFT" 0, "opsz" 144, "WONK" 0`), `--pulse-accent: #ff5b29` orange, `--pulse-void: #0a0a0c` near-black, `--pulse-line` hairline grid borders, JetBrains Mono for data rows, zero border-radius on CTA buttons (`border-radius: 0px` confirmed). This is clean, complete, and correctly scoped to `.pulse-root` so it does not leak.

- **Auth page:** Uses the authenticated app design system — Inter sans-serif, teal primary (`oklch(0.76 0.105 188)`, confirmed on "Create account" button), Instrument Serif on the right panel editorial headline, `border-radius: 8px` on inputs and primary button. This is intentionally separate from Pulse (see Landing.tsx comment: "the authenticated app... keeps its own Inter + Instrument Serif + teal set"). This is by design, not a Paperclip residue.

- **PR #124 Pulse migration:** Based on the source, the live site already reflects the Pulse landing system fully. The `PULSE_SCOPED_CSS` block in `Landing.tsx` is the design system for the landing, and it is complete. The authenticated app interior is on a separate deliberate system. No Paperclip residue was found in `index.css` — the token names (`--background`, `--primary`, `--brand`) are FounderOS-specific, not Paperclip defaults.

**Verdict on Pulse adoption:** Pulse is live and complete on the marketing surface. The authenticated app interior is a parallel system (Inter + Instrument Serif + teal) that is coherent and intentional. No cross-contamination detected. Whether the PR #124 scope intended to also migrate the interior is outside this audit's scope — but the live site shows no Paperclip residue.

---

## Accessibility findings

| Issue | Element | Severity | Detail |
|---|---|---|---|
| Focus ring: inputs | Auth page email input | Pass | 3px teal box-shadow ring visible on focus |
| Focus ring: buttons | Tab toggle (Sign in / Sign up) | Partial | `focus-visible:ring-[3px]` in Tailwind class — not verified visually due to test limitation |
| Touch target: auth tab buttons | Sign in / Sign up toggle | Fail | Computed height ~28px (padding only `py-1.5`), below 44px minimum |
| Touch target: landing nav links | Desktop/tablet nav at 768px | Fail | 15px computed height — critical at tablet breakpoint where desktop nav is shown |
| Color contrast: muted text | Auth subtitle (`text-muted-foreground`) | Borderline | oklch(0.68 0.012 240) on oklch(0.165 0.015 260) — approximately 4.2:1 ratio against dark bg. Passes AA (4.5:1 for small text is the threshold) at this luminance difference only marginally |
| Semantic HTML: auth tabs | Sign in / Sign up toggle | Warn | Two `<button>` elements, not `<input type="radio">` or `role="tab"`. Screen reader announces them as buttons, not a tab group. Should use `role="tab"` / `role="tablist"` |
| Skip link | App shell | Pass | `"Skip to Main Content"` link present in accessibility tree |
| Image alt text | Logo `<img>` elements | Pass | `alt="FounderOS"` confirmed in accessibility tree |
| Heading structure | Auth page | Pass | Correct h1 → body content hierarchy |
| 404 redirect | Unknown routes | Warn | Redirects to auth instead of a meaningful error page — keyboard nav users who arrive via a stale link have no indication the destination was invalid |

---

## Non-tech founder cliffs

These are the specific moments where a 50-year-old founder who has not written code would freeze or disengage:

1. **"Anthropic key on the next step" (auth sign-up subtitle).** They will ask "What is Anthropic? Do I need to pay them too? Where do I get a key?" and likely abandon.

2. **"BYO provider keys · Your data, your infra" (auth right panel footer).** "BYO" is abbreviation jargon. "Infra" is a developer term. This footer appears on every auth page load.

3. **"CLI or API" (auth right panel stats, Providers stat).** A non-tech founder does not know what a CLI is. If they read this and think they need to use a command line, they will not sign up.

4. **Template step: "Import a .template.json file" option.** Even though this is an optional path, seeing a JSON import option in the onboarding flow signals "this is for developers".

5. **"Provider strategy: mixed / single-provider" (onboarding Step 3).** The terminology "provider strategy" is opaque. "Mixed" vs "single-provider" offers no intuitive model without reading the tooltip — and first-time users rarely read tooltips.

6. **"Heartbeats" tab in the Inbox.** The name does not communicate what it does. A founder seeing "Heartbeats" on a business SaaS product will not immediately understand it means "team check-ins" or "shift activity pings."

7. **No public landing page at the root for a logged-out visitor.** Sharing `https://founderos.fly.dev` sends the visitor to the marketing landing at `/landing`, but a logged-out user navigating to `/` also lands there (confirmed). However, the canonical URL the user would share is likely just the domain root, which does redirect correctly. This is fine.

8. **Pricing stat "50k agent actions per month" (pricing section).** What is an "agent action"? A non-tech founder has no mental model. They cannot evaluate whether 50k is a lot or a little for their use case.

---

## Top 10 fix list (sorted by impact / effort)

| # | Priority | File | Change | Impact |
|---|---|---|---|---|
| 1 | P1 | `ui/src/pages/Auth.tsx:169-170` | Replace "plug in your Anthropic key" with "connect your AI provider" | Removes the single biggest non-tech conversion cliff |
| 2 | P1 | `ui/src/pages/Landing.tsx` (Hero section) | Replace "Measurable MRR lift" with "Measurable revenue growth" in hero body copy | Jargon removal, landing conversion |
| 3 | P1 | `ui/src/pages/Auth.tsx:174-198` | Change tab button padding from `py-1.5 text-xs` to `py-2 text-sm` — bring to ~36px, add `min-h-[40px]` wrapper | Touch target and legibility on auth tab toggle |
| 4 | P2 | `ui/src/pages/Landing.tsx` (TopBar) | Add `min-h-[44px]` to each nav `<a>` at the `md` breakpoint — currently 15px height at 768px | Tablet touch target compliance |
| 5 | P2 | `ui/src/pages/Auth.tsx` right-panel stats | Replace "CLI or API" with "Any AI subscription" and "Tenancy / Single / One isolated instance per founder" with "Your data / Private / Your workspace is isolated" | Non-tech jargon removal |
| 6 | P2 | `ui/src/pages/DailyBrief.tsx:68-73` | Replace raw `"Loading…"` string with `<PageSkeleton variant="list" />` | Visual consistency |
| 7 | P2 | Router catch-all (find via `ui/src/main.tsx` or `ui/src/App.tsx`) | Add `<NotFound />` component for unknown routes instead of redirect-to-auth | User orientation on stale links |
| 8 | P2 | `ui/src/pages/Landing.tsx` `<head>` / app-level | Add per-route `<title>` and `<meta name="description">` — "FounderOS — Run your company with AI" for landing | SEO and search-result credibility |
| 9 | P2 | `ui/src/components/OnboardingWizardNew.tsx` (template step) | Relabel JSON import button from "Import a .template.json file" to "Upload a custom team configuration (Advanced)" and gate it behind a `<details>` disclosure | Removes dev-facing option from primary non-tech flow |
| 10 | P3 | `ui/src/pages/Auth.tsx` right-panel | Move "BYO provider keys · Your data, your infra" footer text to a tooltip or remove "BYO" / "infra" vocabulary | Non-tech jargon removal in persistent footer |

---

## What I could not audit

1. **Authenticated dashboard, Inbox, Decisions, Goals, Projects, Agent Detail, Daily Brief, Departments, Org, Skills, Integrations, Costs, Activity pages** — no valid session. The session that existed in localStorage at audit start was cleared during testing. All of these are behind auth.

2. **Onboarding wizard live flow** — the wizard is shown inside the authenticated app to first-time users. Could not trigger it without a fresh account.

3. **Real form error states** — could not submit the sign-up or sign-in form with junk data because React's controlled input pattern requires synthetic events that could not be reliably triggered in Playwright evaluate. The auth page's error display logic (line 90-95 in Auth.tsx) looks correct but was not visually confirmed.

4. **Email confirmation flow** — when Supabase email confirmation is enabled, signup shows "Check your email to confirm your account" (line 82). This flow could not be tested without a real email address.

5. **Magic link flow** — requires a real email address.

6. **Mobile app interactions** — touch gestures (swipe-to-archive in Inbox, confirmed in SwipeToArchive component) were not tested against real touch events.

7. **Dark/light mode toggle** — the sidebar has "Switch to light mode" button. Light mode uses a warm off-white palette (`oklch(0.985 0.004 95)` background). Light mode audit would require a separate session.

8. **PR #124 status** — PR was described as "auto-merging". The live site already shows a complete Pulse landing system. Whether PR #124 added further authenticated-app Pulse tokens was not determinable from the live deploy.

---

*Screenshots taken: 9 distinct captures across 3 viewports.*
*Code files read: Auth.tsx, Landing.tsx, index.css, Dashboard.tsx, Inbox.tsx, Goals.tsx, Projects.tsx, DailyBrief.tsx, AgentDetail.tsx, OnboardingWizardNew.tsx, FounderBriefing.tsx.*
