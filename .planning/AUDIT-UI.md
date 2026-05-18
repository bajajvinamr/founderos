# FounderOS UI — Buyer-Demo Readiness Audit

**Date:** 2026-05-19
**Scope:** Every route in `ui/src/App.tsx`, every page in `ui/src/pages/`, critical components.
**Method:** Static read of handler wiring; Playwright deferred to Phase 3.
**Reference:** ADR-012 (`docs/adr/012-mvp-cutover-doubtbuddy.md`), CLAUDE.md known-gaps list.

---

## 0. Demo Blockers (P0 — MUST fix before buyer demo)

These break the buyer journey if left as-is.

| # | Blocker | File | Repro |
|---|---|---|---|
| **P0-A** | Specialized department consoles (CRM, Content, Finance) ship 100% mock data with hardcoded `MOCK_DEALS`, `MOCK_CAMPAIGNS`, `MOCK_MRR_EVENTS`, `MOCK_BURN_CATEGORIES`. Multiple primary CTAs fire toasts that say literally "Coming soon — ships in Wave 5." If the buyer clicks any dept other than Growth (the only real one), they see fabricated numbers + dead buttons. | `ui/src/pages/departments/CrmConsole.tsx:72-273`, `ui/src/pages/departments/FinanceConsole.tsx:73-501`, `ui/src/pages/departments/ContentConsole.tsx:87+` | Open `/departments/crm` or `/departments/finance` or `/departments/content`; click "+ New deal" / "Brief campaign" / "Schedule post". |
| **P0-B** | Generic department tabs `KPIs`, `Workflows`, `Decisions` ALL render a "Coming soon — activates after S3.2…" placeholder for every non-specialized department (Eng, Sales, Support, Ops, People, etc.). Founder lands on `/departments/engineering` and sees three empty placeholder tabs. | `ui/src/pages/DepartmentConsole.tsx:305-330` | Open `/departments/engineering?tab=kpis`. |
| **P0-C** | `Goals` page has NO "New Goal" button. There is no UI affordance to create a goal — only `NewGoalDialog.tsx` exists as a component, never mounted. The page renders an empty-state "No goals tracked." with zero action. | `ui/src/pages/Goals.tsx:198-221` | Open `/goals` with empty data → dead end. |
| **P0-D** | `Projects` page has NO "New Project" button. `NewProjectDialog.tsx` exists but is not mounted on the list page. Empty state shows just "No projects." with no CTA. | `ui/src/pages/Projects.tsx:204-279` | Open `/projects` with empty data → dead end. |
| **P0-E** | Landing footer has 11 dead `href="#"` links: About, Careers, Blog, Press, Changelog, Templates, Community, SaaS founders, Indie builders, Venture studios, Agencies, plus a Status link. Buyer's first instinct on landing is to click "Pricing" (works, anchor) or "Careers" (dead). | `ui/src/pages/Landing.tsx:1210-1249` | Click any non-anchor footer link. |

---

## 1. Inventory

Routes are board-scoped (prefixed with `/:companyPrefix`) unless marked global. "Critical-flow" = listed in the 9 buyer journeys.

| Route | Component | Renders? | Critical-flow? | Status |
|---|---|---|---|---|
| `/landing` | `Landing` | ✓ | ✓ #1 | **P1** (dead footer links, fake testimonials, 18-founders claim) |
| `/auth`, `/auth/forgot`, `/auth/reset` | `AuthPage`, `ForgotPassword`, `ResetPassword` | ✓ | ✓ #1 | Clean |
| `/legal/terms`, `/legal/privacy` | `LegalTerms`, `LegalPrivacy` | ✓ | — | Clean |
| `/invite/:token` | `InviteLandingPage` | ✓ | — | Clean |
| `/board-claim/:token` | `BoardClaimPage` | ✓ | — | Clean |
| `/cli-auth/:id` | `CliAuthPage` | ✓ | — | Clean |
| `/` → board redirect | `CompanyRootRedirect` | ✓ | — | Clean (good error states for auth-broken / backend-down) |
| `/onboarding` (V2 wizard via `FounderOnboardingWizard`) | `FounderOnboardingWizard` | ✓ | ✓ #2 | **P1** (known: no draft hydration; documented in CLAUDE.md) |
| `/onboarding` (legacy `OnboardingWizard`) | `OnboardingWizard` | ✓ | — | **P1** (legacy fallback; bypasses bootstrap route, see CLAUDE.md line 55) |
| `/dashboard` | `Dashboard` | ✓ | ✓ #3 | **P1** (sub-widgets: CapitalAllocation placeholder, PermissionCoach removed-and-disabled, todo) |
| `/today` | `Today` | ✓ | ✓ #3 | **P2** (Friday-only weekly link uses `#weekly` anchor, no anchor target lower on page) |
| `/agents/all`, `/active`, `/paused`, `/error` | `Agents` | ✓ | ✓ #4 | Clean (good empty state, runner dialog deep-link works) |
| `/agents/new` | `NewAgent` | ✓ | ✓ #4 | Clean |
| `/hire` | `HireTeammate` | ✓ | ✓ #4 | Clean (LLM draft proposal flow) |
| `/agents/:id` | `AgentDetail` | ✓ | ✓ #4 | **P2** (Skills tab disabled with `// TODO: bring back later` at line 398) |
| `/projects` | `Projects` | ✓ | ✓ #6 | **P0-D** (no New Project button) |
| `/projects/:id` | `ProjectDetail` | ✓ | ✓ #6 | Clean |
| `/projects/:id/workspaces/:wid` | `ProjectWorkspaceDetail` | ✓ | — | Clean |
| `/issues` | `Issues` | ✓ | — | Clean |
| `/issues/:id` | `IssueDetail` | ✓ | — | Clean |
| `/goals` | `Goals` | ✓ | ✓ #6 | **P0-C** (no New Goal button) |
| `/goals/:id` | `GoalDetail` | ✓ | ✓ #6 | Clean |
| `/inbox/mine`, `/recent`, `/unread`, `/all` | `Inbox` | ✓ | ✓ #5 | Clean (has empty state) |
| `/approvals/pending`, `/all` | `Approvals` | ✓ | ✓ #5 | Clean |
| `/approvals/:id` | `ApprovalDetail` | ✓ | ✓ #5 | Clean |
| `/decisions` | `DecisionsInbox` | ✓ | ✓ #5 | Clean |
| `/integrations` | `Integrations` | ✓ | ✓ #7 | **P1** (when `COMPOSIO_API_KEY` unset → Slack/Gmail show "One-click connection unavailable" disabled; buyer's first action is broken) |
| `/costs` | `Costs` | ✓ | ✓ #9 | Clean (real ledger + budgets data) |
| `/companies` | `Companies` | ✓ | — | Clean |
| `/company/settings` | `CompanySettings` | ✓ | ✓ #8 | Clean (data export, charter, invite snippets) |
| `/memory` | `CompanyMemory` | ✓ | — | Clean |
| `/skills`, `/skills/*` | `CompanySkills` | ✓ | — | Clean |
| `/instance/settings/general` | `InstanceGeneralSettings` | ✓ | ✓ #8 | Clean |
| `/instance/settings/members` | `InstanceAdminMembers` | ✓ | ✓ #8 | Clean (real invite flow) |
| `/instance/settings/providers` | `InstanceProvidersSettings` | ✓ | ✓ #8 | Clean |
| `/instance/settings/heartbeats` | `InstanceSettings` | ✓ | — | Clean |
| `/instance/settings/experimental` | `InstanceExperimentalSettings` | ✓ | — | Clean |
| `/instance/settings/plugins`, `/plugins/:id` | `PluginManager`, `PluginSettings` | ✓ | — | Clean |
| `/instance/settings/adapters` | `AdapterManager` | ✓ | — | Clean |
| `/instance/settings/ai-connections` | `AiConnections` | ✓ | — | **P1** (placeholder UI for default-for-new-work picker + per-dept usage table — see line 14-15, 288, 318) |
| `/settings/notifications` | `NotificationsSettings` | ✓ | ✓ #8 | Clean |
| `/audit` | `AuditLog` | ✓ | — | Clean |
| `/alerts` | `Alerts` | ✓ | — | **P1** (KPI anomalies + Integration failures sections render "Coming soon — activates after S3.2 / S2.7" placeholders) |
| `/weekly` | `WeeklyWrap` | ✓ | — | Clean |
| `/brief` | `DailyBrief` | ✓ | — | Clean (per ADR-012 the magic-link /brief route token consumption is v1.1; this is the authenticated /brief which works) |
| `/conversations` | `Conversations` | ✓ | — | Clean |
| `/routines`, `/routines/:id` | `Routines`, `RoutineDetail` | ✓ | — | Clean |
| `/execution-workspaces/:wid` | `ExecutionWorkspaceDetail` | ✓ | — | Clean |
| `/departments` → `/departments/chief-of-staff` → `/dashboard` | redirect | ✓ | ✓ #3 | Clean |
| `/departments/growth` | `GrowthConsole` | ✓ | — | Clean (real PostHog/HubSpot data path with empty-state connect prompt) |
| `/departments/content` | `ContentConsole` | ✗ MOCK | — | **P0-A** (100% mock data) |
| `/departments/crm` | `CrmConsole` | ✗ MOCK | — | **P0-A** (100% mock data) |
| `/departments/finance` | `FinanceConsole` | ✗ MOCK | — | **P0-A** (100% mock data) |
| `/departments/:other` (engineering, sales, support, ops, people) | `DepartmentConsole` generic | ✗ PLACEHOLDER | — | **P0-B** (3 placeholder tabs) |
| `/org` | `OrgChart` | ✓ | — | Clean |
| `/permissions` | `Permissions` | ✓ | — | Clean |
| `/design-guide` | `DesignGuide` | ✓ | — | **P2** (2× `href="#"` in breadcrumb example — internal dev surface, low risk) |
| `/tests/ux/*` | UX labs | ✓ | — | Clean (internal dev surface; should not be linked from buyer-visible nav — they're not) |
| `*` (global 404) | `NotFoundPage` | ✓ | — | Clean |

**Counts:** P0 = 5 blockers (across ~8 route surfaces) · P1 = 7 surfaces · P2 = 3 surfaces · Clean (real-data wired) = ~40 surfaces.

---

## 2. Per-Route Findings (P0/P1)

### P0-A — Specialized department consoles run on hardcoded mock data

**Files:**
- `ui/src/pages/departments/CrmConsole.tsx` — `MOCK_DEALS`, `MOCK_CAMPAIGNS`, `MOCK_FUNNEL`, `MOCK_ACTIVATION_BARS`, `MOCK_AT_RISK` (lines 72-289).
- `ui/src/pages/departments/FinanceConsole.tsx` — `MOCK_MRR_EVENTS`, `MOCK_BURN_CATEGORIES`, `MOCK_BLENDED_CAC_CENTS` (lines 73-501).
- `ui/src/pages/departments/ContentConsole.tsx` — "Mock data — Wave 5 replaces with real content service" comment at line 87+.

**Broken:**
- Every primary CTA on these pages fires `pushToast({ title: "Coming soon", body: "… ships in Wave 5." })`. Specifically:
  - CRM: "+ New deal" (lines 532, 597), "Edit campaign" (679), "Pause campaign" (688), "Brief campaign" (720), "Brief rescue" (902), "Draft rescue outreach" (957).
  - Content: "Schedule post" (469), week-nav arrows (440, 455), "Preview draft" (564).
- The displayed numbers (revenue, MRR, deals, burn) are fabricated. A buyer who runs a real company will see numbers that don't match their reality immediately.

**Impact on demo:** If the buyer clicks ANY department other than Growth (which has a proper "connect PostHog/HubSpot first" empty state), they see fake business data + dead buttons. CRM and Finance are explicit demo journeys per the brief.

**Fix shape:** Hide CrmConsole, FinanceConsole, ContentConsole from `SPECIALIZED_CONSOLES` set in `DepartmentConsole.tsx:45` so they fall back to the generic shell, which we then need to gate on real data (see P0-B). OR add an `AnalyticsConnectPrompt`-style empty state at the top of each console that hides the mocked widgets until a real connector is wired. Cheap option: gate the entire mocked content behind `if (NODE_ENV !== "production")` and ship a "Coming soon — wire your tools at /integrations" page in prod.

### P0-B — Generic department tabs are pure "Coming soon" placeholders

**File:** `ui/src/pages/DepartmentConsole.tsx:305-330`

**Broken:** `KpisTab()`, `WorkflowsTab()`, `DecisionsTab()` each return a `<PlaceholderTab>` with literal text "Coming soon — department KPIs wired to integrations." This fires for every non-specialized department: engineering, sales, support, ops, people, marketing, etc.

**Impact on demo:** Buyer clicking `/departments/engineering` (likely if they have engineering teammates) sees Team tab with cards, then three empty placeholder tabs. The footer copy reveals these aren't done yet ("Activates after S3.2"). The buyer learns the product is half-built.

**Fix shape:** Either (a) collapse the tab bar to just `Team` for non-specialized departments and hide KPIs/Workflows/Decisions until they're wired; OR (b) replace the placeholder copy with a one-line "This rolls up the team's open issues and pending approvals" link out to `/issues?department=X` + `/approvals?department=X` filtered views (the data already exists).

### P0-C — Goals page has no creation affordance

**File:** `ui/src/pages/Goals.tsx:164-221`

**Broken:** No `Button` import. No `+` button anywhere. Empty state is just `<EmptyState icon={Target} message="No goals tracked." />` — no `action`, no `onAction`. `NewGoalDialog.tsx` exists in `components/` but is never imported here.

**Impact on demo:** Once buyer creates their company they have zero goals. They land on `/goals`, see "No goals tracked", and have no way to create one. Per the brief, Goals is journey #6.

**Fix shape:** Import `NewGoalDialog` + Button. Add header-right "+ New Goal" button + dialog wiring. ~20 lines, mirrors the wiring pattern already used by Companies.tsx for + buttons.

### P0-D — Projects page has no creation affordance

**File:** `ui/src/pages/Projects.tsx:147-279`

**Broken:** Same shape as P0-C. `NewProjectDialog.tsx` exists, never mounted. Empty state is `<EmptyState icon={Hexagon} message="No projects." />` with no action.

**Impact on demo:** Same as P0-C — Projects is journey #6.

**Fix shape:** Mirror P0-C fix: import dialog + button + state.

### P0-E — Landing page has 12 dead anchor links

**File:** `ui/src/pages/Landing.tsx:1210-1249`

**Broken:** Footer columns "Company" (About, Careers, Blog, Press), "Resources" (Templates, Community), "For" (SaaS founders, Indie builders, Venture studios, Agencies), plus "Changelog" in Product col and "Status" in bottom bar — all `href="#"`.

**Impact on demo:** Buyer's natural pattern on landing: scan top nav (works), scan footer (12 dead links). Trust signal collapse.

**Fix shape:** Either hide the footer columns that have no real pages, or point to mailto:hello@founderos.ai / GitHub Discussions / a static `coming-soon.md` page. Three working anchors + one mailto are fine; ten `#`s reads as abandonware.

### P1 — V2 onboarding wizard known gaps (already logged in CLAUDE.md)

**File:** `ui/src/components/onboarding/FounderOnboardingWizard.tsx`

Per CLAUDE.md line 70: (1) No draft hydration on reload — every page reload restarts from step 1 even though `onboarding_drafts` table + `getOrCreate` exists server-side. (2) Accidental-close confirm is a band-aid; proper fix is hydration. Both LOGGED, not bugs to fix here.

**Demo workaround:** Don't reload the page mid-wizard during the demo.

### P1 — Integrations page disables one-click connect when Composio env var missing

**File:** `ui/src/pages/Integrations.tsx:294-326`

**Broken:** When `composioEnabled === false` (i.e. `COMPOSIO_API_KEY` not set on the server), every integration tile shows a disabled button "One-click connection unavailable" + a `<details>` element with "How to enable" containing the admin instructions. Buyer must dig into the disclosure to find the API-key fallback.

**Impact on demo:** Per the brief, journey #7 requires Composio connect for at least Slack + Gmail. Verify on the demo server that `COMPOSIO_API_KEY` is set and `COMPOSIO_V3_READY=1` (per CLAUDE.md). If not, every tile reads as broken.

**Fix shape:** This is a deploy-config fix on the demo server, not a UI fix. Verify before the demo via `/integrations` direct check — the green emerald dots on the connection strip is the signal.

### P1 — Landing page social proof is hardcoded fake

**File:** `ui/src/pages/Landing.tsx:255-339, 842-888`

**Broken:**
- "18 founders live · Est 2026" badge (line 259-263). Hardcoded count.
- "Last company shipped: Solo Indie SaaS, 5m setup" (line 329-330). Fake.
- Three full testimonials from "Reid M. · Solo SaaS · $20k MRR", "Priya K. · Pre-seed", "Dmitri V. · Bootstrapped" (lines 842-858). Fictional.

**Impact on demo:** If the DoubtBuddy buyer pattern-matches against testimonial-rich SaaS marketing, they may dismiss. If they're sophisticated they'll Google these names.

**Fix shape:** Either soften to "Early access · Est 2026" with a real beta-tester count, or swap testimonials for "Built by founders" rather than fake quotes.

### P1 — Dashboard "Capital Allocation" is a real placeholder

**File:** `ui/src/pages/Dashboard.tsx:185-188`, component `ui/src/components/CapitalAllocationCard.tsx`

**Broken:** Card renders on every dashboard load with comment "S1.2 — Capital Allocation placeholder (the 4th CoS dashboard module per the PRD). Real ROI ranking lands when S2 integrations sync and S3.8 channel-recommender runs."

**Impact on demo:** Buyer sees a card that says "Capital Allocation" with no real data. Reads as scaffolding.

**Fix shape:** Either hide the card entirely behind a feature flag, or rename to "Spend by department" and use the real cost data that already exists in `data.budgets`.

### P1 — Alerts page has two placeholder sections always visible

**File:** `ui/src/pages/Alerts.tsx:125-141`

**Broken:** "KPI anomalies" + "Integration failures" sections always render with `PlaceholderSection` body "Surfaced automatically when…" + literal "Activates after S3.2 (KPI anomaly detection job)" / "Activates after S2.7 (connector health monitor)".

**Impact on demo:** Two of four tabs (anomalies, integrations) are honest about being unwired. Acceptable if framed, embarrassing if the buyer clicks through.

**Fix shape:** Hide the two unwired tabs from `tabItems` until the underlying jobs ship. Active tabs remain Escalations + Approvals which are real.

### P1 — `/instance/settings/ai-connections` is half-placeholder

**File:** `ui/src/pages/AiConnections.tsx:14-15, 286-318`

**Broken:** Per the file's own header comment: "Default-for-new-work picker (placeholder; wiring lands in P5.b)" and "Per-department usage table (placeholder; server shape lands in P5.b)". Lines 288 and 318 disable the inputs explicitly.

**Impact on demo:** Buyer browsing settings sees unwired controls in an admin surface. Lower demo impact than `/departments/*` because it's nested in instance settings.

**Fix shape:** Hide the entire page from sidebar nav for v1, or replace the placeholder sections with a "Configure on the providers page →" link.

### P1 — `Today` cold-start example references a feature the wizard doesn't deliver

**File:** `ui/src/pages/Today.tsx:177-184`

**Broken:** Cold-start hint says: `"Draft our company charter."` — but there is no "Charter" entity in the product yet. The `CompanySettings.tsx` page has a `charter` textarea (line 52, 61), but there's no agent skill named "draft charter" — the suggestion routes nowhere.

**Impact on demo:** Buyer reads the prompt suggestion, types it as an Ask, gets an unhelpful response. Not a hard fail because Ask routing tolerates arbitrary prompts.

**Fix shape:** Change the example to something that exercises a real skill — e.g., "Summarize last week's progress."

---

## 3. Wired vs. Unwired CTAs (Critical-Flow Pages)

| Page | Primary CTA | Handler | Wired? |
|---|---|---|---|
| **Landing** | "Build your company" / "Design partner pricing · talk to us first" | `<Link to="/auth">` | ✓ |
| Landing footer | About / Careers / Blog / Press / Templates / Community / Changelog / Status / Audience tags | `href="#"` × 12 | ✗ DEAD |
| **Auth** | "Continue with Google" | `supabase.auth.signInWithOAuth({provider:"google"})` | ✓ |
| Auth | Email/password submit | `supabase.auth.signInWithPassword` / `signUp` | ✓ |
| Auth | "Send magic link" | `supabase.auth.signInWithOtp` (verify; line ~110) | ✓ |
| Auth | "Forgot password?" | `<Link to="/auth/forgot">` | ✓ |
| **V2 Onboarding** | Provider tile select (Step 4) | `patchDraft({adapterChoice})` | ✓ |
| V2 Onboarding | "Validate" (Step 4) | `AdapterValidationPanel` → `/api/providers/validate-key` | ✓ |
| V2 Onboarding | "Launch FounderOS" | `api.post("/onboarding/bootstrap", payload)` → navigate to `/:prefix/dashboard` | ✓ |
| V2 Onboarding | "Brief team in one line" + "Choose first decision" | persists in draft; consumed on launch via `api.post("/onboarding/accept-decision")` | ✓ |
| **Dashboard** | "Hire your first teammate" (empty-team banner) | `openOnboarding({initialStep:2})` | ✓ |
| Dashboard | MetricCard tiles "Team size" / "Work in flight" / "Pending approvals" | `<Link to="/agents|/issues|/approvals">` | ✓ |
| Dashboard | "Open budgets" (budget incident banner) | `<Link to="/costs">` | ✓ |
| Dashboard | Recent Runs row | `<Link to="/agents/:id/runs/:rid">` | ✓ |
| **Agents** (`/agents/all`) | "+ Hire teammate" | `navigate("/hire")` | ✓ |
| Agents | RunnerStatusPill | opens `RunnerInstallDialog` | ✓ |
| Agents | Teammate card click | `<Link to={agentUrl(agent)}>` | ✓ |
| Agents | Provider filter chips | `setProviderFilter` + localStorage persist | ✓ |
| **HireTeammate** (`/hire`) | "Draft a hire proposal" submit | `agentsApi.draftHireProposal()` | ✓ |
| HireTeammate | "Confirm hire" | `agentsApi.create()` → `navigate(agentUrl)` | ✓ |
| **Inbox** | Issue row click | `navigate(createIssueDetailPath)` | ✓ |
| Inbox | Approval row "Approve" / "Reject" | `approvalsApi.approve/reject` mutations | ✓ |
| Inbox | Swipe-to-archive (mobile) | `issuesApi.update({archivedAt})` | ✓ |
| **Approvals** | "Approve" / "Reject" per row | `approvalsApi.approve(id)` / `reject(id)` | ✓ |
| Approvals | Detail link | `<Link to={detailLink}>` | ✓ |
| **Today** | Decision row click | `<Link to={`/approvals/${id}`}>` (via `DecisionBrief`) | ✓ |
| Today | "Read this week's wrap" (Friday only) | `<a href="#weekly">` → anchor target NOT on page | ✗ **P2 dead anchor** |
| **Goals** | (no creation CTA exists) | — | ✗ **P0-C** |
| Goals | Goal row click | `<Link to={`/goals/${id}`}>` | ✓ |
| **Projects** | (no creation CTA exists) | — | ✗ **P0-D** |
| Projects | Status filter chips (active/archived/all) | local state | ✓ |
| Projects | Search input | local state debounce | ✓ |
| Projects | Project row click | `<Link to={projectUrl(project)}>` | ✓ |
| **Integrations** | "One-click connect" (Composio enabled) | `composioApi.connect(companyId, kind)` → opens consent in new tab | ✓ (when env configured) |
| Integrations | "Connect with API key" (fallback) | opens `ConnectIntegrationDialog` | ✓ |
| Integrations | "Test" (connected) | `integrationsApi.test(companyId, integrationId)` | ✓ |
| Integrations | "Disconnect" | `integrationsApi.remove()` | ✓ |
| Integrations | One-click button (when Composio disabled) | DISABLED, "How to enable" disclosure | **P1** |
| **CompanySettings** | "Save" name/desc/charter | `companiesApi.update()` | ✓ |
| CompanySettings | "Generate invite snippet" | `accessApi.createInvite()` + `getInviteOnboarding()` | ✓ |
| CompanySettings | "Export company data" | streams `/api/companies/:id/export` (download) | ✓ |
| CompanySettings | "Import company data" | navigate to `/company/import` | ✓ |
| CompanySettings | Logo upload | `assetsApi.uploadLogo()` | ✓ |
| **InstanceAdminMembers** | "+ New invite" | `instanceInvitesApi.create()` | ✓ |
| InstanceAdminMembers | "Revoke" | `instanceInvitesApi.revoke()` | ✓ |
| **NotificationsSettings** | "Save" digest prefs | `api.put("/digest/prefs")` | ✓ |
| NotificationsSettings | "Preview" | `api.get("/digest/preview")` | ✓ |
| **Departments — Growth** | Empty state "Connect PostHog/HubSpot/Stripe" | `<Link to="/integrations">` | ✓ |
| **Departments — CRM** | "+ New deal" / brief campaign / pause / edit / rescue | `pushToast("Coming soon — Wave 5")` × 7 | ✗ **P0-A** |
| **Departments — Content** | "+ Schedule post" / week navigation / preview | `pushToast("Coming soon — Wave 5")` × 4 | ✗ **P0-A** |
| **Departments — Finance** | (mostly display-only on mock data; settings page has real inputs) | — | ✗ **P0-A** for console, settings is clean |
| **Departments — generic (eng/sales/support/etc.)** | KPIs/Workflows/Decisions tabs | `<PlaceholderTab>` "Coming soon" | ✗ **P0-B** |

---

## 4. Empty / Error States Survey

Pages with proper empty states (clean):
- `Dashboard` — no-agents banner + "Hire your first teammate"; cold-start onboarding fallback (`OnboardingWizardNew`).
- `Agents` — "Hire your first teammate" empty-state component with action.
- `Inbox` — context-aware empty messages (search/recent/unread/all).
- `Approvals` — "No pending approvals." with icon.
- `Today` — `ColdStartHint` quiet-sentence pattern.
- `Companies` — "No companies yet" + "New Company" button.
- `Conversations` — empty state with "Start a conversation".
- `Issues` — empty state present.
- `Departments — Growth` — `AnalyticsConnectPrompt` routes to `/integrations`.
- Auth-broken / Backend-error pages — `AuthBrokenStartPage`, `BackendErrorStartPage` (App.tsx:445-528) with `requestId` surfaced.

Pages with weak / missing empty states (P1-P2):
- `Goals` — empty state present but NO action button (see P0-C).
- `Projects` — empty state present but NO action button (see P0-D).
- `Routines`, `RoutineDetail` — need verification (out of audit scope; deferred).
- `Departments — non-specialized` — empty placeholder tabs instead of routing to filtered views (see P0-B).
- `DailyBrief` — fine when empty (shows "No brief yet" + "Generate now" button).

---

## 5. Critical Missing Surfaces

| Missing | Where buyer would expect | Workaround |
|---|---|---|
| **Billing page in UI** | Buyer expects `/settings/billing` to see plan, Stripe portal link, invoices, switch plan. No surface exists in UI; per ADR-012 the live-key flip is a doc-only manual step. | Defer to "Talk to us" CTAs already in pricing tier 2 + 3 on landing. Acceptable for $4k buyer-funded engagement; would be a P0 for general SaaS. |
| **Notification bell consumer (WebSocket push)** | UI bell exists (`NotificationBell.tsx`) but per ADR-012 deferred-to-v1.1 list, the realtime push consumer is not wired. Bell renders, count from REST poll. | Document as v1.1 — already on the ADR list. |
| **`/brief` magic-link token consume** | Per ADR-012, the public-token `/brief` route consumption is v1.1 deferred. Authenticated `/brief` works fine. | Don't share `/brief` magic links in demo; use the authenticated path. |
| **Slack daily summary** | Per ADR-012, deferred to v1.1. | Acceptable. |
| **Skills tab on AgentDetail** | Disabled with `// TODO: bring back later` at line 398. Falls back to other tabs. | Cosmetic — agent skills are configured at company level via `/skills`. |

---

## Appendix — P2 Polish (Summarized)

- `DesignGuide.tsx` lines 735, 739 — `href="#"` × 2 in breadcrumb example. Internal dev surface, not buyer-visible.
- `Today.tsx:160` — Friday-only `<a href="#weekly">` has no matching anchor `id="weekly"` lower on page. Click does nothing.
- `Dashboard.tsx:190-196` — `PermissionCoachCard` removed from dashboard with a TODO to relocate; component file still exists but never rendered.
- `AgentDetail.tsx:398` — Skills tab commented out with `// TODO: bring back later`.
- `Goals.tsx:31` — `TODO(W3-schema)` about backing column for `goal.drift_band` — cosmetic, comment-only.
- 17 instances of `placeholderData: keepPreviousData` across `IssueDetail.tsx` — these are React Query API uses, NOT UX placeholders. False-positive on the grep.
- 8 instances of `MOCK_*` constants in `departments/` — already covered under P0-A.

---

## Suggested fix priority for buyer demo

1. **Today/tomorrow (1-2 hours total):**
   - P0-C + P0-D: add the missing "New" buttons to Goals + Projects (≈40 lines total).
   - P0-E: hide or fix the 12 dead footer links on Landing.
   - P1-Composio: verify `COMPOSIO_API_KEY` is set on `founderos.fly.dev` before the demo.

2. **Before demo (2-3 hours):**
   - P0-A: gate the three mock department consoles behind feature flag OR add an `AnalyticsConnectPrompt`-style empty state at the top of each. The cheap "ship now" option is to redirect `/departments/crm|content|finance` to `/departments/growth` (which is the only real one) and append a "More departments unlocking soon" line.
   - P0-B: collapse the unwired KPIs/Workflows/Decisions tabs on non-specialized departments.
   - P1-Alerts: hide the two unwired tabs.
   - P1-Dashboard: hide or rebrand `CapitalAllocationCard`.

3. **Acceptable to ship as-is (logged in ADR-012):**
   - V2 onboarding draft hydration (CLAUDE.md known gap).
   - Notification bell realtime push (deferred to v1.1).
   - `/brief` public-token consume (deferred).
   - Slack daily summary (deferred).
   - Skills tab on AgentDetail (cosmetic).
