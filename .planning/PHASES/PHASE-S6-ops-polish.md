# Sprint 6 — Ops + approval engine + polish

_Status: not_started · Effort: 1 week · Depends on: S5 · Blocks: nothing (this is the MVP ship gate)_

## Goal

> Turn the assembled stack into a **trustworthy operating system**. Permissions matrix, full audit trails, agent memory, workflow templates, mobile daily brief, Slack summaries, bug bash. Definition of done = MVP ready for 20-50 design partners.

## Success criteria

1. **Permissions matrix**: every agent has explicit autonomy level per department; founder can adjust per workflow
2. **Workflow approval engine**: any workflow at autonomy=3 pauses in approval queue with clear "what will happen" preview
3. **Audit trails**: every workflow run + every agent action + every approval decision traceable to actor + workflow + run + insight
4. **Agent memory**: persistent learnings carry across sessions ("we tried this last quarter; here's what happened")
5. **Workflow templates**: 3 named templates from the PRD live (growth anomaly, content loop, revenue rescue)
6. **Notifications**: in-app + Slack daily summary for active workspaces
7. **Mobile daily brief**: responsive `/brief` view + magic-link auth so founder reads it on phone over coffee
8. **Bug bash**: zero P0/P1 issues, no console errors on golden path, Lighthouse ≥ 80 on dashboard, all migrations clean

QA acceptance: full first-week-of-customer simulation runs end-to-end with no errors. Council PASS verdict on the production cutover.

## What exists today (don't rebuild)

| Surface | Where | Status |
|---|---|---|
| `instance_user_roles` | RBAC primitive | ✓ live |
| `approvals` + comments | approval queue | ✓ live |
| `activity_log` | audit primitive | ✓ live; S1.8 added `workflow_id` column |
| `workflows` + `workflow_runs` | (S4.5) | ✓ available |
| `company_memory` | persistent memory | ✓ live; expand schema in S6.4 |
| Email service | for daily brief delivery | ✓ live |
| Composio Slack | for Slack daily summary | ✓ live |

## Tickets

---

### Ticket S6.1 — Permissions matrix (4-level autonomy per dept × per workflow)

**PM intent**: Founder sees a single matrix. Rows = departments. Columns = action types (Observe / Draft / Execute / Autonomous). Each cell is the current autonomy level for that combo.

**Engineering**:
- Schema: per `workspace_departments` (S1.7), `autonomyLevel` already exists. Now we extend per-workflow: `workflows.autonomyLevel` (S4.5) overrides dept default.
- New view endpoint `GET /api/companies/:id/permissions-matrix` →
  ```ts
  {
    departments: [{
      id, label, deptAutonomy: 1..4,
      workflows: [{ id, name, autonomy: 1..4, source: 'inherited' | 'override' }]
    }]
  }
  ```
- UI: new page `ui/src/pages/Permissions.tsx` (route `/permissions`) with editable matrix
- PATCH endpoint to update autonomy per dept or per workflow; council notification fires for any change to autonomy 4 (autonomous customer-facing)

**Council before merge**: this is RBAC code.

**QA**:
- Set CRM to autonomy=2 → Lifecycle CRM workflows pause in approval (or block at draft, depending on level)
- Per-workflow override visible
- Audit log records every autonomy change

**Files**:
- New: `server/src/routes/permissions-matrix.ts`
- New: `ui/src/pages/Permissions.tsx`
- Tests: enforcement at run time + audit

---

### Ticket S6.2 — Approval engine refinement

**PM intent**: Today approvals exist per-action. S6 makes them workflow-aware. Approval shows "what the workflow will do" not just "this single action."

**Engineering**:
- Extend `approvals` schema with `workflowRunId` (nullable; populated for workflow-driven approvals)
- New approval payload shape: full workflow plan tree (steps + conditions + projected effect)
- UI: approval card has expandable "see full plan" with each step
- "Approve and skip future similar approvals" option for low-stakes repeating workflows (e.g., onboarding emails) — this updates the workflow's autonomyLevel to 4 with an audit trail

**QA**:
- Workflow at autonomy=3 → approval row created with workflow context
- "Approve and stop asking" → workflow autonomy=4, future runs go straight through
- Reject → workflow run cancels, no actions taken

**Files**:
- New: migration 0089 (add `workflow_run_id` to approvals)
- Edit: `server/src/routes/approvals.ts`, `ui/src/pages/Approvals.tsx`, `ApprovalPayload.tsx`
- Tests: per-state transitions

---

### Ticket S6.3 — Workflow lineage in audit trails

**PM intent**: Every action has a complete provenance chain — what triggered it, what insight justified it, who approved it, what events fed the insight.

**Engineering**:
- Backfill `activity_log.workflow_id` (S1.8 added the column) for runs that already include workflowRunId
- Add `lineageRefs` jsonb column to `activity_log`:
  ```json
  { "insightIds": [...], "approvalIds": [...], "eventIds": [...] }
  ```
- Lineage viewer UI: per audit log entry, expandable "trace" showing the full chain
- Endpoint `GET /api/audit/:logId/lineage` → expands all referenced rows

**QA**:
- Run a workflow → audit log row has full chain populated
- Lineage viewer shows the 3-deep path (event → insight → approval → action)
- Existing audit rows pre-S6 show partial lineage gracefully

**Files**:
- New: migration 0090 (add `lineage_refs` to activity_log)
- New: `server/src/routes/audit-lineage.ts`
- New: `ui/src/components/LineageTrace.tsx`
- Tests: lineage builder + UI snapshots

---

### Ticket S6.4 — Agent memory (persistent learnings)

**PM intent**: When an agent makes a decision, it should remember why and reference the outcome later. "We tried doubling LinkedIn output last March — saw +18% signups but burnt founder time."

**Engineering**:
- Extend `company_memory` schema to add:
  ```ts
  category: text(),  // 'experiment_outcome' | 'channel_performance' | 'team_decision' | 'preference'
  embeddingVec: vector('embedding_vec', 1536),  // pgvector for semantic search
  expiresAt: timestamp(),  // some learnings decay
  ```
- Service: agents write a memory at end of each completed workflow run with outcome
- Service: agents read memories before LLM call (semantic search top-3)
- LLM prompt template includes memory section: "Past learnings relevant here: ..."
- pgvector extension required — verify on Fly MPG before merge

**QA**:
- Complete a Growth experiment → memory row created with outcome
- Agent re-runs in same workspace 30 days later → references prior memory in output
- Memory expiration cleanup job runs daily

**Files**:
- New: migration 0091 (extend company_memory + pgvector index)
- Edit: `server/src/services/agent-memory.ts`
- Edit: agent prompt templates to include memory section
- Tests: write/read memory + semantic ranking

---

### Ticket S6.5 — Workflow templates (the named 3)

**PM intent**: PRD specifies 3 named templates: growth anomaly, content loop, revenue rescue. S4 shipped Lifecycle CRM templates; S6 ships these 3 cross-department flagship templates.

**Engineering**:

**Template A — growth anomaly**:
- Trigger: `kpi_anomaly` insight on signup CVR with severity ≥ warning
- Steps:
  1. Funnel diagnostic identifies worst step
  2. CoS proposes 2-3 fix hypotheses
  3. Generates experiment cards (writes to `experiments` with proposed status)
  4. Asks founder to pick which to run

**Template B — content loop**:
- Trigger: LinkedIn post performance > 90th percentile of workspace history
- Steps:
  1. Take the high-performer
  2. Multi-format generate: thread, newsletter, landing copy, retargeting ad
  3. Schedule them across calendar with 2-4 day spacing
  4. Founder approves the calendar
  5. Auto-publish (autonomy=3 default)

**Template C — revenue rescue**:
- (Already shipped as S4.8 — this ticket connects it to the workflow registry as a named template)

**QA**:
- Each template fires on its trigger
- Each template's actions trace correctly through audit
- Template gallery in CrmConsole + ContentConsole + GrowthConsole shows all 3

**Files**:
- New: `server/src/services/workflows/templates/{growth-anomaly,content-loop,revenue-rescue}.ts`
- Edit: workflow registry to include 3 templates
- Tests: per-template fixtures

---

### Ticket S6.6 — Notification system (in-app + Slack)

**PM intent**: Founder doesn't need to check the dashboard to see pending decisions. In-app notifications + Slack daily summary.

**Engineering**:
- New schema: `notifications`
  ```ts
  notifications = pgTable('notifications', {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid().notNull().references(...),
    userId: uuid().notNull().references(...),
    kind: text().notNull(), // 'approval_needed' | 'insight_critical' | 'workflow_completed' | 'integration_failed'
    title: text().notNull(),
    body: text(),
    refKind: text(), refId: text(), // polymorphic ref to source object
    readAt: timestamp(),
    createdAt: timestamp().notNull().defaultNow(),
  });
  ```
- Endpoint: list/mark-read
- UI: notification bell in top bar → dropdown with unread count
- WS push: when new notification, push to connected client (existing WS infra)
- Slack daily summary: BullMQ recurring job 9am workspace-local; posts last 24h's insights + pending approvals to configured Slack channel via existing Composio Slack skill

**QA**:
- New approval → notification row + bell badge updates
- Mark read → badge decrements
- Slack daily summary posts at 9am local for active workspaces only

**Files**:
- New: schema + migration 0092
- New: `server/src/routes/notifications.ts`
- New: `server/src/jobs/slack-daily-summary.ts`
- Edit: top bar bell component
- Tests: WS push + Slack delivery (mocked)

---

### Ticket S6.7 — Mobile Daily Brief

**PM intent**: Founder reads the brief on their phone before stand-up. No native app — responsive web at `/brief` with magic-link auth.

**Engineering**:
- `/brief` page already exists from S3.3
- Add responsive styles: full-width on mobile, single-column flow, touch-friendly approval buttons
- Magic-link auth: founder gets a "View today's brief" link in the email — token signs them in for read-only mode (24h expiry)
  - Reuse `cli_auth_challenges` pattern or `instance_invites` token shape; new `magic_link_tokens` table simpler
- One-tap approve from email: each top-3 action has an "Approve" link with embedded token

**QA**:
- 375px mobile renders cleanly
- Magic-link signs in, expires after 24h
- One-tap approve works (audit trail captures email-link as approval source)

**Files**:
- New: schema + migration 0093 for `magic_link_tokens`
- New: `server/src/services/magic-link.ts`
- Edit: `ui/src/pages/DailyBrief.tsx` (responsive)
- Edit: email template (one-tap approve links)
- Tests: token lifecycle + responsive snapshots

---

### Ticket S6.8 — Onboarding wizard final pass

**PM intent**: New customer goes from signup → first value in <10 min. S1.9 added "choose departments"; S6 polishes the full wizard.

**Engineering**:
- Audit existing onboarding (post-S1.9 state)
- Tighten:
  - Step 1: company setup (name, stage, ARR, ICP, growth goal, runway, channels)
  - Step 2: connect 2+ integrations (Stripe + PostHog as required minimum)
  - Step 3: choose departments (S1.9 already shipped)
  - Step 4: set autonomy level (single slider per department or one global)
  - Step 5: first executive brief (S3.10 trigger)
- Add progress indicator (1/5, 2/5, ...) + back/next + save-and-resume
- Acceptance criteria: wizard never blocks; if integration fails, skip + revisit later

**QA**:
- Full happy path under 10 minutes
- Resume from each step works
- Stripe-only (no PostHog) → first brief still generates with reduced data

**Files**:
- Edit: existing onboarding wizard files
- Tests: e2e wizard happy path

---

### Ticket S6.9 — Bug bash + accessibility + Lighthouse

**PM intent**: Final polish pass before MVP ship. No console errors, no a11y red flags, Lighthouse ≥ 80 on the 3 main pages.

**Engineering — checklist**:
- Run `playwright test` against full e2e suite — all green
- Run Lighthouse against /dashboard, /departments/chief-of-staff, /brief — score ≥ 80 (perf + a11y + best-practices)
- Sweep `console.error` / `console.warn` in production build — zero
- A11y: tab-order across all main views, keyboard-accessible cmd-K, ARIA labels on icon-only buttons
- TypeScript strict: `pnpm typecheck` zero errors
- Lint: `pnpm lint` zero errors
- Bundle size: `pnpm ci:bundle-size` under 1.5MB gzipped UI
- Migration check: `pnpm --filter @founderos/db check:migrations` green

Each finding becomes a sub-PR. Cap at 1 day; if more emerge, log in CONTINUE.md as v1.1.

**QA**:
- All gates green
- 0 P0/P1 issues open

**Files**:
- Many small edits; bundle into one polish PR per category

---

### Ticket S6.10 — Production cutover + design partner onboarding kit

**PM intent**: Ship MVP. Hand over to buyer with a kit: how to onboard their first design partner.

**Engineering**:
- ADR-013: "FounderOS MVP — DoubtBuddy 6-sprint scope (2026-05-05)"
- Update `CLAUDE.md` + `CONTINUE.md` with end-of-S6 state
- Create `docs/ops/design-partner-onboarding-kit.md`:
  - Pricing setup ($500-$1,000/mo Beta tier — 1 workspace, 3 depts, 50k actions, 5 integrations)
  - Stripe live key flip checklist (one-way door — gated by user)
  - First design partner outreach template
  - First-week-of-customer expected timeline
- Smoke test: full self-driven user simulation against production-like environment
- Council R2 verdict on the cutover

**Hard halt**: live Stripe keys flip is a user-only action. Document, don't execute.

**QA**:
- ADR signed off
- Onboarding kit complete
- Smoke produces a real "first brief"
- Council PASS

**Files**:
- New: `docs/adr/ADR-013-founderos-mvp-doubtbuddy.md`
- New: `docs/ops/design-partner-onboarding-kit.md`
- Edit: `CLAUDE.md`, `CONTINUE.md`

---

## Definition of done

- 10 PRs merged
- ROADMAP.md S6 row updated
- Migrations 0089–0093 land
- All bug bash gates green
- ADR-013 written and merged
- Council R2 PASS
- `/vanta-sync` after merge
- Status: **MVP ready for 20-50 design partners**

## Notes for the agent

- **S6.10 is the only ticket with a hard user-halt — Stripe live keys.** Document, don't flip.
- **Council before merging S6.1 (RBAC), S6.2 (approval engine), S6.4 (memory schema), S6.5 (autonomous workflow templates).**
- **Bug bash (S6.9) discovers issues; don't widen to "improve everything"** — fix what's broken, log enhancements as v1.1.
- **Mobile brief (S6.7) requires magic-link tokens — these are short-lived auth tokens, treat with same care as session tokens.** No long-lived shared link.
- **Design partner onboarding kit goes to BUYER, not end customers** — the buyer pitches the kit. They'll re-skin the marketing site separately.
