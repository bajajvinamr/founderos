# Sprint 2 — Integrations + data layer

_Status: not_started · Effort: 1 week · Depends on: S1 · Blocks: S3, S4, S5_

## Goal

> Connect real company data so the right rail KPIs and department dashboards show **live** MRR, churn, signups, activation, and content attribution — not manually entered `company.metrics` JSON.

## Success criteria

1. A new design partner can connect Stripe, PostHog, LinkedIn, Notion, Slack, HubSpot from `/integrations` in <2 minutes per source
2. Within 5 minutes of connection, the right rail shows live MRR (Stripe), signups + activation (PostHog), and content reach (LinkedIn)
3. Data freshness indicator on every KPI ("synced 2 min ago" / "stale — last sync 4h ago" / "failed — retry")
4. Connector health monitor lists all integrations with status: connected / syncing / failed / never-connected, with retry button per source
5. Canonical `events` table receives normalized events from all sources, queryable by department agents in S3+
6. Webhook ingestion is idempotent — Stripe replay protection + PostHog dedup by event id + retry queue with exponential backoff

QA acceptance: connect Stripe with a test account → 3 fake subscriptions → MRR card shows correct value within 60s. Disconnect → connector health shows "stale" within 5 min.

## What exists today (don't rebuild)

| Surface | Where | Status |
|---|---|---|
| Composio v3 client | `server/src/services/composio-client.ts` | ✓ targets `/api/v3/*`, `connected_accounts` flow live |
| Composio bridge | `server/src/services/skills/composio-skill-bridge.ts` | ✓ writes; needs read/ingest path |
| HubSpot skills | `server/src/services/skills/hubspot-{create-contact,log-note,move-deal}.ts` | ✓ write only |
| Notion skills | `server/src/services/skills/notion-{create-page,append-block}.ts` | ✓ write only |
| Slack skill | `server/src/services/skills/slack-post-message.ts` | ✓ write only |
| Stripe billing webhook | `server/src/routes/billing.ts` | ✓ idempotent (PR #33), but only handles `subscription.*` events |
| Composio connections | `composio_connections` schema | ✓ stores `auth_config_id` per workspace per app |
| Integration data table | `integration-data.ts` schema | ✓ exists; check shape |
| Integrations route | `server/src/routes/integrations.ts` | ✓ partial CRUD |
| OAuth flow | `server/src/routes/oauth.ts` | ✓ for Composio |

**Greenfield**: PostHog (no Composio app for it as of v3 last check; verify on day 1).

## Tickets

---

### Ticket S2.1 — Canonical `events` table + ingestion service

**PM intent**: Every integration writes to one normalized table. Department agents in S3+ query `events` with simple filters, never per-integration table joins.

**Engineering**:
- New schema `packages/db/src/schema/events.ts`:
  ```ts
  export const events = pgTable('events', {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    source: text('source').notNull(), // 'stripe' | 'posthog' | 'linkedin' | 'notion' | 'slack' | 'hubspot'
    entityType: text('entity_type').notNull(), // 'subscription' | 'pageview' | 'post' | 'page' | 'message' | 'contact'
    eventName: text('event_name').notNull(),  // 'subscription.created', 'pageview', 'post.published', etc.
    sourceEventId: text('source_event_id'),    // dedup key (per source)
    occurredAt: timestamp('occurred_at').notNull(),
    receivedAt: timestamp('received_at').notNull().defaultNow(),
    payload: jsonb('payload').notNull(),
  }, (t) => ({
    sourceDedup: unique().on(t.companyId, t.source, t.sourceEventId).nullsNotDistinct(),
    byCompanyTs: index('events_company_occurred_at_idx').on(t.companyId, t.occurredAt.desc()),
    bySourceTs: index('events_source_occurred_at_idx').on(t.companyId, t.source, t.occurredAt.desc()),
  }));
  ```
- New service `server/src/services/event-ingest.ts`:
  ```ts
  export async function ingestEvent(input: {
    companyId: string;
    source: EventSource;
    entityType: string;
    eventName: string;
    sourceEventId?: string;
    occurredAt: Date;
    payload: unknown;
  }): Promise<{ eventId: string; deduplicated: boolean }>;
  ```
  - Idempotent on `(companyId, source, sourceEventId)`
  - Writes to BullMQ `events.derive` queue for downstream KPI calc

**QA**:
- Insert event → returns id
- Insert duplicate (same `companyId + source + sourceEventId`) → returns existing id, `deduplicated: true`
- Migration up/down clean

**Files**:
- New: `packages/db/src/schema/events.ts`, `packages/db/src/migrations/0077_events.sql`
- New: `server/src/services/event-ingest.ts`
- New: `server/src/__tests__/event-ingest.test.ts`

---

### Ticket S2.2 — Stripe ingestion (beyond billing)

**PM intent**: Stripe webhook today only handles `subscription.*`. Extend it to `customer.*`, `invoice.*`, `charge.*`, `customer.subscription.trial_will_end` — all writing to `events` table for downstream MRR/churn/expansion calculation.

**Engineering**:
- Extend `server/src/routes/billing.ts` Stripe webhook handler
- Per event type, call `ingestEvent(...)` with normalized shape
- Don't break existing subscription idempotency logic (PR #33)
- For backfill: new endpoint `POST /api/integrations/stripe/backfill` that paginates Stripe `subscriptions.list` + `customers.list` + `invoices.list` (last 90d) and ingests as events
- Backfill is idempotent (events table dedups)

**Test events to handle**:
- `customer.created`, `customer.updated`, `customer.deleted`
- `customer.subscription.created/updated/deleted/trial_will_end`
- `invoice.created/finalized/paid/payment_failed`
- `charge.succeeded/failed/refunded`

**QA**:
- 14 webhook event types each fire correctly → events row inserted
- Replay (same `stripe-signature` + body) → no duplicate events
- Backfill 100 historical events → 100 rows; replay backfill → 100 rows still

**Files**:
- Edit: `server/src/routes/billing.ts`
- New: `server/src/services/stripe-backfill.ts`
- Tests: extend existing `server/src/__tests__/subscription-idempotency.test.ts`, new `server/src/__tests__/stripe-event-ingest.test.ts`

---

### Ticket S2.3 — PostHog connector (greenfield)

**PM intent**: PostHog is the funnel diagnostics + activation engine. We need pageviews, signups, activation events flowing in. Founder either pastes a PostHog Personal API Key + project id, or uses our hosted instance.

**Engineering**:
- New OAuth-less connection flow (PostHog uses API key auth, not OAuth):
  - `POST /api/integrations/posthog/connect` — accepts `{ projectId, apiKey, host? }` (host defaults to `https://app.posthog.com`)
  - Stores in `composio_connections` row with `app: 'posthog'` and the api key encrypted via existing `company_secrets` flow (NEVER plaintext in DB)
- Webhook receiver: `POST /api/integrations/posthog/webhook` — signature-verified via PostHog HMAC
  - Maps PostHog event types to canonical schema (`source: 'posthog', entity_type: 'pageview' | 'event' | 'identify' | 'capture'`)
- Polling fallback for environments without webhook configured: BullMQ recurring job every 15 min, paginates `/api/projects/:id/events?after=<last_seen_ts>`
- UI: new "Connect PostHog" card in `/integrations` (no Composio dependency since it's not in their library — verify on day 1)

**Open question** (auto-resolve per ROADMAP cross-cutting decision): self-hosted PostHog support? **Default: no — only `app.posthog.com` and `eu.posthog.com` for v1.** Self-hosted comes when first design partner asks.

**QA**:
- Connect with valid key → "Connected" status, last-sync timestamp updates
- Send a test event from PostHog → appears in events table within 30s
- Invalid key → 4xx, no plaintext leak in logs
- Encrypted key stored, retrievable for webhook auth, never written to logs

**Files**:
- New: `server/src/services/integrations/posthog-client.ts`
- New: `server/src/routes/integrations/posthog.ts`
- New: `packages/db/src/migrations/0078_posthog_connections.sql` (if shape doesn't fit existing `composio_connections`)
- Tests: `server/src/__tests__/posthog-connector.test.ts`

---

### Ticket S2.4 — LinkedIn data ingestion (read path)

**PM intent**: Composio LinkedIn connection exists for posting (write). S2 adds the **read** path — fetch post performance + follower deltas + post engagement, normalize into events.

**Engineering**:
- Audit Composio v3 LinkedIn read tools (likely `linkedin_get_posts`, `linkedin_get_post_metrics`, `linkedin_get_followers` — verify via `composio.tools.list({ toolkits: ['linkedin'] })`)
- New BullMQ recurring job: every 1h fetch posts from last 30d for connected workspaces
- Map each post to `events` row (`entity_type: 'post', event_name: 'post.metrics_snapshot'`)
- Track follower count daily as a metric event

**Edge cases**:
- Rate limit: LinkedIn API caps; add backoff
- Cross-org connection (we just fixed this in PR #30) — must thread `connectedAccountId` through

**QA**:
- Workspace with 5 posts → 5 events ingested in next sync
- Re-run sync → no duplicates (dedup on post id)
- Workspace with no LinkedIn connection → sync skips, no error

**Files**:
- New: `server/src/services/integrations/linkedin-ingest.ts`
- Edit: BullMQ scheduler config
- Tests: mocked Composio responses

---

### Ticket S2.5 — HubSpot read path (CRM data)

**PM intent**: HubSpot today writes (create-contact, log-note, move-deal). S2 adds the read path — pull contacts, deals, lifecycle stages, properties — for funnel diagnostics + churn analysis.

**Engineering**:
- Use existing Composio `connectedAccountId` (per PR #30 fix)
- Recurring job every 30 min: fetch contacts modified since last sync
- Map to events: `entity_type: 'contact', event_name: 'contact.created' | 'contact.lifecycle_changed'`
- Same for deals: `entity_type: 'deal', event_name: 'deal.stage_changed' | 'deal.closed_won' | 'deal.closed_lost'`
- Track watermark per workspace (last sync timestamp) to avoid re-pulling everything

**QA**:
- Connect HubSpot → first sync pulls all contacts (or last 90d cap)
- Subsequent syncs only fetch deltas
- Test for the cross-org leak case — connection-A workspace cannot see connection-B contacts

**Files**:
- New: `server/src/services/integrations/hubspot-ingest.ts`
- Tests: mocked Composio HubSpot responses + cross-org leak regression test

---

### Ticket S2.6 — Notion + Slack ingestion (knowledge layer)

**PM intent**: Notion docs + Slack messages flow in (read-only) so the CoS agent in S3 can reason over them. S2 just gets the data flowing.

**Engineering**:
- Notion: list databases + pages founder explicitly grants access to (don't slurp the workspace). Per-page, ingest title + last_edited_time → events `entity_type: 'page'`
- Slack: only channels the bot is invited to (existing Composio Slack connection). Ingest channel messages last 24h on rolling window. Strip PII (email regex) before storing in `payload`.

**Privacy constraint**: agent in S3 must NEVER ingest user-private DMs. Limit to: explicitly-shared channels in Slack, explicitly-granted pages in Notion.

**QA**:
- Slack: bot in 2 channels → only those 2 channels appear in events
- Notion: 1 shared page → 1 event row; un-share → next sync stops ingesting (last sync record stays)
- PII redaction test: email in Slack message → `[email-redacted]` in payload

**Files**:
- New: `server/src/services/integrations/notion-ingest.ts`, `slack-ingest.ts`
- Tests: PII redaction (5 cases), permission scope, dedup

---

### Ticket S2.7 — Connector health monitor + freshness indicators

**PM intent**: Founder needs to know which integrations are healthy at a glance. New page section + per-KPI freshness indicator.

**Engineering**:
- New schema column on `composio_connections` (or new `connector_health` table): `lastSyncAt`, `lastSyncStatus` (`ok|fail|partial`), `lastError`, `consecutiveFailures`
- New endpoint: `GET /api/integrations/health` → `[{ source, status: 'connected' | 'syncing' | 'failed' | 'never_connected', lastSync, lastError, retryAvailable }]`
- New component: `<ConnectorHealthGrid />` for `/integrations` page
- Modify right-rail KPI tiles to read freshness: each tile renders a 2nd line "synced Xm ago" (red if stale > 1h, yellow if > 15min, green if < 15min)
- New endpoint: `GET /api/companies/:id/kpi-freshness` → `{ mrr: { sourceLastSync }, signups: { sourceLastSync }, ... }`

**QA**:
- Healthy state: all 6 sources show green
- Disconnect Stripe → status: failed, MRR tile shows red "stale" within 5 min
- Retry button on failed source → triggers sync, status moves to syncing then ok

**Files**:
- New: `packages/db/src/migrations/0079_connector_health.sql`
- Edit: `composio_connections` schema
- New: `server/src/routes/integration-health.ts`
- New: `ui/src/components/ConnectorHealthGrid.tsx`
- Edit: `ui/src/components/CompanyPulseWidget.tsx` (add freshness indicators)
- Tests: per-state rendering, stale-threshold logic

---

### Ticket S2.8 — Sync retry queues + dead-letter

**PM intent**: Webhook + polling failures don't cause data loss. Failed events go to DLQ; observable on the connector health page.

**Engineering**:
- BullMQ retry config per ingest queue: `attempts: 5, backoff: { type: 'exponential', delay: 30_000 }`
- DLQ: jobs that fail all 5 attempts move to `events.dlq` queue (BullMQ `failedReason` set)
- New endpoint: `GET /api/integrations/dlq` → list failed jobs with retry button
- Webhook return semantics: 2xx if event accepted (queued); 4xx only on signature/auth fail

**QA**:
- Inject ingest failure 6× → first 5 retry per backoff schedule, 6th fails permanently → row in DLQ
- DLQ retry button → pushes back into main queue
- Webhook handler returns 200 even when downstream queue is paused (don't make Stripe think delivery failed when it's our problem)

**Files**:
- Edit: BullMQ queue configs (`server/src/queues/...`)
- New: `server/src/routes/integration-dlq.ts`
- Tests: retry exhaustion, DLQ replay

---

### Ticket S2.9 — Live KPI calculation jobs

**PM intent**: Right-rail KPIs read from `events` table via aggregated queries. Calc jobs run on event insert (push) + nightly (refresh).

**Engineering**:
- New job `kpi-calc` triggered by every `events.derive` queue item:
  - For Stripe events: recompute MRR (sum of active recurring subs in cents), expansion, churn (canceled - new in last 30d)
  - For PostHog events: signups (`identify` events last 7d), activation (custom event configured per workspace, default `activated`)
  - For LinkedIn events: content reach (sum of impressions last 30d)
  - For HubSpot events: pipeline value (sum of open deals)
- Persist computed KPIs into `company_kpi_snapshots` (new table) so the right rail reads from this, not from `events` directly (slow scan)
- Backfill job that runs once after S2 ships to populate snapshots from existing events

**Schema**:
```ts
companyKpiSnapshots = pgTable('company_kpi_snapshots', {
  companyId: uuid().notNull().references(...).primaryKey(),
  // one row per company; latest snapshot
  mrrCents: bigint('mrr_cents'),
  signups7d: integer('signups_7d'),
  activationRate: real('activation_rate'),
  churn30d: real('churn_30d'),
  // ... all 9 KPIs from CompanyPulseWidget
  computedAt: timestamp('computed_at').notNull(),
});
```

**QA**:
- Insert subscription event → MRR snapshot recomputes within 5s
- 1000 events backfilled → snapshot reflects them after backfill job completes
- KPI tile reads from snapshot in <50ms (perf check)

**Files**:
- New: `packages/db/src/schema/company_kpi_snapshots.ts`, migration 0080
- New: `server/src/jobs/kpi-calc.ts`
- Edit: `ui/src/components/CompanyPulseWidget.tsx` to read from snapshot endpoint
- Tests: per-KPI calc correctness

---

### Ticket S2.10 — Integrations page UX polish

**PM intent**: One page where founder manages all 6 integrations. Connect / disconnect / health / retry / last-sync.

**Engineering**:
- Audit existing `/integrations` page (likely uses Composio inline cards)
- New layout: 6 cards (Stripe, PostHog, LinkedIn, Notion, Slack, HubSpot) with consistent shape:
  - Connection status badge
  - Last sync timestamp + button "Sync now"
  - Disconnect button with confirm
  - "View errors" link if failed
- Empty state per integration: "Connect to start tracking [X]"

**QA**:
- All 6 integrations visible, even unconnected
- Connect flow works for each (Stripe = redirect to Stripe, PostHog = key paste, others = Composio OAuth)
- Sync now button triggers immediate poll, returns within 5s

**Files**:
- Edit: `ui/src/pages/Integrations.tsx` (verify exact filename)
- New: `ui/src/components/IntegrationCard.tsx`

---

## Definition of done

- 10 PRs merged (S2.1–S2.10)
- ROADMAP.md S2 row updated
- Migrations 0077–0080 land via release_command
- 6 integrations connectable end-to-end
- Right rail shows live MRR (Stripe), signups (PostHog), pipeline (HubSpot) — verified manually with a test workspace
- Connector health page exists, all 6 sources visible
- DLQ exists, observable, replayable
- `/vanta-sync` after merge

## Notes for the agent

- **PostHog (S2.3) is the only greenfield connector — start there.** Others extend existing Composio infrastructure.
- **Cross-org leak regression (PR #30) — every read-path ingest must thread `connectedAccountId`.** Add a regression test per ticket.
- **Stripe webhook (S2.2) extends existing handler — don't break PR #33's idempotency.**
- **Schema migrations: council before merge.** Specifically S2.1 (events), S2.7 (connector_health), S2.9 (kpi_snapshots).
- **No Kafka, no event bus, no Inngest.** BullMQ + pg is the surface. Don't widen.
- **Don't ingest PII without redaction.** Slack (S2.6) has explicit redaction step.
- **PostHog hosted only (not self-hosted)** for v1 per ROADMAP cross-cutting decision.
