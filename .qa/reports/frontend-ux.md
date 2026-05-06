# Agent Report: Frontend UX

## Scope Reviewed

- **Onboarding**: `ui/src/components/onboarding/FounderOnboardingWizard.tsx`, `steps/Step1Vision.tsx` … `Step7Telemetry.tsx`, `auto-charter.ts`.
- **Dashboard cluster**: `ui/src/pages/Dashboard.tsx`, components `CapitalAllocationCard`, `CompanyPulseWidget`, `LiveCompanyHeartbeat`, `NotificationsBell`.
- **Approval / review UI**: `ui/src/components/ApprovalCard.tsx`, `pages/IssueDetail.tsx`, `pages/Approvals.tsx`, `pages/ApprovalDetail.tsx`.
- **Goals · Projects · Inbox**: `pages/Goals.tsx`, `Projects.tsx`, `Inbox.tsx`, `MyIssues.tsx`, `Issues.tsx`, `components/IssuesList.tsx`.
- **Agent credentials / roles**: `pages/Agents.tsx`, `AgentDetail.tsx`, `HireTeammate.tsx`, `NewAgent.tsx`.
- **Department consoles**: `pages/DepartmentConsole.tsx`, `departments/{Growth,Content,Crm,Finance,Ops}Console.tsx`.
- **Layout chrome**: `components/Layout.tsx`, `components/EmptyState.tsx`, `App.tsx`.
- **API error contract**: `ui/src/api/client.ts` (`ApiError` carries `requestId`).

## Top Findings (max 10)

### Finding 1 — Onboarding wizard silently restores prior draft mid-flow
- **Severity**: P0 (buyer-demo-breaking trust hit)
- **Category**: state-restoration / authz-mismatch / surprise UX
- **Graph node**: `founder_onboarding`
- **File(s)**: `ui/src/components/onboarding/FounderOnboardingWizard.tsx:177-200`
- **What is wrong**: When the wizard re-opens, `useEffect` reads `draftQuery.data` and, if `vision` is non-empty, *silently* replaces local state with the server draft and jumps to the persisted `currentStep`. There is no "We saved your earlier progress — Resume or Start over?" prompt.
- **Why it matters**: A founder who closed the wizard mid-flow (or the buyer demoing on a fresh laptop after auth flip) reopens "New Company" and is dropped onto Step 4 with someone else's typed vision still in the textarea. There is no escape hatch to wipe the draft from the UI — only the server-side `complete` POST clears it.
- **User impact**: Confusing leak of prior typing. In the demo path, this looks like data corruption.
- **Evidence**: `if (hasMeaningfulData) { setDraft({ ...buildInitialDraft(), ...(serverDraft as Partial<OnboardingDraft>) }); … setStep(clamped); }` — no confirmation modal, no "Restart" button.
- **Suggested fix**: When `hasMeaningfulData` is true AND `currentStep > 1`, render a one-time gate: "Welcome back — you were on step N. **Resume** | **Start over** (deletes saved progress)." Wire "Start over" to a new `DELETE /onboarding/draft` (or PUT a blank shape) before flipping `hydratedRef.current`.
- **Effort**: small
- **Safe to fix now?**: yes (UI-only; backend already supports `complete`)

### Finding 2 — Bootstrap submit error swallows requestId, hides 401/403/409 differentiation
- **Severity**: P0 (blocks support triage on the most critical path)
- **Category**: error-state
- **Graph node**: `founder_onboarding`
- **File(s)**: `ui/src/components/onboarding/FounderOnboardingWizard.tsx:316-322`, `:466-468`
- **What is wrong**: On `handleFinish` failure, the catch shows only `err.message` — no `requestId`, no status discrimination. CLAUDE.md guarantees every JSON error since 2026-05-03 includes `requestId` in `ApiError.requestId`. A 409 ("company already exists") looks identical to a 500 ("DB unreachable") to the founder.
- **Why it matters**: When bootstrap fails for the buyer's demo, support has no requestId to grep Fly logs by; 409 conflicts can't be re-tried with a different name.
- **User impact**: Founder re-tries with same payload, same failure, no path forward.
- **Evidence**: `setSubmitError(err instanceof Error ? err.message : "Failed to bootstrap company");` followed by `<p className="mt-6 text-xs text-destructive">{submitError}</p>`.
- **Suggested fix**: Branch on `err instanceof ApiError`. For `409`, surface "A company with this profile already exists. Pick a different name." For `401`, link to `/auth?next=…`. For `402` (billing gate), say "Plan limit reached. Open billing." Always render `requestId` as monospace tail when present, like `BackendErrorStartPage` already does in `App.tsx:457-461`.
- **Effort**: small
- **Safe to fix now?**: yes

### Finding 3 — `ApprovalCard` self-approval prevention is UI-only (no backend authority check)
- **Severity**: P0 (demo-breaking authority story; trust invariant)
- **Category**: authz-mismatch
- **Graph node**: `frontend_review_ui` / `agent_credentials_roles`
- **File(s)**: `ui/src/components/ApprovalCard.tsx:48-52`, `ui/src/pages/Approvals.tsx:118-128`, `ui/src/pages/ApprovalDetail.tsx:289-308`
- **What is wrong**: `showResolutionButtons` is computed purely from `approval.type !== "budget_override_required" && (status === "pending" || "revision_requested")`. Whether the *current actor* equals `approval.requestedByAgentId` is never compared. The buttons remain Approve / Reject regardless.
- **Why it matters**: Critical Flow §7 invariant: agent cannot approve its own request. Today the only enforcement is on the server. If the founder ever views an approval where they (or an actor they delegate to) requested it, the UI offers buttons that the backend will 4xx — and we already saw in Finding 2 that 4xx errors don't differentiate. Worse, in any flow where requested-by happens to be the same role as resolver (multi-actor seat), there's no UI signal that the action is forbidden.
- **User impact**: Founder clicks Approve, gets generic "Failed to approve" (Approvals.tsx:53), no idea why.
- **Evidence**: `Approvals.tsx:51-54` sets `actionError` purely from `err.message`; `ApprovalCard` has no `canResolve` prop.
- **Suggested fix**: Thread `currentUserId` / `currentAgentId` from `authApi.getSession()` into `ApprovalCard`. Hide Approve/Reject + show "You can't review your own request" pill when `approval.requestedByAgentId === currentActorId` (or any user delegated for that agent). On `onError`, decode `ApiError.body.code === "self_approval_forbidden"` (or whatever the server returns) into a specific message.
- **Effort**: medium (need to plumb actor identity)
- **Safe to fix now?**: yes (UI hardening; backend remains the source of truth)

### Finding 4 — `Approvals.tsx` shows generic "Failed to approve" with no requestId
- **Severity**: P1
- **Category**: error-state
- **Graph node**: `frontend_review_ui`
- **File(s)**: `ui/src/pages/Approvals.tsx:51-54`, `:62-64`
- **What is wrong**: `onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to approve");` — `ApiError.requestId` and `.status` are dropped. Compare with `DailyBrief.tsx:319-330` which already pattern-matches `instanceof ApiError` and prefixes with `request <id>`.
- **Why it matters**: Buyer-grade approval UX. When 409 (already approved by another tab), 403 (no longer have access), 402 (over plan budget) all surface as the same red text, the founder has no recovery action.
- **User impact**: Demo-time friction; on prod, support can't grep logs by requestId.
- **Evidence**: As cited.
- **Suggested fix**: Mirror the DailyBrief pattern. Optionally factor a small `formatApiError(err)` helper into `lib/errors.ts` for reuse across `ApprovalDetail.tsx`, `IssueDetail.tsx`, etc.
- **Effort**: small
- **Safe to fix now?**: yes

### Finding 5 — Dashboard "Recent Tasks" empty state has no CTA
- **Severity**: P1
- **Category**: empty-state
- **Graph node**: `frontend_dashboard`
- **File(s)**: `ui/src/pages/Dashboard.tsx:434-438`
- **What is wrong**: `{recentIssues.length === 0 ? <div className="border …"><p>No tasks yet.</p></div> : …}` — no "Create your first issue" button, no link to `/inbox` or `/issues/new`. The dashboard is where buyer first lands after onboarding; this is the most-viewed empty state in the product.
- **Why it matters**: The "What do I do now?" gap is exactly the buyer-demo failure mode. The convention `EmptyState` component (`ui/src/components/EmptyState.tsx`) accepts `action` + `onAction` for free.
- **User impact**: First-paint dead end.
- **Evidence**: As cited.
- **Suggested fix**: Replace with `<EmptyState icon={CircleDot} message="No tasks yet." action="Create issue" onAction={openNewIssue} />`. The dialog is already wired via `useDialog().openNewIssue`.
- **Effort**: small
- **Safe to fix now?**: yes

### Finding 6 — `MyIssues` empty state has no CTA
- **Severity**: P2
- **Category**: empty-state
- **Graph node**: `goals_projects_inbox`
- **File(s)**: `ui/src/pages/MyIssues.tsx:46-48`
- **What is wrong**: `<EmptyState icon={ListTodo} message="No issues assigned to you." />` — no `action` prop. Founder lands on `/inbox/mine` with literally nowhere to go from this view.
- **Why it matters**: One of the four primary inbox tabs.
- **User impact**: Dead-end. Same shape as Finding 5.
- **Evidence**: As cited.
- **Suggested fix**: Add `action="Create issue"` and `onAction={openNewIssue}` (will need to import `useDialog`). Alternatively `action="Browse all issues"` with `onAction={() => navigate("/issues")}`.
- **Effort**: small
- **Safe to fix now?**: yes

### Finding 7 — DepartmentConsole "Coming soon" tabs (KPIs / Workflows / Decisions) have no actionable CTA
- **Severity**: P1 (demo will show three placeholder tabs per dept)
- **Category**: empty-state / placeholder
- **Graph node**: `frontend_dashboard` (department surfaces)
- **File(s)**: `ui/src/pages/DepartmentConsole.tsx:294-336`
- **What is wrong**: For non-specialized departments (and the generic shell), the KPIs / Workflows / Decisions tabs render `<PlaceholderTab>` with the literal copy "Coming soon — department KPIs wired to integrations." No CTA, no link to where the founder *can* see the equivalent today (`/costs`, `/routines`, `/approvals`). Buyers clicking around will hit three of these in the first 30 seconds.
- **Why it matters**: The dashboard story is "every department has a console." Three placeholder tabs per department flips that to "every department has half-finished consoles."
- **User impact**: Trust hit on demo.
- **Evidence**: `KpisTab`, `WorkflowsTab`, `DecisionsTab` — all return `<PlaceholderTab icon=… message="Coming soon — …" />`.
- **Suggested fix**: Either (a) hide these tabs until wired (preferred for buyer demo); (b) keep them but add a deep-link CTA: "View company-wide KPIs" → `/costs`, "View all workflows" → `/routines`, "View pending decisions" → `/approvals/pending`. The `EmptyState` component supports `action`+`onAction`; replace `PlaceholderTab` with it.
- **Effort**: small
- **Safe to fix now?**: yes (no functionality change, just routing)

### Finding 8 — `IssueDetail.tsx` IO-bound empty states give no recovery path
- **Severity**: P2
- **Category**: empty-state
- **Graph node**: `frontend_review_ui`
- **File(s)**: `ui/src/pages/IssueDetail.tsx:2224` ("No cost data yet."), `:2245` ("No activity yet.")
- **What is wrong**: Two long-tail issue panels render plain `<div className="text-xs text-muted-foreground">No cost data yet.</div>` — no `EmptyState`, no icon, no hint about why (e.g., the issue hasn't been worked yet, or runs were free).
- **Why it matters**: Less critical than dashboard empties, but compounds the "this app keeps showing me dead text" feeling on the issue page.
- **User impact**: Cosmetic + clarity.
- **Evidence**: As cited.
- **Suggested fix**: Use `EmptyState` (or a smaller variant) with one-line context: "No cost data yet. Costs accrue once an agent runs against this issue." Same for activity: "No activity yet. Comments, reassignments, and run events will land here."
- **Effort**: small
- **Safe to fix now?**: yes

### Finding 9 — `NotificationsBell` Popover content load lacks "View all" CTA + click-outside Mark-read race
- **Severity**: P2
- **Category**: empty-state / accessibility
- **Graph node**: `frontend_dashboard` (top-bar)
- **File(s)**: `ui/src/components/NotificationsBell.tsx:43-47`, `:108-111`, `:118-122`
- **What is wrong**: Two issues. (a) Empty state ("You're all caught up.") has no link to `/activity` or `/approvals` — the founder can't navigate further. (b) `markReadMutation` does not include `disabled={markReadMutation.isPending}` on the per-item click; rapid double-click on the same notification fires two POSTs (the first of which auto-redirects via `<Link>` so the second targets the new route — likely harmless but the mutation pattern is inconsistent with the explicit `disabled={markAllReadMutation.isPending}` on the Mark-all-read button at `:98`.
- **Why it matters**: Empty state is a soft dead-end. Mutation-pending discipline is a CLAUDE.md guardrail.
- **User impact**: Minor UX inconsistency on the most visible top-bar control.
- **Evidence**: `:108-111` empty copy renders alone with no link. `:118-122` calls `markReadMutation.mutate(n.id)` without checking `markReadMutation.isPending`.
- **Suggested fix**: (a) Add a "View all activity" link in the popover footer when items.length > 0, plus a "Settings" link to `/settings/notifications` from the empty state. (b) Wrap the per-item handler: `if (markReadMutation.isPending) return;` or use one mutation per id (react-query mutation cache keyed by id) — same pattern as `IssueDetail` uses for per-comment ops.
- **Effort**: small
- **Safe to fix now?**: yes

### Finding 10 — Inbox tab `/inbox/mine` empty state ("Inbox zero.") has no next-step CTA
- **Severity**: P2
- **Category**: empty-state
- **Graph node**: `goals_projects_inbox`
- **File(s)**: `ui/src/pages/Inbox.tsx:1890-1905`
- **What is wrong**: When `tab === "mine"` and `visibleSections.length === 0`, the message is `"Inbox zero."` with no `action`/`onAction`. Same for `unread`, `recent`, and "no items match these filters" (this last one would benefit from a "Clear filters" reset button).
- **Why it matters**: Inbox is the default landing for many founders post-onboarding (`loadLastInboxTab()` in `App.tsx:305`). "Inbox zero." with no CTA looks unfinished, especially right after first onboarding when the founder genuinely has zero work.
- **User impact**: New-user dead-end on a primary surface.
- **Evidence**: As cited.
- **Suggested fix**: For `mine` empty: `action="Browse all issues"` → `/issues`. For "no items match these filters": `action="Clear filters"` → reset filter search params. Both via `EmptyState`'s `action`/`onAction` props (already used elsewhere in the file).
- **Effort**: small
- **Safe to fix now?**: yes

## Empty-State Coverage Audit

| Page | Empty state present? | Has CTA? | Notes |
|---|---|---|---|
| Dashboard (Recent Tasks) | yes (plain `<p>`) | **no** | Finding 5 |
| Dashboard ("Your team is empty" banner) | yes | yes ("Hire your first teammate") | OK; uses inline amber banner not `EmptyState` |
| Goals.tsx | yes (`EmptyState`) | yes ("Add Goal") | OK |
| Projects.tsx | yes (`EmptyState`) | yes ("Add Project") | OK |
| Inbox.tsx (`mine`/`recent`/`unread`/`all`/filtered) | yes (`EmptyState`) | **no** on all 4 tabs + filter empty | Finding 10 |
| MyIssues.tsx | yes (`EmptyState`) | **no** | Finding 6 |
| Issues.tsx → IssuesList.tsx | yes | yes ("Create Issue") | OK |
| Approvals.tsx (pending/all) | yes (custom div) | **no** | Could route to `/inbox` or simply not render the empty card. P3, not in top 10. |
| Activity.tsx | yes (`EmptyState`) | **no** | Acceptable — activity is read-only by definition |
| Routines.tsx | yes (`EmptyState`) | partial (mentions "Use Create routine") | Message points at affordance above; acceptable |
| Agents.tsx (no teammates) | yes (`EmptyState`) | yes ("Hire teammate") | OK |
| DepartmentConsole TeamTab | yes (`EmptyState`) | yes ("Hire teammate") | OK |
| DepartmentConsole KPIs/Workflows/Decisions | placeholder | **no** | Finding 7 |
| Costs.tsx (per-section "No cost events yet") | plain `<p>` | **no** | Acceptable for sub-sections |
| AgentDetail config revisions / runs | plain `<p>` | **no** | Acceptable for sub-sections |
| IssueDetail cost / activity panels | plain `<p>` | **no** | Finding 8 |
| NotificationsBell popover | yes ("You're all caught up.") | **no** | Finding 9 |
| Companies.tsx | inline header + button | yes ("New company") | OK |
| Org.tsx | yes (`EmptyState`) | OK message | OK |
| OrgChart.tsx | yes (`EmptyState`) | message-only | OK |
| ContentConsole.tsx | yes (`EmptyState`) | yes (in copy) | OK |
| WeeklyWrap.tsx ("No wrap written yet") | yes (custom card) | yes ("Generate now") | OK; well-formed error code mapping at `:300-303` |
| DailyBrief.tsx | yes (custom card) | yes (regenerate) | OK; uses `ApiError.requestId` correctly |

Mutation-pending discipline: spot-checked `AgentDetail.tsx`, `ApprovalDetail.tsx`, `HireTeammate.tsx`, `IssueDetail.tsx`, `Routines.tsx`. All major mutation buttons use `disabled={…isPending}` correctly. The two exceptions found are in Finding 9 (NotificationsBell per-item) and the cumulative pattern of catch blocks losing requestId (Findings 2, 4).

Authz error differentiation: spot-checked. Only `Inbox.tsx:740` and `DailyBrief.tsx:320` and `App.tsx:443` (BackendErrorStartPage / AuthBrokenStartPage) decode `ApiError.status`. Approvals, IssueDetail mutations, AgentDetail mutations, HireTeammate mutations all collapse 401/402/403/409/5xx into a single string.

## Recommended PR Slices

1. **PR-FE-1 — Onboarding draft Resume/Restart gate + bootstrap error decoder** (Findings 1, 2). One file (`FounderOnboardingWizard.tsx`) + one new `DELETE /onboarding/draft` route stub if not already present. ≤ 80 LoC. Buyer-blocking.
2. **PR-FE-2 — `formatApiError(err)` helper + apply to Approvals / ApprovalDetail / IssueDetail mutations** (Finding 4 + base for Finding 3). New `lib/errors.ts` (~25 LoC) + 4 file edits replacing `err instanceof Error ? err.message : "Failed to …"` with the helper. Touches `Approvals.tsx`, `ApprovalDetail.tsx`, `IssueDetail.tsx`, `AgentDetail.tsx`. Strictly additive; no behavior change for happy path.
3. **PR-FE-3 — Self-approval guard in `ApprovalCard`** (Finding 3). Plumb `currentUserId`/`currentAgentId` from session into `ApprovalCard`; hide buttons + show "You can't review your own request" pill when self. ~40 LoC across 3 files.
4. **PR-FE-4 — Empty-state CTA pass** (Findings 5, 6, 8, 9, 10). Pure UI; convert plain `<p>` empties to `EmptyState` with `action`/`onAction` where a sensible target exists. ~6 file edits, < 50 LoC total.
5. **PR-FE-5 — Department console placeholder cleanup** (Finding 7). Either hide the three placeholder tabs entirely OR wire each to the closest real surface. Prefer "hide" for buyer demo; toggle behind a feature flag with a default of off until wired. ~30 LoC in `DepartmentConsole.tsx`.

Buyer-demo critical path: ship PR-FE-1, PR-FE-2, PR-FE-3 before any demo. PR-FE-4 and PR-FE-5 are polish but compound the "everything I touch tells me what to do" feel that separates a $4k whitelabel from a real product.
