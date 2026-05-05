# Sprint 4 — Content Studio + Lifecycle CRM

_Status: not_started · Effort: 1 week · Depends on: S3 · Blocks: S6_

## Goal

> Direct acquisition lift via Content Studio. Direct retention/revenue lift via Lifecycle CRM. **Ship the first true autonomous revenue loop**: low-activation detected → CoS drafts win-back email → founder approves → HubSpot deploys → CoS measures lift over 7 days.

## Success criteria

1. Content Studio: founder gives one brief ("write about onboarding for SaaS founders") → 6 outputs (LinkedIn, X thread, newsletter, reel script, landing copy, ad creative) generated within 60s
2. Content attribution: every published asset tracked back to revenue (Stripe signup → asset that triggered click via UTM)
3. Lifecycle CRM: 4 templated workflows live (onboarding, activation nudge, churn rescue, upsell)
4. **Autonomous revenue loop demo**: agent detects low-activation signal in PostHog → drafts a 3-email sequence → puts it in approval queue → on approval, deploys to HubSpot → 7 days later reports lift in MRR/activation
5. Content calendar UX: founder can see scheduled posts across channels in week/month view

QA acceptance: smoke workspace seeded with 14d of low activation → run Lifecycle CRM agent → it drafts a 3-email recovery sequence with personalization → approve → HubSpot test contact receives sequence.

## What exists today (don't rebuild)

| Surface | Where | Status |
|---|---|---|
| ContentConsole stub | `ui/src/pages/departments/ContentConsole.tsx` | ✓ shell |
| CrmConsole stub | `ui/src/pages/departments/CrmConsole.tsx` | ✓ shell |
| HubSpot writes | `server/src/services/skills/hubspot-{create-contact,log-note,move-deal}.ts` | ✓ |
| Composio LinkedIn write | (post via Composio) | ✓ |
| Composio Slack/Notion write | (existing skills) | ✓ |
| Insights table | `insights` (S3.1) | ✓ for content attribution insights |
| Events table | `events` (S2.1) | ✓ for revenue / activation reads |

## Tickets

---

### Ticket S4.1 — Content brief schema + intake

**PM intent**: Founder writes one brief; agent fans out into formats. Schema captures intent + audience + angle for the agent to use consistently.

**Engineering**:
```ts
// packages/db/src/schema/content_briefs.ts
contentBriefs = pgTable('content_briefs', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull().references(...),
  title: text().notNull(),
  thesis: text().notNull(),       // the one-line hook
  audience: text(),               // 'SaaS founders 5k-100k MRR' etc.
  angle: text(),                  // 'pain point' | 'contrarian' | 'how-to' | 'data-driven'
  keywords: text().array(),
  notesMarkdown: text(),
  status: text().notNull().default('draft'), // draft | researching | drafting | review | scheduled | published
  scheduledFor: timestamp(),
  createdAt: timestamp().notNull().defaultNow(),
  updatedAt: timestamp().notNull().defaultNow(),
});
```
- API: list/create/update/transition endpoints
- UI: `ContentConsole.tsx` "Briefs" tab — list + new-brief modal

**QA**: standard CRUD + state machine

**Files**:
- New: schema, migration 0084
- New: `server/src/routes/content-briefs.ts`
- Edit: `ContentConsole.tsx`

---

### Ticket S4.2 — Multi-format generator

**PM intent**: One brief produces 6 outputs. Agent runs once, drafts go to review tab, founder edits + publishes.

**Engineering**:
- Service `server/src/services/agents/content-generator.ts`
- Inputs: brief + optional context (recent high-performing content from this workspace via `events` LinkedIn metrics)
- Single Claude call with structured-output schema:
  ```ts
  type GeneratedContent = {
    linkedinPost: { body: string; hashtagSuggestions: string[]; estimatedReadTime: number };
    xThread: { tweets: string[]; commentary: string };  // first tweet is the hook
    newsletter: { subject: string; body: string };       // markdown
    reelScript: { hook: string; valueBeats: string[]; cta: string; runtime: string };
    landingCopy: { headline: string; subheadline: string; bullets: string[]; cta: string };
    adCreative: { primaryText: string; headline: string; description: string };
  };
  ```
- Persist as new `content_drafts` schema (linked to brief)
- Each draft has its own `status`, allowing founder to publish LinkedIn but discard X
- Brief status transitions to `review` automatically after generation

**Schema**:
```ts
contentDrafts = pgTable('content_drafts', {
  id: uuid().primaryKey().defaultRandom(),
  briefId: uuid().notNull().references(...),
  format: text().notNull(),  // 'linkedin' | 'x-thread' | 'newsletter' | 'reel' | 'landing' | 'ad'
  payload: jsonb().notNull(), // the per-format object
  status: text().notNull().default('drafted'), // drafted | edited | approved | published | discarded
  publishedAt: timestamp(),
  publishedToUrl: text(),
  generatedByRunId: uuid(),
});
```

**QA**:
- One brief → 6 drafts created
- Re-run on same brief → confirmed-overwrite or version-bump (decide: latest-wins with audit, NOT new rows)
- LLM error → brief stays in `drafting` status, error surfaced

**Files**:
- New: schema, migration 0085
- New: `server/src/services/agents/content-generator.ts`
- New: `server/src/services/agents/__prompts__/content-generator.md`
- Edit: `ContentConsole.tsx` (Drafts tab)
- New: `ui/src/components/ContentDraftCard.tsx`
- Tests: per-format generation + structured output validation

---

### Ticket S4.3 — Content attribution engine

**PM intent**: Every published asset gets a unique tracking link. Clicks → events → signups → revenue rolled up per asset.

**Engineering**:
- Each `content_drafts` row at publish-time gets a `attributionUtm` field (auto-generated: `utm_source=founderos&utm_campaign=<draftId>&utm_medium=<format>`)
- New endpoint `/c/:trackingId` redirects to the published URL after logging a click event
- Aggregation:
  - Click count per draft (last 30d)
  - Signup attribution (PostHog `identify` events with same `utm_campaign` cookie)
  - Revenue attribution (Stripe subscriptions whose customer.metadata includes the campaign id)
- New endpoint `GET /api/content-drafts/:id/attribution` → full rollup

**Schema** (or use existing `events`):
- Track-link clicks ingest as events: `source='content', entity_type='link_click', event_name='click', payload={draftId, format, refererHost}`

**QA**:
- Publish content with tracking link → click → click event in events table
- Synthetic signup with UTM cookie → attribution endpoint returns 1 signup for the draft
- Empty (no clicks) → 0 across the board

**Files**:
- New: `server/src/routes/content-tracking.ts` (the `/c/:id` redirect)
- New: `server/src/services/content-attribution.ts`
- Edit: `ContentDraftCard.tsx` to surface attribution numbers post-publish
- Tests: end-to-end UTM tracking flow

---

### Ticket S4.4 — Content calendar

**PM intent**: Week + month view of scheduled content. Founder schedules a draft, agent publishes at the time, calendar updates automatically.

**Engineering**:
- New UI: `ui/src/pages/departments/content/ContentCalendar.tsx`
- Reads `content_drafts` with `scheduledFor` populated
- Calendar grid (week/month toggle) with drag-to-reschedule (lightweight — could defer drag-drop to S6 polish)
- Publish job: BullMQ recurring every minute, scans for drafts where `scheduledFor < now() AND status = 'approved'` → publishes via Composio (LinkedIn, X) or via existing email service (newsletter)

**QA**:
- Schedule LinkedIn draft for 1 minute future → published within 60s
- Schedule for past time + status=approved → published immediately on next tick
- Status moves through approved → published, calendar updates

**Files**:
- New: `ui/src/pages/departments/content/ContentCalendar.tsx`
- New: `server/src/jobs/content-publish-tick.ts`
- Edit: `ContentConsole.tsx` (Calendar tab)
- Tests: scheduler tick + state transitions

---

### Ticket S4.5 — Lifecycle CRM workflow registry

**PM intent**: Workflows are templated, parameterizable, and tied to triggers. Sprint 4 ships 4 of them.

**Engineering**:
- New schema:
  ```ts
  workflows = pgTable('workflows', {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid().notNull().references(...),
    name: text().notNull(),
    template: text().notNull(),  // 'onboarding-emails' | 'activation-nudge' | 'churn-rescue' | 'upsell'
    triggerKind: text().notNull(), // 'event' | 'schedule' | 'manual'
    triggerSpec: jsonb().notNull(), // { source: 'posthog', event: 'identify' } or { cron: '0 9 * * *' } etc.
    autonomyLevel: integer().notNull().default(2), // 1=observe, 2=draft, 3=approval-required, 4=autonomous
    status: text().notNull().default('draft'),  // draft | active | paused
    config: jsonb().notNull(),  // template-specific (e.g., email subject, audience filter)
    lastRunAt: timestamp(),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow(),
  });
  workflowRuns = pgTable('workflow_runs', {
    id: uuid().primaryKey().defaultRandom(),
    workflowId: uuid().notNull().references(...),
    status: text().notNull(), // pending_approval | running | completed | failed
    triggeredBy: jsonb().notNull(),  // event ref or 'schedule' or actorId
    actions: jsonb().notNull(),  // array of {type, payload, status, executedAt}
    metricSnapshot: jsonb(),     // KPI values at run start (for lift measurement)
    createdAt: timestamp().notNull().defaultNow(),
    completedAt: timestamp(),
  });
  ```
- API: list/create/update workflows; list workflow_runs

**Council per global rule** (touches workflow execution, RBAC via autonomy level).

**QA**:
- Create workflow → list returns it
- Trigger event matches → run created
- Autonomy=3 → run pauses pending_approval, creates `approvals` row

**Files**:
- New: schema, migration 0086
- New: `server/src/routes/workflows.ts`
- Tests: trigger matching, status transitions

---

### Ticket S4.6 — Onboarding email template

**PM intent**: First lifecycle workflow. New customer signs up → 3-email welcome series over 7 days.

**Engineering**:
- Workflow template `onboarding-emails`:
  - Trigger: `event` source=posthog, event=`identify`
  - Actions:
    - Day 0: welcome email (subject: "Welcome to <product>")
    - Day 2: getting-started tips
    - Day 7: "what to do next" — references the founder's ICP
- Agent personalizes via `<contact.firstName>`, references signup-source channel
- Sends via existing email service OR HubSpot if HubSpot is the connected CRM

**QA**:
- Trigger event → 3 emails scheduled at correct intervals
- Founder cancellation of workflow run → remaining emails not sent

**Files**:
- New: `server/src/services/workflows/templates/onboarding-emails.ts`
- New: `server/src/services/workflows/templates/__prompts__/onboarding-personalization.md`
- Tests: email sequencing + personalization

---

### Ticket S4.7 — Activation nudge template

**PM intent**: PostHog identifies user → user does NOT activate within X days → nudge.

**Engineering**:
- Workflow template `activation-nudge`:
  - Trigger: scheduled scan (every 6h) for users where `event_name='identify'` exists but `event_name='activated'` doesn't, within 7d window
  - Action: send 1 email + create HubSpot note
  - Per-user dedup (don't nudge same user twice within 14d)

**Configurable**: founder picks the activation event (defaults to `activated` event from PostHog)

**QA**:
- 5 unactivated users in seed data → 5 nudge runs created
- Re-run within 14d → 0 new runs
- Activation event arrives mid-window → run cancels mid-flight

**Files**:
- New: `server/src/services/workflows/templates/activation-nudge.ts`
- Tests: scan logic + dedup

---

### Ticket S4.8 — Churn rescue template + the autonomous revenue loop

**PM intent**: This is the success-criteria demo. Low activation detected → win-back sequence → approval → deploy → measure lift.

**Engineering**:
- Workflow template `churn-rescue`:
  - Trigger: insight kind=`kpi_anomaly` with metric=`churn_30d` AND severity=`critical` OR Stripe `subscription.updated` to `at_risk` state
  - Action sequence:
    1. CoS agent generates a 3-email sequence personalized to detected churn cause (cluster cancellation reasons from `events`)
    2. Creates `approvals` row with autonomy_level=3 (approval-required)
    3. On approval: deploys via HubSpot to `at_risk` segment
    4. Schedules a 7-day-later check job that reads churn metric and posts back to insight: outcome (lift or no lift)
- The full graph (insight → run → approval → deploy → measure) is the "first revenue loop"

**Council before merge** — this is the highest-stakes ticket of S4 (autonomous customer-facing email).

**QA**:
- Synthetic churn spike → workflow triggers → drafts 3 emails → approvals row created
- Approve → HubSpot test contact receives the sequence (mocked in tests)
- 7d later metric check → outcome recorded on insight

**Files**:
- New: `server/src/services/workflows/templates/churn-rescue.ts`
- New: `server/src/jobs/workflow-outcome-measure.ts` (the 7d check)
- Tests: end-to-end sequence + idempotent re-trigger

---

### Ticket S4.9 — Upsell workflow template

**PM intent**: Free user with high engagement → invite to paid.

**Engineering**:
- Workflow template `upsell`:
  - Trigger: scheduled daily scan for users with PostHog activity > 80th percentile in last 30d AND status=free in Stripe
  - Action: 1 email with paid plan offer; CoS personalizes based on which feature they used most
  - autonomy_level=3 (approval-required) for v1

**QA**: similar to activation-nudge

**Files**:
- New: `server/src/services/workflows/templates/upsell.ts`
- Tests: scan logic + personalization

---

### Ticket S4.10 — CRM Console UI

**PM intent**: One screen for all 4 lifecycle workflows. Founder sees: which are active, runs in progress, lift over time.

**Engineering**:
- `CrmConsole.tsx` tabs: Workflows / Runs / Lift Analytics / Templates
- Workflows tab: cards for each templated workflow, toggle active/paused, edit config
- Runs tab: list of recent workflow_runs across all workflows, filter by status
- Lift Analytics: chart showing "X% lift in MRR over last 30d attributable to active workflows"
- Templates: gallery of available templates (4 in S4, more in S6)

**QA**:
- All 4 templates show in templates tab
- Activate one → workflows tab shows it
- Mock a run → appears in runs tab with correct status

**Files**:
- Edit: `ui/src/pages/departments/CrmConsole.tsx`
- New: `ui/src/components/WorkflowCard.tsx`, `WorkflowRunsTable.tsx`, `LiftChart.tsx`
- Tests: snapshot per state

---

## Definition of done

- 10 PRs merged
- ROADMAP.md S4 row updated
- Migrations 0084–0086 land
- Smoke: full content brief → 6 generated formats → publish 1 → click event tracked
- Smoke: synthetic churn spike → win-back sequence drafted → approve → deploy → 7d later lift recorded
- Council pass on S4.5 (workflow registry — RBAC implications) and S4.8 (autonomous customer email)
- `/vanta-sync` after merge

## Notes for the agent

- **S4.8 (churn rescue) is THE feature that justifies the subscription** — the autonomous revenue loop. Test ruthlessly.
- **All customer-facing email goes through approval (autonomy=3) in v1.** Autonomous email (autonomy=4) requires explicit founder opt-in via S6 UI; default is approval-required.
- **Multi-format generator (S4.2) shares prompt scaffolding with content-generator.md** — extract a shared system prompt for brand voice once we ship.
- **Content calendar drag-drop (S4.4) can be deferred to S6 polish** if it's stretching scope; click-to-reschedule via modal is acceptable v1.
