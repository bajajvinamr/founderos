# Sprint 1 — Foundation + workspace shell

_Status: not_started · Effort: 1 week · Depends on: nothing · Blocks: S2_

## Goal

> Founder logs in and sees their company. Department-driven UX feels like Slack + Notion + HubSpot + executive dashboard. Not software.

## Success criteria

A new design partner, after onboarding, can:

1. Land on the workspace home and immediately understand the layout: **left = departments, main = active console, right = company pulse**
2. See their company's KPI rail (MRR, signups, CAC, activation, churn, runway, experiment velocity, top blockers, weekly priorities) — populated from `company.metrics` for now (live data lands in S2)
3. Click any department in the left nav and see its console (CoS dashboard / Growth / Content / CRM / Finance — even if internal modules are S3+)
4. See the alerts center (anomalies, agent escalations, integration failures) accessible from the top bar
5. See the approval inbox prominently on the workspace home (one of the 3 modules of the CoS dashboard)
6. Top bar exposes: workspace switcher, command palette (cmd-K already exists), notifications, founder brief shortcut, anomaly alerts badge

QA acceptance: a fresh test workspace + 3 dummy agents + dummy `company.metrics` produces a coherent screen. No console errors. Mobile (375px) renders without horizontal scroll on workspace home and CoS dashboard.

## What exists today (don't rebuild)

| Surface | Where | Status |
|---|---|---|
| Department router | `ui/src/pages/DepartmentConsole.tsx` | ✓ lazy loads Growth/Content/CRM/Finance |
| Dept consoles | `ui/src/pages/departments/{Growth,Content,Crm,Finance}Console.tsx` | ✓ stubs exist |
| Department registry | `ui/src/lib/departments.ts` | ✓ hardcoded list, exposes `getDepartmentById` + `agentsInDepartment` |
| KPI right rail widget | `ui/src/components/CompanyPulseWidget.tsx` | ✓ reads `company.metrics` JSON, has 9 metric tiles |
| Approval queue | `ui/src/pages/Approvals.tsx`, `ui/src/pages/DecisionsInbox.tsx` | ✓ live, can be embedded as a module |
| Activity log | `ui/src/pages/Activity.tsx` | ✓ live |
| Command palette | `ui/src/components/CommandPalette.tsx` | ✓ cmd-K live |
| Dashboard | `ui/src/pages/Dashboard.tsx` | ✓ partial — needs department-driven re-shape |
| Workspace switcher | `ui/src/components/...` (Companies dropdown) | ✓ live |
| Audit logs | `ui/src/pages/AuditLog.tsx` | ✓ live |
| Departments backend | (no `departments` table — list is hardcoded in `lib/departments.ts`) | ⚠ S1.7 ticket |

## Tickets

Atomic-PR-sized. Each has PM (intent), Engineering (file paths + interface), QA (acceptance test) sections.

---

### Ticket S1.1 — Workspace Home as "Company HQ"

**PM intent**: Founder lands on `/dashboard` and feels they walked into their HQ. Three modules visible: Daily Founder Brief (placeholder for S3), Department Status (green/yellow/red), Decision Inbox.

**Engineering**:
- Refactor `ui/src/pages/Dashboard.tsx` into a 3-module layout
  - Top: Daily Founder Brief card (placeholder copy + "Brief generates daily at 7am — check back tomorrow" empty state until S3.1 lands)
  - Middle: Department Status grid (one card per active department; reads agent count + recent failure count + last-update timestamp from existing APIs)
  - Bottom: Decision Inbox (embed `<DecisionsInbox compact />` — needs a `compact` prop added)
- New component: `ui/src/components/DepartmentStatusCard.tsx`
  - Props: `{ departmentId, agentCount, healthState: 'green'|'yellow'|'red', lastUpdate, unresolvedTasks }`
  - Health rules: red = any agent in `error` state OR > 5 unresolved approvals; yellow = > 2 stalled workflows; else green
- Right rail (`CompanyPulseWidget`) remains on right — confirm it renders alongside the new module stack on `lg:` breakpoint
- Add `briefShortcut` button to top bar (placeholder route `/brief` to be wired in S3)

**QA**:
- Snapshot test for empty-state Dashboard (no agents, no metrics) — should render the 3 modules without crashing
- Snapshot test for populated Dashboard (3 agents, full metrics) — all 3 modules visible, right rail intact
- Manual: 375px mobile renders modules stacked, right rail collapses below

**Files**:
- Edit: `ui/src/pages/Dashboard.tsx`, `ui/src/pages/DecisionsInbox.tsx` (add `compact` prop)
- New: `ui/src/components/DepartmentStatusCard.tsx`, `ui/src/components/DepartmentStatusGrid.tsx`
- New: `ui/src/components/__tests__/DepartmentStatusCard.test.tsx`

---

### Ticket S1.2 — Chief of Staff Console (shell only)

**PM intent**: Default route `/departments/chief-of-staff` shows a CoS console with 4 modules (Daily Brief, Department Status, Capital Allocation, Decision Inbox). Modules show empty/placeholder state in S1; real content lands in S3.

**Engineering**:
- New: `ui/src/pages/departments/ChiefOfStaffConsole.tsx` matching the shape of `GrowthConsole.tsx`
- Update `DepartmentConsole.tsx` `SPECIALIZED_CONSOLES` set to include `chief-of-staff`
- Add lazy import for the new console
- 4 sections within the console:
  1. Daily Founder Brief — placeholder card "Generates daily at 7am — first run after S3 ships"
  2. Department Status — reuses `<DepartmentStatusGrid />` from S1.1
  3. Capital Allocation — placeholder "Activated when integrations sync (S2)"
  4. Decision Inbox — embeds `<DecisionsInbox compact />`
- No new endpoints. CoS console is purely UI compositional in S1.

**QA**:
- Click "Chief of Staff" in left nav → URL updates → console renders with all 4 module headers
- All 4 modules tolerate empty data (no agents, no integrations, no approvals)
- Department Status grid matches the one on Dashboard

**Files**:
- New: `ui/src/pages/departments/ChiefOfStaffConsole.tsx`
- Edit: `ui/src/pages/DepartmentConsole.tsx`
- New: `ui/src/pages/departments/__tests__/ChiefOfStaffConsole.test.tsx`

---

### Ticket S1.3 — Right Rail propagation (Company Pulse on every department)

**PM intent**: The KPI right rail follows the founder everywhere — it's their company's vital signs. Shouldn't disappear when they navigate into a department.

**Engineering**:
- Move `<CompanyPulseWidget />` rendering from `Dashboard.tsx` to the layout shell (likely `ui/src/App.tsx` or a `<DashboardLayout />` wrapper)
- Confirm it renders on: `/dashboard`, `/departments/*`, `/agents/*`, `/projects/*`
- Hide on: `/onboarding`, `/auth`, `/legacy/*`, full-screen detail views like `/agents/:id/runs/:runId`
- Add `useShouldShowRightRail()` hook with the path-allowlist logic
- Responsive: hide right rail below `lg:` (current Dashboard already does this)

**QA**:
- Snapshot tests for: Dashboard, GrowthConsole, AgentDetail (sub-tab), Onboarding (should NOT show)
- Manual cross-route navigation — pulse stays visible, doesn't flicker

**Files**:
- Edit: `ui/src/App.tsx` (or extract to `ui/src/components/DashboardLayout.tsx`)
- Edit: `ui/src/pages/Dashboard.tsx` (remove its local pulse render)
- New: `ui/src/lib/use-show-right-rail.ts`
- Tests: snapshot updates across affected pages

---

### Ticket S1.4 — Alerts Center page

**PM intent**: Founder needs a single inbox for "things that need my attention" — KPI anomalies (S3), agent escalations (today), integration failures (S2), approval requests (today). S1 ships the page shell with two real sections (agent escalations + approval requests) and placeholders for KPI anomalies + integration health.

**Engineering**:
- New route `/alerts` and page `ui/src/pages/Alerts.tsx`
- Tabs: "All" / "Agent escalations" / "Approvals" / "KPI anomalies" / "Integration failures"
- Agent escalations: list agents in `error` runtime state + agents with run count of failed runs in last 24h > 0 (existing `agent_runtime_state` table)
- Approvals: embeds existing `<DecisionsInbox />` filtered to `pending`
- KPI anomalies / Integration failures: empty states with "Coming in S3 / S2"
- Add anomaly badge to top bar: queries count from `/api/alerts/count`
- New endpoint: `GET /api/alerts/count` → `{ agent_escalations, pending_approvals, kpi_anomalies, integration_failures }`
  - Server: `server/src/routes/alerts.ts` (new)
  - Reads `agent_runtime_state` + `approvals` tables; KPI/integration return 0 in S1

**QA**:
- Empty state with no escalations and no approvals
- 3 escalations + 5 approvals → badge shows `8`
- Tab counts match

**Files**:
- New: `ui/src/pages/Alerts.tsx`
- New: `server/src/routes/alerts.ts`
- Edit: `server/src/routes/index.ts` (mount), `ui/src/App.tsx` (add route)
- Edit: top bar component (search for "Notifications" or top-bar — likely `ui/src/components/TopBar.tsx` or in `App.tsx`)
- New: `server/src/__tests__/alerts.test.ts` (4 cases: empty, escalations only, approvals only, both)

---

### Ticket S1.5 — Quick Action Bar (cmd-K extensions)

**PM intent**: Cmd-K already exists (`CommandPalette.tsx`). S1 extends it with department-level commands so founders never need to mouse to navigate.

**Engineering**:
- Extend `ui/src/components/CommandPalette.tsx` with a "Departments" section
  - "Go to Chief of Staff", "Go to Growth", "Go to Content", "Go to CRM", "Go to Finance"
- Add "Open Daily Brief", "Open Approvals", "Open Alerts" entries
- Add "Switch workspace" entry that opens the existing workspace dropdown

**QA**:
- Cmd-K → type "growth" → first result navigates to `/departments/growth`
- Cmd-K → type "approval" → opens approvals page
- Existing search functionality (agent navigation, project navigation) still works

**Files**:
- Edit: `ui/src/components/CommandPalette.tsx`
- Edit: existing test `ui/src/components/CommandPalette.test.tsx`

---

### Ticket S1.6 — Approval Inbox embed (Decision Inbox compact)

**PM intent**: Approvals already exist as a full page; S1 makes them visible-by-default on the workspace home and CoS console. No more "out of sight, out of mind."

**Engineering**:
- Add `compact?: boolean` prop to `DecisionsInbox.tsx`
  - Compact: max 5 items, "see all (N)" link to `/approvals`
  - Full: existing behavior
- Audit `Approvals.tsx` and `DecisionsInbox.tsx` — pick one as canonical (`DecisionsInbox` per current naming) and have the other route redirect or re-export
- Smaller card variant in compact: title + age + 2 buttons (approve / open detail)

**QA**:
- Compact mode with 0 items → "All caught up" empty state
- Compact mode with 8 items → 5 visible + "see all (3 more)" link
- Full mode unchanged from today

**Files**:
- Edit: `ui/src/pages/DecisionsInbox.tsx`
- Edit: `ui/src/pages/Approvals.tsx` (consolidate or redirect — confirm via code review which is in active use)
- Tests: `ui/src/pages/__tests__/DecisionsInbox.test.tsx` (compact case)

---

### Ticket S1.7 — Department Registry (data model)

**PM intent**: Departments today are a hardcoded array. To support per-workspace department customization (S6 onboarding step "choose departments"), they need to be a DB row.

**Engineering**:
- New schema: `packages/db/src/schema/departments.ts`
  ```ts
  export const departments = pgTable('departments', {
    id: text('id').primaryKey(), // 'chief-of-staff', 'growth', etc.
    label: text('label').notNull(),
    description: text('description'),
    icon: text('icon'),
    sortOrder: integer('sort_order').notNull().default(0),
    isCore: boolean('is_core').notNull().default(false),
  });
  export const workspaceDepartments = pgTable('workspace_departments', {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    departmentId: text('department_id').notNull().references(() => departments.id),
    enabled: boolean('enabled').notNull().default(true),
    autonomyLevel: integer('autonomy_level').notNull().default(2), // 1..4 per PRD permissions matrix
    createdAt: timestamp('created_at').notNull().defaultNow(),
  }, (t) => ({
    uniq: unique().on(t.companyId, t.departmentId),
  }));
  ```
- Migration that seeds the 11 departments from `lib/departments.ts` into `departments` table
- Migration that backfills `workspace_departments` for every existing company with the 5 default departments enabled (CoS, Growth, Content, CRM, Finance)
- New endpoints:
  - `GET /api/companies/:id/departments` → list workspace_departments rows joined with departments
  - `PATCH /api/companies/:id/departments/:departmentId` → toggle enabled / change autonomy
- Update `ui/src/lib/departments.ts` to fetch from API instead of hardcoded list
  - Keep hardcoded fallback for tests that don't mount the query client

**Migration safety**:
- Council per global rule (touches schema). Backfill is additive only.
- Migration must run in `release_command` (per Fly invariant).

**QA**:
- Migration up + down idempotent
- Existing companies see 5 default departments after migration
- Toggling a department off in the API hides it from left nav (cache invalidation works)
- Test suite covers: list, toggle on/off, autonomy bumping

**Files**:
- New: `packages/db/src/schema/departments.ts`
- New: `packages/db/src/migrations/0075_departments.sql`
- New: `server/src/routes/departments.ts`
- Edit: `ui/src/lib/departments.ts`, `ui/src/components/SidebarNav` (or whatever renders the left nav)
- New: `server/src/__tests__/departments.test.ts`

---

### Ticket S1.8 — Audit Log polish (workflow lineage placeholder)

**PM intent**: Audit log exists; S1 ensures it captures every action that will need lineage in S6 (workflow-level audit). No new UI work — this is a backend hardening ticket so S6 doesn't need a backfill.

**Engineering**:
- Audit `activity_log` writes — confirm every approval, agent run, integration sync writes a row with consistent shape
- Add `workflow_id` column (nullable in S1, populated in S6) to `activity_log`
- Migration is additive — `ALTER TABLE activity_log ADD COLUMN workflow_id uuid REFERENCES workflows(id)` (workflows table doesn't exist yet — make it `text` for now, FK in S6)

**QA**:
- All existing activity_log writes still pass; new column is null
- Migration up + down clean

**Files**:
- New: `packages/db/src/migrations/0076_activity_log_workflow_id.sql`
- Edit: `packages/db/src/schema/activity_log.ts`
- No UI change

---

### Ticket S1.9 — Onboarding "Choose departments" step

**PM intent**: New customer onboarding gets a step where they pick which 3-5 departments are active. Defaults to all 5 core (CoS + Growth + Content + CRM + Finance). They can also set initial autonomy level.

**Engineering**:
- Audit existing onboarding wizard (`server/src/services/onboarding-bootstrap.ts`, `ui/src/pages/Onboarding.tsx` or similar)
- Insert new step after "Connect integrations": "Choose departments"
  - 5 core departments preselected
  - Sales/Support/Product/Ops shown as "Available" with toggles
  - Single autonomy slider (4 levels per permissions matrix): "Advisory only" / "Approval-first" / "Auto-execute safe tasks" / "Fully autonomous (advanced)" — defaults to "Approval-first"
- On submit: write `workspace_departments` rows
- Skip step if workspace already has departments configured (resume flow)

**QA**:
- New customer goes through full wizard → reaches workspace with selected departments only
- Existing customer is unaffected (skip on resume)
- Preselected core 5 cannot be deselected (business rule — they're the v1 wedge)

**Files**:
- Edit: existing onboarding wizard files
- Edit: `server/src/services/onboarding-bootstrap.ts`
- Tests: onboarding e2e (`tests/e2e/onboarding.spec.ts` if exists, else extend)

---

### Ticket S1.10 — Tenant-agnostic copy audit

**PM intent**: Since the buyer will resell, no FounderOS-specific copy can be hard-coded into core flows. Must live in a config the buyer can override.

**Engineering**:
- Sweep `ui/src/**/*.tsx` for hardcoded "FounderOS" outside of `LegalFooter`, `Auth`, `marketing/*` (which the buyer rebrands wholesale)
- Move strings to `ui/src/i18n/strings.ts` or `ui/src/branding.ts` config
  ```ts
  export const branding = {
    productName: 'FounderOS',  // overridable via env / per-deploy
    productTagline: 'AI executive team in one workspace',
    docsUrl: 'https://docs.founderos.com',
    // ...
  };
  ```
- Read from `import.meta.env.VITE_BRANDING_*` if present, else fall back to defaults
- Document override mechanism in `docs/ops/branding.md`

**QA**:
- Search for `'FounderOS'` (literal string) in `ui/src` — should only appear in `branding.ts`, marketing pages, legal docs, and tests
- Override env vars in dev → product name + tagline change visibly across the app

**Files**:
- New: `ui/src/branding.ts`
- New: `docs/ops/branding.md`
- Edits: many small (one per touched component) — bundle into one PR

---

## Definition of done

- All 10 tickets shipped as squashed PRs to `main`
- ROADMAP.md S1 row updated: Status=`done`, Last touched, PR list
- Migrations 0075 + 0076 land via release_command
- 0 new TS-strict errors, 0 new ESLint warnings, all new tests passing
- Manual smoke: fresh signup → onboarding wizard with department picker → land on workspace home with all 3 modules + right rail
- Manual smoke: nav into each department → console renders → right rail follows
- `/vanta-sync` to extract S1 learnings before kicking off S2

## Notes for the agent

- **Don't rebuild what exists.** The codebase already has 60% of S1 surface — read first, write second.
- **Approval inbox consolidation (S1.6) is a small refactor. Don't widen scope** to "redesign approvals"; that's S6.
- **S1.7 (department registry) is the only ticket that touches schema.** Run `/council` before merging that PR per global rule.
- **S1.10 (tenant-agnostic copy) can be done last** — gate the PR on the rest landing first; otherwise constant rebase pain.
- **No external services, no new dependencies.** Everything in S1 uses existing stack.
