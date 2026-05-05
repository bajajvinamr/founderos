# Sprint 3 — Chief of Staff + Growth department

_Status: not_started · Effort: 1 week · Depends on: S2 · Blocks: S4_

## Goal

> First magical ROI moment. Within 10 minutes of finishing onboarding, the founder sees an actionable insight that justifies the subscription. The CoS agent ships its first Daily Founder Brief and the Growth dept ships its first ICE-scored experiment backlog.

## Success criteria — the demo line

> _"Your LinkedIn founder content is driving 32% of signups. Double output here. Trial conversion is weak due to onboarding drop-off at step 2."_

If the agent can produce that line for a fresh design partner who has connected Stripe + PostHog + LinkedIn, S3 succeeded.

## Specific success criteria

1. CoS agent runs every 15 min on a per-workspace cron — generates KPI anomaly alerts when stat-z > 2 OR trend break detected
2. Daily Founder Brief generated daily at 7am (workspace local TZ) — landing in Inbox + email + (S6) Slack
3. Brief contains: KPI movements (3-5), anomalies, blockers, opportunities, top 3 actions
4. Growth dept's experiment backlog UI is live; founder can see ICE-scored experiments suggested by agent
5. Funnel diagnostics screen reads PostHog data, identifies the worst step in the funnel, suggests a fix
6. Channel recommendation: "move 30% from X to Y" with delta MRR projection
7. LinkedIn growth recommendation: explicit content-source-attribution insight ("32% of signups came from your founder posts in the last 30d")

QA acceptance: smoke test workspace with 30d of seeded events → CoS produces a coherent Daily Brief → Growth dept shows 5+ scored experiments → funnel screen shows the actual worst step.

## What exists today (don't rebuild)

| Surface | Where | Status |
|---|---|---|
| Agent runtime | `agents` schema, agent_runtime_state, run-execution.ts | ✓ live |
| Heartbeat runs | `heartbeat_runs.ts`, `heartbeat_run_events.ts` | ✓ live (this is the cron tick mechanism) |
| Approval flow | `approvals` + `decisions-inbox` | ✓ embed for the "top 3 actions" output |
| Anthropic SDK + adapters | `byo_runner | anthropic_api | claude_local` | ✓ live |
| Activity log | `activity_log` | ✓ for run audit |
| Events table | (S2.1) | ✓ available after S2 |
| Company memory | `company_memory.ts` schema | ✓ available — CoS persists insights here |
| Insights table | not yet | ⚠ ticket S3.1 (DoubtBuddy schema specifies `insights` separately) |

## Tickets

---

### Ticket S3.1 — Insights schema + API

**PM intent**: Persistent place for agent-generated insights, separate from raw events. Insights have confidence + recommendation + outcome tracking.

**Engineering**:
```ts
// packages/db/src/schema/insights.ts
export const insights = pgTable('insights', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  department: text('department').notNull(), // 'chief-of-staff' | 'growth' | 'content' | 'crm' | 'finance'
  kind: text('kind').notNull(),
    // 'kpi_anomaly' | 'opportunity' | 'blocker' | 'experiment_suggestion' | 'channel_recommendation' | 'attribution'
  title: text('title').notNull(),
  body: text('body').notNull(),         // markdown — the actual insight content
  confidence: real('confidence').notNull(),  // 0..1, agent self-rated
  recommendation: text('recommendation'),
  evidence: jsonb('evidence').notNull(),    // links to events / runs / approvals that justify the insight
  status: text('status').notNull().default('open'), // 'open' | 'acted_on' | 'dismissed' | 'expired'
  outcomeNote: text('outcome_note'),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  byCompanyKind: index('insights_company_kind_idx').on(t.companyId, t.kind, t.createdAt.desc()),
}));
```
- API:
  - `GET /api/companies/:id/insights?kind=&status=` — paginated list
  - `POST /api/companies/:id/insights` — agent creates
  - `PATCH /api/companies/:id/insights/:id` — mark `acted_on | dismissed`
- All routes scoped via existing company-membership auth

**QA**:
- Insert insight → list returns it
- Status transitions enforced (no reopening dismissed)
- Migration 0081 up/down clean

**Files**:
- New: `packages/db/src/schema/insights.ts`, migration `0081_insights.sql`
- New: `server/src/routes/insights.ts`
- Tests: `server/src/__tests__/insights.test.ts`

---

### Ticket S3.2 — KPI anomaly detection job

**PM intent**: Cron-driven anomaly detector reads `company_kpi_snapshots` (from S2) every 15 min, compares against rolling baseline, flags significant deviations.

**Engineering**:
- New BullMQ recurring job `kpi-anomaly-detect` — every 15 min per active workspace
- Reads last 30d of `events` aggregated per metric per day → baseline mean + stddev
- Flags any metric with current value outside baseline ± 2σ → write `insights` row, kind=`kpi_anomaly`
- Trend-break detection: simple linear regression on last 14d; if today's actual deviates > 2σ from regression prediction, flag
- Avoid alert fatigue: dedup — don't create a new insight if the same kind+metric is already `open` for this company within last 24h

**Algorithm pseudocode**:
```
for each metric in (mrr, signups_7d, activation_rate, churn_30d, runway_months):
  baseline = mean(metric, last_30d)
  stddev = stddev(metric, last_30d)
  current = current_kpi_snapshot[metric]
  if abs(current - baseline) > 2 * stddev:
    severity = 'critical' if abs(current - baseline) > 3 * stddev else 'warning'
    create insight(kind='kpi_anomaly', title=..., evidence={baseline, stddev, current}, confidence=...)
```

**QA**:
- 30d of stable MRR + sudden 30% drop → insight created with severity=critical
- 30d of stable + 5% deviation → no insight
- Re-run within 24h → no duplicate insight
- Acted-on → re-run after 24h → can create new insight if anomaly persists

**Files**:
- New: `server/src/jobs/kpi-anomaly-detect.ts`
- Tests: `server/src/__tests__/kpi-anomaly.test.ts` (8 cases — stable, drop, spike, trend break, dedup, severity, multi-metric, no-data)

---

### Ticket S3.3 — Daily Founder Brief generator

**PM intent**: Once a day at 7am workspace local time, the CoS agent generates a personalized brief. Lands in Inbox + email. Mobile-friendly format (S6 wraps it for Slack).

**Engineering**:
- New BullMQ recurring job `daily-founder-brief` — scheduled per-workspace based on workspace TZ from `companies.tz`
- Pulls inputs:
  - Yesterday's KPI snapshot vs day-before
  - Open insights last 24h
  - Pending approvals
  - Stalled workflows (workflows.status = 'stalled')
  - Top 3 opportunities (insights with kind=`opportunity`, confidence>0.7, status=open, ranked by impact)
- Calls Claude (existing adapter) with a structured prompt — output is JSON:
  ```ts
  type DailyBrief = {
    headline: string;
    kpiMovements: { metric: string; from: string; to: string; delta: string; commentary: string }[];
    anomalies: { title: string; insightId: string }[];
    blockers: { title: string; resolutionAction: string }[];
    opportunities: { title: string; expectedImpact: string; insightId: string }[];
    topThreeActions: { action: string; rationale: string; approvalId?: string }[];
  };
  ```
- Persists the brief as a new `daily_briefs` row + creates 3 `approvals` rows for the top 3 actions if they require approval
- Sends via existing email service (already configured for welcome emails / weekly wraps)
- Renders in `ui/src/pages/DailyBrief.tsx` at route `/brief` + linked from top bar shortcut (S1.1 placeholder)

**Schema** (new):
```ts
dailyBriefs = pgTable('daily_briefs', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull().references(...),
  forDate: date('for_date').notNull(),
  payload: jsonb('payload').notNull(), // the DailyBrief object
  generatedAt: timestamp().notNull().defaultNow(),
  emailSentAt: timestamp(),
  // unique per (companyId, forDate)
});
```

**QA**:
- Smoke: workspace with seeded data → brief contains 3-5 KPI movements + at least 1 opportunity
- Idempotent: re-run for same date → returns existing brief, doesn't regenerate
- TZ correctness: workspace in PST + workspace in IST — both fire at their local 7am
- Empty workspace (no data) → brief still generates with "Welcome — connect integrations to populate your brief" body

**Files**:
- New: `packages/db/src/schema/daily_briefs.ts`, migration 0082
- New: `server/src/jobs/daily-founder-brief.ts`
- New: `server/src/services/cos/brief-prompt.ts` (LLM prompt template)
- New: `ui/src/pages/DailyBrief.tsx`
- Edit: `ui/src/App.tsx` (add `/brief` route), top bar (link to brief)
- Tests: prompt unit test + worker test + idempotency

---

### Ticket S3.4 — Department Status rollup (replaces S1.1 placeholder)

**PM intent**: The Department Status grid on Dashboard + CoS console (placeholder in S1) becomes real. Health = function of (open insights, pending approvals, agent error state, stalled workflows).

**Engineering**:
- New endpoint `GET /api/companies/:id/department-status` →
  ```ts
  { 'chief-of-staff': { health: 'green', openInsights: 2, pendingApprovals: 0, stalledWorkflows: 0, lastActivity: '2m ago' }, 'growth': {...}, ... }
  ```
- Health logic per department:
  - red: any agent in `error` runtime state OR > 5 pending approvals OR critical anomaly insight open
  - yellow: > 2 stalled workflows OR last activity > 24h ago
  - green: else
- Update `<DepartmentStatusCard />` to consume endpoint; remove placeholder logic from S1.1

**QA**:
- Department with healthy agent + 0 approvals → green
- Department with errored agent → red
- Department with no agents → grey (special "not configured" state)

**Files**:
- New: `server/src/routes/department-status.ts`
- Edit: `ui/src/components/DepartmentStatusCard.tsx`, `ui/src/components/DepartmentStatusGrid.tsx`
- Tests: `server/src/__tests__/department-status.test.ts`

---

### Ticket S3.5 — Experiment backlog (Growth)

**PM intent**: Growth dept's first real screen. Founder sees an ICE-scored experiment list. Each experiment has hypothesis, channel, expected CAC, expected lift, confidence, owner agent, next milestone.

**Engineering**:
- New schema:
  ```ts
  experiments = pgTable('experiments', {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid().notNull().references(...),
    department: text().notNull().default('growth'),
    hypothesis: text().notNull(),
    channel: text(),  // 'linkedin' | 'paid_meta' | 'paid_google' | 'referral' | 'seo' | 'partnerships' | 'content'
    expectedLiftPct: real(),       // e.g., 0.15 = +15%
    expectedCacCents: bigint(),
    iceImpact: integer().notNull(),     // 1..10
    iceConfidence: integer().notNull(), // 1..10
    iceEase: integer().notNull(),       // 1..10
    iceScore: real().generatedAlwaysAs(sql`(ice_impact * ice_confidence * ice_ease)::real / 10`),
    status: text().notNull().default('proposed'), // proposed | running | completed | abandoned
    ownerAgentId: uuid().references(() => agents.id),
    nextMilestone: text(),
    actualLiftPct: real(),     // recorded post-completion
    createdAt: timestamp().notNull().defaultNow(),
    completedAt: timestamp(),
  });
  ```
- API: list/create/update/score endpoints
- UI: `ui/src/pages/departments/GrowthConsole.tsx` "Experiments" tab — backlog list sorted by ICE score desc + filter by status
- Card layout per the PRD: hypothesis | channel | CAC | lift | status | confidence | owner | next milestone

**QA**:
- Create experiment → appears in list
- ICE score auto-computes (DB generated column)
- Sort + filter work
- Schema migration 0083 clean

**Files**:
- New: `packages/db/src/schema/experiments.ts`, migration 0083
- New: `server/src/routes/experiments.ts`
- Edit: `ui/src/pages/departments/GrowthConsole.tsx` (Experiments tab)
- New: `ui/src/components/ExperimentCard.tsx`
- Tests: API + ICE score computation

---

### Ticket S3.6 — Growth agent: experiment suggester

**PM intent**: When the agent runs, it reads recent KPI snapshots + funnel data + LinkedIn metrics, generates 3-5 experiment proposals, writes them to `experiments` with status=`proposed`. Founder reviews + scores or approves.

**Engineering**:
- New service `server/src/services/agents/growth-suggester.ts`
- Triggered from heartbeat run when agent slot is "growth"
- Inputs: last 30d events (filtered by source), open insights, current KPIs
- LLM call (existing adapter) with structured output:
  ```json
  { "experiments": [
    { "hypothesis": "...", "channel": "linkedin", "expectedLiftPct": 0.12, "expectedCacCents": 0, "iceImpact": 8, "iceConfidence": 6, "iceEase": 7, "rationale": "..." }
  ]}
  ```
- Write rows with the LLM's ICE; founder can edit
- Cap at 5 experiments per agent run, dedup against existing `proposed` rows by hypothesis similarity (cosine on embedding via pgvector — verify pgvector available else fallback to title hash)

**QA**:
- Run agent on seeded workspace → 3+ experiments created
- Re-run → no duplicates (similar hypothesis = no new row)
- Bad LLM output (malformed JSON) → run fails gracefully, agent goes to `error` state, anomaly insight created

**Files**:
- New: `server/src/services/agents/growth-suggester.ts`
- New: `server/src/services/agents/__prompts__/growth-suggester.md`
- Tests: mocked LLM, dedup logic

---

### Ticket S3.7 — Funnel diagnostics screen

**PM intent**: Visual funnel from PostHog data. Identifies the worst-performing step. Surfaces "drop-off at step X" insight.

**Engineering**:
- New endpoint `GET /api/companies/:id/funnel` → reads `events` table, computes:
  ```ts
  steps: [
    { name: 'Traffic', count: 1240, dropFromPrev: null },
    { name: 'Signup', count: 280, dropFromPrev: 0.77 },
    { name: 'Activation', count: 95, dropFromPrev: 0.66 },  // ← worst step
    { name: 'Retention', count: 42, dropFromPrev: 0.56 },
    { name: 'Paid', count: 8, dropFromPrev: 0.81 },
  ]
  worstStep: 'Activation'
  ```
- Funnel definition is configurable per workspace (default: `pageview → identify → activated → retained_7d → subscribed`)
- New UI screen: `ui/src/pages/departments/growth/FunnelDiagnostics.tsx` — Recharts funnel chart
- When agent runs and detects worst-step drop > 50%, creates insight: `kind=blocker, title="Funnel drop-off at activation"`

**QA**:
- Workspace with synthetic data → funnel renders 5 steps with correct percentages
- Worst step highlighted visually
- Insight auto-created when threshold crossed
- Empty workspace → "No funnel data — connect PostHog" empty state

**Files**:
- New: `server/src/routes/funnel.ts`
- New: `ui/src/pages/departments/growth/FunnelDiagnostics.tsx`
- Edit: `GrowthConsole.tsx` (add Funnel tab)
- Tests: funnel calc per known dataset

---

### Ticket S3.8 — Channel recommendation engine

**PM intent**: "Move 30% of budget from Meta to LinkedIn — based on signup attribution last 30d." A single insight per agent run if attribution differential > 20%.

**Engineering**:
- Service that aggregates per-channel signup attribution from `events` table
  - For each signup event in last 30d, attribute to the most recent (last-touch) channel event within 7d before
  - Channels: `linkedin`, `meta`, `google`, `direct`, `referral`, `content`
- Compare CAC per channel; if CAC[A] / CAC[B] > 1.5 with > 30 signups each, suggest reallocation
- Write insight: `kind=channel_recommendation` with body containing the table + recommendation

**Edge cases**:
- < 30 signups in window → confidence=0.4 + recommendation prefixed "low-confidence — not enough data"
- Multi-touch attribution: last-touch is v1; first-touch + linear are v2

**QA**:
- Synthetic 100 signups, 80 from LinkedIn, 20 from Meta → recommendation says "double LinkedIn"
- < 30 signups total → low-confidence flag
- Equal CAC across channels → no recommendation

**Files**:
- New: `server/src/services/agents/channel-recommender.ts`
- Tests: attribution math + recommendation thresholds

---

### Ticket S3.9 — LinkedIn growth attribution

**PM intent**: The headline insight from the demo line. "Your LinkedIn founder content drove 32% of signups in the last 30d."

**Engineering**:
- Agent reads `events` filtered to `source='linkedin' AND entity_type='post'` for content
- Cross-references PostHog signup events with LinkedIn URL clicks (via UTM params or post-time correlation if no UTM)
- Computes contribution % per content source — LinkedIn vs other channels
- Writes insight: `kind=attribution, body="X% of signups attributed to LinkedIn founder content over last 30d", confidence=...`
- Surfaces this in CoS Daily Brief as one of the "opportunities"

**QA**:
- Workspace with 50 signups + LinkedIn UTM tags on 16 → insight says 32%
- Workspace with no LinkedIn connection → no insight (skip silently)
- Confidence drops when sample size small

**Files**:
- New: `server/src/services/agents/attribution.ts`
- Tests: attribution math per UTM-tagged + correlation-based scenarios

---

### Ticket S3.10 — Magic activation gate (10-min first-value)

**PM intent**: After onboarding completes (integrations connected), force a "first run" within 10 min so the design partner sees value fast. Empty state on workspace home actively explains: "First brief generates in N minutes."

**Engineering**:
- On onboarding completion, if at least 2 integrations connected (Stripe + PostHog ideally), enqueue a `first-run` job that:
  1. Triggers a backfill of last 90d of events from connected integrations
  2. Once backfill completes, runs all 4 default agent slots (CoS + Growth + Content + Finance)
  3. Generates the first Daily Brief immediately (don't wait for 7am)
  4. Surfaces it via inbox + a "Your first brief is ready" toast
- Show progress UI on workspace home: "Generating your first executive brief… 3/5 steps complete"

**QA**:
- New workspace + connect Stripe + PostHog → within 10 min, dashboard shows ≥ 1 insight + ≥ 1 experiment + Daily Brief
- Connect zero integrations → guidance to connect them, no empty brief generated

**Files**:
- New: `server/src/services/onboarding/first-run.ts`
- Edit: `server/src/services/onboarding-bootstrap.ts` (trigger first-run on completion)
- Edit: workspace home (show first-run progress)
- Tests: end-to-end onboarding → first-run → brief creation

---

## Definition of done

- 10 PRs merged
- ROADMAP.md S3 row updated
- Migrations 0081–0083 land
- Smoke test workspace with seeded data → CoS produces coherent brief, Growth shows scored experiments, funnel renders, channel recommendation appears
- Demo line achievable: "Your LinkedIn founder content is driving 32% of signups."
- `/vanta-sync` after merge

## Notes for the agent

- **CoS agent (S3.3) is the most LLM-heavy ticket — invest in prompt engineering.** The brief is the customer's daily touchpoint.
- **Embeddings via pgvector** for dedup (S3.6) — confirm pgvector extension is enabled on Fly MPG; if not, fallback to title hash dedup.
- **Don't ship raw LLM output to the user.** All outputs go through structured JSON schema validation (Zod). Bad output = run fails + insight created.
- **First-run gate (S3.10) is the activation moat.** Don't let the founder bounce off an empty dashboard.
