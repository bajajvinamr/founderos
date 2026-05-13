# MIRA-LABS-MONTH-1.md

**Seed brief for FounderOS deep-dogfood.** Implementation agents follow this spec to produce coherent, narratively-connected data so the Mira Labs persona looks like a lived-in 30-day-old company — not a fresh signup.

- **Today (run date):** `2026-05-13`
- **Window seeded:** `2026-04-13` (Day 1) → `2026-05-13` (Day 30, "today")
- **Anita Mehra (founder) user id:** `9b29fdf9-2ddb-4919-8fd2-77e4640849c9`
- **Mira Labs company id:** `f4784c65-8aa4-4d47-b388-f2afdbaec00b`
- **Agent IDs (already seeded — fetch at runtime):** Maya / Theo / Iris — `SELECT id, name FROM agents WHERE company_id = '<MIRA>'`
- **Issue identifier prefix:** `MIR-` (counter starts at 6; first new issue is `MIR-006`)
- **All synthetic rows MUST be tagged** with `metadata.persona = 'mira-labs-dogfood'` where the table has a `metadata jsonb` column. Where the table has none, scope by `company_id = <MIRA>` only.
- **Timezone:** Anita is `Asia/Kolkata` (IST = UTC+05:30). Workdays = Mon–Fri IST. "Morning" peak = 07:00–11:00 IST. "Evening" peak = 18:00–22:00 IST.

---

## 1. Narrative — what Mira Labs is

**Mira Labs** is a solo AI/automation consultancy founded by **Anita Mehra**, an ex-Google PM (Bangalore office, 2018–2024, Workspace AI org) who left in November 2025 to build her own thing. She has the technical chops to wire Composio/Claude integrations herself, but the bottleneck is *founder-time*: discovery calls, proposal writing, retainer summaries, invoice chasing, daily standups. FounderOS is her way to clone herself for the back-office.

**Wedge:** "Back-office AI for SMBs who can't hire a CTO." Companies of 20–150 staff with a single painful manual process (support triage, invoice reconciliation, onboarding paperwork). 4-week audit → 3-month implementation retainer → ongoing $1.5–$3K/mo support. Bangalore-anchored but works in English-language IST overlap.

**Stage:** Bootstrapped · Year 1. **$6,400 MRR · 4 retainer clients · $1.8K monthly burn · ~18 months runway** (savings + retainers). Goal: **$10K MRR by August 2026.** No external capital. No employees.

**4 current customers** (all on Stripe monthly retainer):
1. **Northwood Dental** — Bangalore, 3-clinic dental group. Contact: Dr. Sharma. **$1,800/mo.** AI intake-form processor + appointment-reminder workflow. Signed Feb 2026. Anchor account.
2. **Bake House** — Mumbai bakery chain, 6 locations. Contact: Jason (Ops). **$1,200/mo.** Inventory-reorder assistant. Signed March 2026. *Currently 6 days overdue on May invoice — major narrative thread.*
3. **Clearview Legal** — Delhi law firm, 12 lawyers. Contact: Priya Iyer (Partner). **$2,400/mo.** Contract-clause-extraction + matter-summary assistant. Signed Jan 2026. Largest account.
4. **Shore Capital Advisors** — Bangalore boutique PE, 8 staff. Contact: Rahul Menon (Principal). **$1,000/mo.** Investment-memo formatter. Signed April 2026. Newest.

**3 active prospects** (already-seeded issues MIR-001..003):
- **Acme Retail** — 50-person retail chain, Bangalore. Met at Nasscom event 2026-05-08. AI customer-support automation. ~$2K/mo + $3,500 setup. **Proposal drafted, awaiting Anita's review — Day 30 cliffhanger.**
- **Fielding Logistics** — 120-person freight company, Chennai. Discovery call booked May 14. AI invoice-reconciliation. ~$2K/mo. Hot.
- **SkyBridge Insurance** — 25-staff broker, Bangalore. Warm intro from Northwood Dental. ~$1.5K/mo. Lukewarm.

**The 3 agents (board):**
- **Maya — Chief of Staff** · `anthropic_api` · **claude-opus-4-6** · $150/mo budget. *Reasoning-heavy synthesis role.* Reads Slack #mira-team and Gmail every morning, produces the daily brief, identifies pending approvals, drafts standups, escalates blockers. Highest-trust agent. Opus chosen because the daily brief requires multi-source synthesis + judgment calls about what surfaces to Anita.
- **Theo — Growth & BD** · `openai_api` · **gpt-4.1-mini** · $100/mo budget. *High-frequency drafting role.* Consumes discovery-call transcripts, drafts proposals/follow-ups/cold-outreach. 4.1-mini chosen because the work is templated and cost-sensitive (every prospect is a multi-turn drafting cycle); GPT's instruction-following on structured outputs is the right fit.
- **Iris — Finance** · `anthropic_api` · **claude-sonnet-4-6** · $80/mo budget. *Reliable scheduled-task role.* Runs 1st/15th + on-demand. Checks Stripe, flags overdue invoices, drafts monthly retainer summaries + Friday finance digest. Sonnet 4.6 chosen because the work is high-volume but bounded — needs consistency, not maximum reasoning.

**FounderOS adoption:** Day 1 = `2026-04-13`. Anita signed up after a Twitter rec from a YC friend. First two days were setup. By Day 30 she has 4 retainer clients with the agents fully wired, has approved ~30 actions through the Inbox, and has captured one major pivot decision in `company_memory`.

---

## 2. The 30-day story arc

The arc is the temporal scaffolding. Implementation agents MUST follow it; do NOT generate random timestamps. Reference dates are IST.

### Week 1 — Setup + first wiring (Apr 13 Mon → Apr 19 Sun)
- **Day 1 (Apr 13 Mon):** Anita signs up. Onboarding completes. Three agents created. **Composio: Slack + Gmail OAuth connected (status `active`)**. First Maya wakeup at 11:34 IST — produces a "hello world" daily brief (sparse — no signal yet). 1 `agent_run` for Maya, succeeded. **Daily brief Day 1: 1 KPI movement (MRR baseline), 0 anomalies, 0 approvals.**
- **Day 2 (Apr 14 Tue):** **Composio: Stripe connected**. Iris first wakeup at 18:12 — flags one upcoming invoice (Bake House April). 1 Iris run.
- **Day 3 (Apr 15 Wed):** Iris runs **scheduled (15th-of-month retainer summary)**. Drafts 4 summaries — one per active client. 4 approvals queued. **Anita approves all 4 in a 6-minute Inbox session at 20:30 IST.** 1 Iris run, 1 Maya run. First daily brief that actually feels useful.
- **Day 4–5 (Apr 16–17):** Theo gets first work — Anita pastes a Clearview Legal email asking about scope expansion. Theo drafts the reply. 2 Theo runs total. Maya keeps producing daily briefs.
- **Day 6–7 (Apr 18–19 Sat/Sun):** Weekend — sparse activity. Maya only runs once per day (lightweight weekend mode). No Theo, no Iris runs. **First Weekly Wrap fires at Fri Apr 17 17:00 IST → `weekly_wraps` row #1 inserted.** Slack delivery succeeds; email pending.

### Week 2 — First inbound + agents prove useful (Apr 20 Mon → Apr 26 Sun)
- **Day 8 (Apr 20 Mon):** Anita does a discovery call with Shore Capital. Pastes the transcript into Theo's input. Theo drafts the proposal in 8 minutes (vs the historical 4 hours). **First "wow moment" — recorded in `company_memory` as a `pattern` category entry: "Theo proposal drafting cut from 4h to 8min — 30x speedup."**
- **Day 9 (Apr 21 Tue):** Anita approves and sends the Shore Capital proposal. **Insight surfaced by Theo (department=growth, kind=opportunity): "Proposal velocity unlocked — pipeline throughput now bottlenecked by discovery-call count, not drafting capacity. Recommendation: book 2x more discovery calls."** Anita acts on it (status → `acted_on`).
- **Day 10–11 (Apr 22–23):** Shore Capital signs. **`customers_signed` goes from 3 → 4.** Iris detects the new Stripe customer, fires a welcome retainer-onboarding draft (approval queued). Anita approves. **First `decision_outcomes` row stamped (~14d later cron, so this lands on Day 24).**
- **Day 12 (Apr 24 Thu):** **First failed run.** Theo's third proposal draft for a now-irrelevant prospect ("Verdant Foods" — ghosted) fails at the OpenAI API layer (rate limit, code 429). The run gets `status=failed`, `errorCode=rate_limit_exceeded`. Maya picks up the failure in the next morning's brief as a `blocker`. Anita retries manually 30 min later — succeeds. The failure becomes evidence in `company_memory` of "OpenAI rate-limits on parallel runs above 4 concurrent."
- **Day 13–14 (Apr 25–26 Sat/Sun):** Weekend, sparse. Weekly Wrap #2 fires Fri Apr 24.

### Week 3 — Pivot decision (Apr 27 Mon → May 3 Sun)
- **Day 15–16 (Apr 27–28):** Anita has back-to-back conversations with two prospects in DIFFERENT verticals — **(a) a 200-person manufacturing-floor SaaS**, and **(b) a 30-person mid-market law firm cluster**. Both want serious work. She can pursue at most one wedge in Q3.
- **Day 17 (Apr 29 Wed):** Anita runs the question through Maya as an unstructured prompt ("which wedge gives me $10K MRR faster?"). Maya synthesizes the two opportunities + the existing 4 customers' verticals (1 dental, 1 bakery, 1 legal, 1 PE) and recommends doubling down on **professional services (legal/PE/insurance)** — vs manufacturing. The Clearview Legal account already proves the legal wedge works; the manufacturing one would be a fresh GTM motion.
- **Day 18 (Apr 30 Thu):** **THE PIVOT DECISION.** Anita captures the call in `company_memory` as `category=decision`, pinned=true: *"Pivoting wedge to professional services (legal, PE, insurance). Killing manufacturing prospects in pipeline. Will refresh Theo's prompt template to emphasise compliance/document-extraction angle."* Theo's prompt is updated (an `agent_config_revisions` row records the change). The Verdant Foods (manufacturing) prospect is `cancelled`.
- **Day 19 (May 1 Fri):** **Iris monthly retainer summary cron fires** (1st of month). 4 summaries drafted. Anita approves 3 immediately; the 4th (Bake House) she revises ("ask Jason about the overdue payment in the same email"). Iris records `status=revision_requested` then `approved` after Anita's edit.
- **Day 20 (May 2 Sat):** Weekend. Weekly Wrap #3 fires.
- **Day 21 (May 3 Sun):** Anita does a "stress reflection" — writes a long founder-note via `company_memory` (`kind=founder_note`, source=manual): *"3 weeks in. Theo + Iris feel like real co-workers. Maya's morning brief is the first thing I read. I'm still nervous about Bake House — the overdue invoice is a churn signal not a cashflow issue."*

### Week 4 — Momentum + first paying customer onboarded fully (May 4 Mon → May 10 Sun)
- **Day 22 (May 4 Mon):** Theo, with new pro-services prompt, drafts the **SkyBridge Insurance** opening pitch. Cold-outreach approval queued, approved, sent.
- **Day 23 (May 5 Tue):** Bake House DOES NOT respond to the standard retainer-summary email. Iris flags it as a blocker. Maya elevates it in the daily brief.
- **Day 24 (May 6 Wed):** **`decision_outcomes` cron fires** for the Shore Capital signing decision (made Day 10, +14d window). Row inserted with `outcomeStatus=worked`, founderNote: "Signed at full rate. Retainer running cleanly. Onboarding took 4 days vs target 7."
- **Day 25 (May 7 Thu):** **Bake House invoice falls due** ($1,200). Stripe webhook event ingested. Iris's 15th-of-month run is still ~8d away, so the overdue won't fire from her scheduled path — but **Maya picks it up via the daily-brief blocker logic on Day 26.**
- **Day 26 (May 8 Fri):** **Nasscom event — Anita meets Acme Retail's COO. Hot lead.** Notes pasted into FounderOS as `MIR-001` (already seeded). Theo drafts the proposal that evening. Weekly Wrap #4 fires.
- **Day 27 (May 9 Sat):** Anita reviews proposal draft, makes edits in the comments thread.
- **Day 28 (May 10 Sun):** **Insight surfaced by Iris (department=finance, kind=blocker):** "Bake House $1,200 invoice 3 days overdue. 2nd overdue event in 6 months — possible at-risk customer. Recommend payment reminder + scope conversation." Anita reads, doesn't act yet.

### Week 5 — Today, Day 30 cliffhanger (May 11 Mon → May 13 Wed)
- **Day 29 (May 11 Mon):** Anita approves the payment-reminder draft (already in the pre-seeded approval `a4`). It gets sent. Bake House still doesn't reply. Iris drafts April retainer summary for Northwood Dental (already in approval `a5`, pre-seeded).
- **Day 30 (May 12 Tue) — yesterday:** Theo finalises Acme Retail proposal draft. Anita comments back-and-forth twice. Late-night Maya run summarises tomorrow's priorities.
- **Day 31 = TODAY (May 13 Wed):** The pre-seeded daily brief is the cliffhanger payoff: "*2 client emails need replies; Acme Retail proposal draft ready for your review.*" Fielding Logistics discovery call is tomorrow. Bake House still hasn't paid. **The founder mood: "this is starting to compound."**

**Why this arc works:** every record threads back to a moment Anita lived. Approvals reference real-sounding clients. The pivot decision in `company_memory` is cited by Theo's later prompt change. The Bake House thread spans Days 23 → 30. The Shore Capital signing creates a Stripe event, a `customers_signed` delta, a `decision_outcomes` row, and an insight. No orphan rows.

---

## 3. Schema inventory + per-table specs

For each table: (a) FK chain back to `companies.id` / `user.id`, (b) required cols, (c) CHECK/UNIQUE constraints, (d) row-count target, (e) content + temporal spec, (f) cross-table coherence rules.

> **Convention used below:**
> - **`<MIRA>`** = `f4784c65-8aa4-4d47-b388-f2afdbaec00b` (Mira Labs company id)
> - **`<ANITA>`** = `9b29fdf9-2ddb-4919-8fd2-77e4640849c9` (Anita Mehra Supabase user id)
> - **`<MAYA>` / `<THEO>` / `<IRIS>`** = looked up at runtime via `SELECT id FROM agents WHERE company_id=<MIRA> AND name IN ('Maya','Theo','Iris')`

### 3.1 `agents` — already seeded (3 rows)
- FK: `company_id → companies.id`. No new rows. Implementations FETCH the IDs.
- **Implementation agents MUST NOT INSERT into `agents`.** They MUST `UPDATE` Theo's `adapter_config.promptTemplate` once (Day 18 pivot) — recorded via `agent_config_revisions` insert.

### 3.2 `agent_config_revisions`
- FK: `agent_id → agents.id`, `company_id → companies.id`.
- Look up file at `/Users/vinamr/Projects/founderos/packages/db/src/schema/agent_config_revisions.ts` for exact columns; expected required cols: `companyId`, `agentId`, `revisionNumber` (or similar version field), `prevAdapterConfig` jsonb, `newAdapterConfig` jsonb, `changedByUserId`, `createdAt`.
- **Row count:** 1 (the Day 18 Theo prompt swap).
- **Content:** prev = original Theo prompt (manufacturing-friendly), new = pro-services-emphasising prompt. `changedByUserId = <ANITA>`. `createdAt = 2026-04-30T14:22:00+05:30`.

### 3.3 `heartbeat_runs` (the "agent runs" table)
This is the run table. FK: `company_id → companies.id`, `agent_id → agents.id`. Composite tenant FK enforces `(agent_id, company_id)` matches a real agent row.
- **CHECK constraint:** `status IN ('queued','running','succeeded','failed','cancelled','timed_out','coalesced')`.
- **Required cols:** `companyId`, `agentId`, `invocationSource` (`scheduled` | `on_demand` | `wakeup` — text, not constrained), `status`, `startedAt`, `finishedAt` (null for in-progress), `usageJson`, `resultJson`, `stdoutExcerpt`, `stderrExcerpt` (excerpt is fine, ≤500 chars).

**Row count targets (30-day window, Apr 13 → May 13):**

| Agent | Total runs | succeeded | failed | timed_out | cancelled | running (today) |
|---|---|---|---|---|---|---|
| Maya | 50 | 47 | 2 | 0 | 0 | 1 |
| Theo | 90 | 78 | 8 | 2 | 1 | 1 |
| Iris | 35 | 33 | 1 | 1 | 0 | 0 |
| **TOTAL** | **175** | **158** | **11** | **3** | **1** | **2** |

**Time distribution:**
- **Maya:** 1 run per weekday 07:00–09:30 IST (morning brief) + 1 wakeup most evenings 18:00–21:00 IST. Saturdays 1 run only. Sundays: skip (5 of 5 Sundays have 0 runs except the Apr 13 Day-1 hello-world).
- **Theo:** Bursty — clusters of 3–6 runs in a workday when Anita is drafting proposals (Days 8, 9, 17, 22, 26, 27, 30). 0–1 runs on filler days. Never on weekends.
- **Iris:** Scheduled spikes on **15th** (Apr 15, May 15 was tomorrow but didn't fire yet → omit) and **1st** (May 1). 4–5 runs per spike day. Plus 1–2 on-demand runs/week. Weekend runs only if a Stripe event triggers a wakeup (~2 total in 30d).

**Status distribution detail:**
- Maya's 2 failures: one on Apr 14 (Composio Slack rate-limit) `errorCode=composio_rate_limit`, one on May 5 (Anthropic 529 overloaded) `errorCode=anthropic_overloaded`. Both followed by a `retryOfRunId` row that succeeded.
- Theo's 8 failures: 3 OpenAI rate-limit (`errorCode=openai_rate_limit_429`), 2 prompt validation (Zod boundary, `errorCode=prompt_validation_failed`), 2 hit max-turn limit (`errorCode=max_turns_reached`), 1 stale context (`errorCode=session_id_mismatch`).
- Theo's 2 timeouts: Day 12 (Verdant Foods proposal — gave up after 90s), Day 23 (long Acme transcript).
- Theo's 1 cancellation: Day 18 Anita cancelled a Verdant Foods run mid-flight when she made the pivot decision (`cancelledAt` set).
- Iris's 1 failure: Stripe API timeout on Apr 30 (`errorCode=stripe_timeout`).
- Iris's 1 timeout: a particularly long retainer summary on Day 19.

**Cost data — `usageJson` shape:**
```json
{ "input_tokens": 4200, "output_tokens": 850, "cached_input_tokens": 1100,
  "model": "claude-opus-4-6", "cost_usd": 0.087, "duration_ms": 8400 }
```
Maya runs average ~5K input / ~1K output tokens at $0.05–0.10 each. Theo runs ~3K/800 at ~$0.01–0.02. Iris ~4K/600 at ~$0.03–0.05.

**`resultJson` shape (succeeded runs only):**
- Maya: `{ "brief_generated_for": "2026-04-21", "approvals_surfaced": 2, "blockers_count": 0 }`
- Theo: `{ "drafted_format": "proposal", "client_name": "Shore Capital", "approval_id": "<uuid>", "word_count": 412 }`
- Iris: `{ "stripe_invoices_checked": 4, "overdue_count": 0, "summaries_drafted": 0, "approvals_queued": 0 }`

**`stdoutExcerpt`:** a 1–3 line summary string. Example for a succeeded Theo run:
> `[Theo] Drafted proposal for Shore Capital · 412 words · scope: 4 bullets · pricing $1,500/mo + $2,500 setup · queued approval id 7e3f...`

**Coherence rules:**
- Every approval (see §3.6) MUST have a `requestedByAgentId` whose latest `heartbeat_runs` row for that agent has `resultJson.approval_id` pointing back. Approvals without a triggering run are invalid.
- Every issue created by an agent (see §3.5) — `createdByAgentId IS NOT NULL` — MUST link to a `heartbeat_runs.id` via `issues.checkoutRunId`.
- Every `failed` run MUST have non-null `error`, non-null `errorCode`, and a sibling retry run (or no retry only if the founder gave up — flag in `stderrExcerpt`).

### 3.4 `heartbeat_run_events`
- FK: `company_id`, `run_id → heartbeat_runs.id`, `agent_id → agents.id`. `seq` integer (monotonic per run starting at 1).
- **Row count:** ~6 events per succeeded run, ~3 per failed run. **TOTAL ≈ 1000.**
- **Per-run event shapes:**
  1. `seq=1` `event_type=run.started` `level=info` `message="Run started; invocationSource=<source>"`
  2. `seq=2` `event_type=tool.invoked` `payload={ "tool": "composio.slack.read", "args": "..." }`
  3. `seq=3` `event_type=stream.output` `level=info` `message="<snippet of model response>"`
  4. `seq=4` `event_type=tool.invoked` (if multi-tool)
  5. `seq=5` `event_type=approval.queued` `payload={ "approvalId": "<uuid>" }` (when applicable)
  6. `seq=6` `event_type=run.completed` `level=info` `message="Run completed; tokens=4200/850, cost=$0.087"`
- For failed runs the final event is `event_type=run.failed` `level=error` `message="<error message>"`.
- Implementation hint: it's acceptable to emit only 2 events per "filler" Maya morning run (started + completed) to keep total rows down — target ~1000, not 1500.

### 3.5 `issues` — 5 already seeded; target **35 total** (30 new)
FK chain: `company_id`, optional `project_id`, optional `goal_id`, optional `assignee_agent_id`, optional `created_by_agent_id`, optional `checkout_run_id → heartbeat_runs.id`.
- **CHECK / UNIQUE:** `identifier` is UNIQUE across all companies (`issues_identifier_idx`). Use `MIR-006` through `MIR-035`. The `issues.issueNumber` integer should match the suffix (6..35).
- **Status enum:** `['backlog','todo','in_progress','in_review','done','blocked','cancelled']`. **Priority enum:** `['critical','high','medium','low']`.
- **origin_kind enum:** `['manual','routine_execution']`.

**Status distribution (35 total including 5 existing):**
- `done`: 18 (52%) — completed work over the 30-day window
- `in_progress`: 5 (existing MIR-001 + 4 more)
- `todo`: 6 (existing MIR-002, 004 + 4 more)
- `backlog`: 4 (existing MIR-003 + 3 more)
- `in_review`: 1 (Acme Retail proposal — under Anita's review)
- `blocked`: 1 (Bake House overdue thread)
- `cancelled`: 1 (Verdant Foods, killed in pivot)
- Plus existing MIR-005 `in_progress`. **Total = 36.** Acceptable variance.

**Content patterns (new issues 006–035):**

Create issues that map directly to events in the arc. Examples (NOT exhaustive — produce variants in the same style):
- `MIR-006` (Apr 13, done): "FounderOS — connect Slack via Composio" · `assignee_user_id=<ANITA>` · originKind=manual.
- `MIR-007` (Apr 14, done): "Iris — first Stripe invoice review" · assigneeAgentId=Iris · createdByAgentId=Iris.
- `MIR-008` (Apr 15, done): "Clearview Legal — April retainer summary" · IRIS · routine_execution-origin.
- `MIR-009` (Apr 15, done): "Bake House — April retainer summary" · IRIS · routine_execution-origin.
- `MIR-010` (Apr 15, done): "Northwood Dental — April retainer summary" · IRIS · routine_execution-origin.
- `MIR-011` (Apr 17, done): "Clearview Legal — scope expansion reply" · THEO.
- `MIR-012` (Apr 20, done): "Shore Capital — discovery call proposal draft" · THEO.
- `MIR-013` (Apr 21, done): "Shore Capital — proposal sent" · ANITA (user-created).
- `MIR-014` (Apr 23, done): "Shore Capital — contract signed, kick-off scheduled" · ANITA.
- `MIR-015` (Apr 24, **cancelled**): "Verdant Foods — manufacturing prospect proposal" · THEO. `cancelledAt=2026-04-30T...`.
- `MIR-016` (Apr 24, done): "Maya — morning brief flagged Verdant Foods rate-limit failure" · MAYA. *(meta — Maya documented her own failure)*
- `MIR-017` (Apr 27, done): "Discovery call — manufacturing prospect (TBD)" · ANITA.
- `MIR-018` (Apr 28, done): "Discovery call — mid-market law cluster" · ANITA.
- `MIR-019` (Apr 29, done): "Pivot decision — professional services wedge" · ANITA. Description: "Captured in `company_memory` (see decision row, Apr 30)."
- `MIR-020` (Apr 30, done): "Theo — update prompt template for pro-services positioning" · MAYA created, ANITA actioned.
- `MIR-021` (May 1, done): "Northwood Dental — May retainer summary" · IRIS · routine_execution.
- `MIR-022` (May 1, done): "Bake House — May retainer summary (revised with payment ask)" · IRIS. *Comments thread (see §3.7) captures Anita's revision.*
- `MIR-023` (May 1, done): "Clearview Legal — May retainer summary" · IRIS.
- `MIR-024` (May 1, done): "Shore Capital — first month welcome retainer summary" · IRIS.
- `MIR-025` (May 4, in_progress): "SkyBridge Insurance — cold outreach drafting" · THEO.
- `MIR-026` (May 5, **blocked**): "Bake House — chase response to retainer summary" · MAYA. Description references blocking on Bake House non-response.
- `MIR-027` (May 6, done): "Shore Capital — decision outcome captured" · MAYA. (Linked to `decision_outcomes` row.)
- `MIR-028` (May 8, **in_review**): "Acme Retail — proposal draft for Anita's review" · THEO. ↑ Cross-ref MIR-001.
- `MIR-029` (May 9, todo): "Fielding Logistics — discovery call prep (May 14)" · THEO.
- `MIR-030` (May 9, todo): "Fielding Logistics — prep deck slides" · THEO.
- `MIR-031` (May 10, todo): "Bake House — second payment reminder if no response by May 14" · IRIS.
- `MIR-032` (May 11, done): "Approve payment reminder to Bake House" · ANITA.
- `MIR-033` (May 11, todo): "Northwood Dental — June scope confirmation reply" · MAYA.
- `MIR-034` (May 12, backlog): "SkyBridge Insurance — schedule first call" · THEO.
- `MIR-035` (May 13, backlog): "Q3 planning — refresh OKRs given pivot" · ANITA.

**Coherence rules:**
- Every `done` issue MUST have `completed_at` set within the 30-day window, AFTER its `created_at`.
- Every agent-assigned issue with `status='done'` MUST link to at least one `heartbeat_runs` row via `execution_run_id` (the agent's successful run that did the work).
- Issues created by Iris on Apr 15 / May 1 should set `originKind='routine_execution'` and `originId` to a synthesized routine-execution id (use a stable string like `iris-retainer-summary-2026-04-15`).
- Issues with `priority='urgent'` are NOT valid — `urgent` is NOT in the enum. The existing seed uses `'urgent'` — **flag for fixup, but for NEW issues use `'critical'` or `'high'`.** Implementation agents should NOT modify the existing 5 issues' priority unless explicitly directed.
- The Acme Retail issue (`MIR-028`) must have `goalId=GOAL_1_ID` (the $10K MRR goal) and `projectId=Q2_PROJECT_ID`.

### 3.6 `approvals` — 5 already seeded; target **30 total** (25 new)
FK: `company_id`, `requested_by_agent_id → agents.id`, optional `workflow_run_id`.
- **No CHECK on `type`** (verified — see schema). Existing seed uses `type='agent_action'`; keep using this for all 25 new rows.
- **Status enum (shared validator):** `['pending','revision_requested','approved','rejected','cancelled']`.
- **Required cols:** `companyId`, `type`, `requestedByAgentId`, `status`, `payload` (jsonb, not null).

**Status distribution (30 total):**
- `pending`: 5 (the existing 5)
- `approved`: 22
- `revision_requested → approved`: 2 (Day 19 Bake House revise, Day 30 Acme edit cycle) — these end in `status='approved'` with `decisionNote` capturing the revision
- `rejected`: 1 (Day 24 Anita rejected a Theo-drafted cold outreach to a friend's company because it felt aggressive)
- `cancelled`: 0

**Time distribution:** Approvals fire whenever an agent run produces an `approval.queued` event. Use these anchor counts per week:
- Week 1: 4 approvals (Iris 4 retainer summaries Apr 15)
- Week 2: 7 (Theo Shore Capital × 2, Iris Stripe welcome, Maya cold drafts × 4)
- Week 3: 6 (Day 19 pivot week — Theo prompt swap approval, Iris May 1 × 4 summaries, 1 Theo SkyBridge)
- Week 4: 4 (Theo proposal edits, Maya brief approvals)
- Week 5: 4 + the 5 pre-seeded pending
- **Decision time:** average 12 minutes from `createdAt` → `decidedAt` during workdays. Some 6-hour stragglers when Anita is in a call.

**Payload patterns:** Match the existing 5 seeded approvals — `payload.action` + `payload.summary` + `payload.agentName` are required. For Gmail send actions, include `gmailDraftId: "draft_placeholder_<incrementing>"` (the safe-seed sentinel format `^draft_placeholder_\d+$` is enforced by the execution guard).

**`decisionNote` examples (for approved rows):**
- "Approved as-is."
- "Approved — small edit to the opening line, already applied in the draft."
- "Approved. Iris caught the missing line about June availability — nice."
- "Approved. Don't send for 30 min, want to call Dr. Sharma first."

**For the rejected row (Day 24):** `decisionNote="Too aggressive. Let me write this one myself."` `payload.action="send_cold_email"` `payload.to="<friend@company>"`.

**Coherence rules:**
- Every approved approval MUST have `decidedAt` AFTER `createdAt`.
- The `requestedByAgentId` must match the agent whose `heartbeat_run` produced the approval. Maya's approvals are #1 type (Slack standup posts, Gmail replies to clients). Theo's are proposal sends and cold outreach. Iris's are payment reminders and retainer summaries.
- Approvals with `gmailDraftId` set MUST have `gmailDraftId LIKE 'draft_placeholder_%'` (server execution guard). Use a global counter starting at `draft_placeholder_005` for new rows (existing seed used 001–004).
- For the Acme Retail proposal (existing approval `a3`), DO NOT touch it — it's part of today's daily brief.
- For the Bake House revision (Day 19 / `MIR-022`): create TWO approval rows in sequence — first one `status='revision_requested'` with `decisionNote="Add line about overdue invoice"`, second one `status='approved'` with `decisionNote="Approved with revision applied"`. The first row's `createdAt` is ~5h before the second's.

### 3.7 `approval_comments`
FK: `approval_id → approvals.id`, `company_id`, `author_agent_id` OR `author_user_id`.
- **Row count:** ~15 total (one per approval that had a back-and-forth — roughly half of the approved ones).
- **Content:** 1–2 line operator-feedback comments. Example: "Could you trim the opening to 2 sentences?" (from Anita); agent reply "Done — re-drafted, see updated approval."
- **Coherence:** Comments must be on approvals whose `status` was `revision_requested` at some point. Author alternates (Anita → agent → Anita). All within the approval's `createdAt` → `decidedAt` window.

### 3.8 `issue_comments` — target **40 rows**
FK: `issue_id → issues.id`, `company_id`, `author_agent_id` OR `author_user_id`.
- **Content:** Status updates from agents, founder reactions, internal monologue captures. Examples:
  - On `MIR-022` (Bake House revised retainer summary): Anita comments "Add a line asking about the overdue payment — I want to know if there's a problem before I just chase it." 4 hours later Iris (author_agent_id) comments "Revised draft attached to approval; tone is friendly, references their reorder script we shipped in March."
  - On `MIR-019` (pivot decision): Anita writes a 4-sentence note explaining her reasoning. No agent reply.
  - On `MIR-012` (Shore Capital proposal): Theo comments "Drafted; 412 words; pricing $1,500/mo + $2,500 setup; awaiting your review." Anita: "Good — bump setup to $3K, they've got budget."
- **Distribution:** Cluster on issues with `in_review` / `revision_requested` upstream. Each `done` issue gets 0–1 closing comment. The pivot issue (MIR-019) gets 3.

### 3.9 `issue_labels` + `labels`
- **Labels to create (8 total):** `client` (#3b82f6 blue), `pipeline` (#22c55e green), `internal` (#6b7280 gray), `finance` (#eab308 yellow), `pivot` (#a855f7 purple), `pro-services` (#7c3aed violet), `urgent-attention` (#ef4444 red), `recurring` (#06b6d4 cyan).
- **Apply on ~25 of the 35 issues.** Coherence rules:
  - `client` on all client-named issues (Northwood, Bake House, Clearview, Shore Capital).
  - `pipeline` on Acme, Fielding, SkyBridge prospects.
  - `recurring` on the monthly retainer-summary issues.
  - `pivot` on MIR-017, 018, 019, 020.
  - `finance` on Iris-originated issues.
  - `urgent-attention` on the Bake House overdue thread (MIR-026, 031).

### 3.10 `issue_relations` — target **6 rows**
- Type = `blocks`. Examples:
  - MIR-031 (second payment reminder) blocked by MIR-026 (chase response)
  - MIR-029 (Fielding prep deck) blocks MIR-030 (slides)
  - MIR-020 (Theo prompt update) blocks MIR-025 (SkyBridge cold outreach — needed new prompt)

### 3.11 `issue_approvals` (link table)
- Wire each agent-originated approval to its parent issue. For each approval whose `payload.summary` mentions a client name, find the matching issue and create the link row. Target: ~20 rows.

### 3.12 `daily_briefs` — 1 already seeded (today); target **30 total** (29 new)
FK: `company_id → companies.id`. **UNIQUE:** `(company_id, for_date)`. Use `onConflictDoNothing()`.
- **for_date** = each calendar date Apr 13 → May 12 inclusive (29 days; today's is already seeded).
- **payload shape:** see `DailyBriefPayload` in `daily_briefs.ts`. Required: `headline`, `topThreeActions`, `kpiMovements`, `anomalies`, `blockers`, `opportunities`.
- **Content density progression:**
  - Days 1–3: sparse (1 KPI movement, 0–1 action, no anomalies). Headlines: *"Day 1 — agents initialised; sample brief."*
  - Days 4–14: 3 actions, 0–1 blockers, 1–2 KPI movements. Headlines reference real events ("Iris flagged 4 retainer summaries for review", "Shore Capital proposal sent").
  - Days 15–21 (pivot week): blockers + opportunities lean into the wedge debate. Headlines: *"Pivot decision pending; 2 discovery calls this week"*, *"Pivot committed — Theo prompt updated; manufacturing prospects cancelled."*
  - Days 22–29: momentum tone. Headlines: *"4 retainers running clean; Acme proposal in flight"*, *"Bake House silence on retainer summary — flagging."*
- **`emailSentAt`** = `for_date + 1h` for ~20 of 30 (representing email delivery succeeded); null for the rest (Anita disabled email some weeks).
- **`generatedAt`** = for_date local 07:00–07:45 IST randomised.

**Coherence rules:**
- `topThreeActions[].approvalId` MUST reference real approval UUIDs from §3.6 when an approval exists; otherwise omit/leave `undefined`.
- `anomalies[].insightId` and `opportunities[].insightId` MUST reference real `insights` rows (see §3.14). For early days when no insights exist, leave anomalies/opportunities empty.
- `kpiMovements` MRR sequence: $4,800 (Days 1–10) → $4,800 (Day 11+ Shore Capital signs) → $5,800 (Day 12 Shore Capital activates) → wait — actual final = $6,400. **Use:** $5,200 initial → $6,400 by Day 12 (Shore Capital adds $1,000) → $6,400 stable. The $800 MoM delta shown in `companies.metrics.deltas` should reconcile.

### 3.13 `weekly_wraps` — target **4 rows**
FK: `company_id → companies.id`. **UNIQUE:** `(company_id, week_ending_at)`.
- **Week endings (Friday 17:00 IST = 11:30 UTC):**
  1. `2026-04-17T11:30:00Z`
  2. `2026-04-24T11:30:00Z`
  3. `2026-05-01T11:30:00Z`
  4. `2026-05-08T11:30:00Z`
- **`narrative`** (text): 150–300 word weekly recap. Pattern:
  > "*Week 1 — Setup. FounderOS spun up; Maya/Theo/Iris connected to Slack/Gmail/Stripe. 4 retainer summaries drafted and approved (Iris). First daily briefs are sparse but coherent. Total agent runs: 9 across 3 agents. MRR steady at $5,200.*"
- **`highlights`** (jsonb array of `WeeklyWrapHighlight`): 3–5 per week. Mix of `issue_shipped`, `decision_approved`, `activity`, `blocker`.
- **`metrics`**: `issuesShipped`, `decisionsApproved`, `activityCount`, `openBlockers`, `agentSpendCents` — derived from the corresponding week's activity.
- **`deliveredToSlackAt`**: ~5 min after `week_ending_at` (cron lag). Successful delivery for all 4.
- **`deliveredToEmailAt`**: 4h after for the first 2 weeks; null for last 2 weeks (founder paused email digest after the pivot).

### 3.14 `insights` — target **15 rows**
FK: `company_id → companies.id`. CASCADE delete.
- **CHECK constraints:** `department IN ('chief-of-staff','growth','content','crm','finance')`, `kind IN ('kpi_anomaly','opportunity','blocker','experiment_suggestion','channel_recommendation','attribution')`, `status IN ('open','acted_on','dismissed','expired')`, `confidence` in [0,1].

**Distribution:**
- Department: 5 chief-of-staff, 4 growth, 3 finance, 2 crm, 1 content.
- Status: 8 `acted_on`, 4 `open`, 2 `dismissed`, 1 `expired`.

**Example rows (must match the arc):**
| Day | Dept | Kind | Title | Status | Confidence |
|---|---|---|---|---|---|
| 9 | growth | opportunity | "Proposal velocity unlocked — pipeline now bottlenecked by discovery-call count" | acted_on | 0.82 |
| 12 | finance | kpi_anomaly | "Theo OpenAI spend spike +180% on Apr 24" | acted_on | 0.91 |
| 17 | chief-of-staff | opportunity | "Manufacturing prospect surfaced; conflict with current pro-services positioning" | acted_on | 0.75 |
| 19 | chief-of-staff | experiment_suggestion | "Test pro-services-only positioning in May outreach (vs current generalist)" | acted_on | 0.7 |
| 22 | crm | channel_recommendation | "Northwood Dental → SkyBridge referral hit; replicate ask for warm intros" | acted_on | 0.65 |
| 25 | finance | kpi_anomaly | "Bake House invoice 5d overdue; 2nd time in 6mo" | open | 0.95 |
| 28 | finance | blocker | "Bake House $1,200 invoice 3 days overdue; possible at-risk customer" | open | 0.88 |
| 26 | growth | attribution | "Nasscom event drove 1 hot lead (Acme); confirm channel ROI" | open | 0.6 |
| 5 | chief-of-staff | opportunity | "Slack #pipeline channel underused — only 2 agent posts in week 1" | dismissed | 0.4 |
| 8 | content | experiment_suggestion | "Publish '4h → 8min' proposal-velocity LinkedIn post" | open | 0.55 |
| 14 | growth | experiment_suggestion | "Cold-outreach to dental groups via Northwood Dental ref" | expired | 0.3 |
| 6 | chief-of-staff | opportunity | "Add Saturday Maya brief — Anita reads Sundays" | dismissed | 0.35 |
| 11 | crm | channel_recommendation | "Clearview Legal scope-expansion opening — propose Q3 add-on" | acted_on | 0.7 |
| 20 | chief-of-staff | blocker | "Theo prompt drift — pre-pivot drafts are now off-brand" | acted_on | 0.8 |
| 23 | finance | kpi_anomaly | "Cumulative agent spend Apr = $63 — 60% under budget" | acted_on | 0.92 |

- **`evidence` (jsonb)**: include `{ "supporting_run_ids": [<uuid>], "supporting_event_ids": [<uuid>] }` when relevant. Empty `{}` is acceptable for older rows.
- **`recommendation`** populated for ~10 rows; null for the rest.

### 3.15 `company_memory` — target **12 rows**
FK: `company_id → companies.id`. CASCADE delete.
- **CHECK on `category`:** `IN ('decision','pattern','context','outcome')` (NULL allowed).
- **`kind` (no DB CHECK):** convention values `'weekly_summary' | 'experiment_outcome' | 'founder_note' | 'milestone'`.
- **`source` text:** `'auto'` (agent-generated) or `'manual'` (Anita).
- **`embedding`:** **leave NULL** — the spec allows nullable embeddings, and the implementation can fill these later via the embeddings backfill cron.

**Required entries (use exact `title` strings so other tables can reference them):**

| # | Day | kind | category | title | source | pinned |
|---|---|---|---|---|---|---|
| 1 | 1 | milestone | context | "FounderOS adopted — 3 agents board configured" | auto | false |
| 2 | 8 | experiment_outcome | pattern | "Theo proposal drafting: 4h → 8min (30x speedup)" | auto | true |
| 3 | 9 | weekly_summary | outcome | "Week 1 wrap — 9 agent runs, 0 failures, MRR $5,200" | auto | false |
| 4 | 12 | founder_note | context | "OpenAI rate-limits start at 4 parallel runs — don't queue more" | manual | false |
| 5 | 16 | weekly_summary | outcome | "Week 2 wrap — 32 agent runs, 2 failures, Shore Capital signed" | auto | false |
| 6 | 18 | milestone | **decision** | "Pivoted wedge to professional services (legal/PE/insurance); killing manufacturing prospects" | manual | **true** |
| 7 | 21 | founder_note | context | "3 weeks in. Theo + Iris feel like real co-workers." | manual | false |
| 8 | 23 | weekly_summary | outcome | "Week 3 wrap — pivot decision committed, Theo prompt swapped" | auto | false |
| 9 | 24 | experiment_outcome | outcome | "Shore Capital signing — 14-day outcome: WORKED. Retainer running clean." | auto | false |
| 10 | 26 | milestone | context | "Nasscom event — Acme Retail hot lead surfaced" | manual | false |
| 11 | 28 | founder_note | pattern | "Bake House comms drop-off → potential churn signal pattern" | manual | true |
| 12 | 30 | weekly_summary | outcome | "Week 4 wrap — 4 retainers running, Acme proposal in flight, Bake House at-risk" | auto | false |

**`occurredAt`** = the relevant day timestamp (IST 14:00 default unless event-specific).

**`body`** = 2–4 sentence prose. Example for #6 (the pivot decision):
> "After two discovery calls this week — one with a 200-staff manufacturing SaaS and one with a 30-person mid-market law firm cluster — Anita committed to professional services as the wedge (legal, PE, insurance). The Clearview Legal account already proves the legal motion works; the manufacturing one would be a fresh GTM with no warm references. Theo's prompt template is being updated to emphasise compliance/document-extraction. Verdant Foods (manufacturing) prospect is cancelled."

**Coherence rules:**
- Entry #6 (pivot decision) MUST be referenced in `issue_comments` on MIR-019 + appear in `daily_briefs` for Apr 30 + correspond to the `agent_config_revisions` row.
- Entry #9 (Shore Capital outcome) MUST link via `decision_outcomes.memoryEntryId` to its company_memory row.
- Pinned rows: #2, #6, #11.

### 3.16 `decision_outcomes` — target **3 rows**
FK: `approval_id → approvals.id`, `company_id`, optional `memory_entry_id → company_memory.id`.
- **Status values used in seed:** `'pending_followup'`, `'worked'`, `'did_not_work'`, `'unclear'`, `'dropped'` (string, no DB CHECK).

**Rows:**
1. Shore Capital signing decision (Day 10 approval → Day 24 follow-up): `outcomeStatus='worked'`, `metricDelta="+$1,000/mo MRR; onboarded in 4 days"`, `founderNote="Signed at full rate. Retainer running cleanly. Onboarding took 4 days vs target 7."`, `memoryEntryId=<#9 above>`.
2. Pivot decision (Day 18 → cron not yet fired by Day 30, set `outcomeStatus='pending_followup'`, `promptedAt=2026-05-02T...`, `answeredAt=null`).
3. Theo prompt update (Day 18 approval → Day 25 outcome): `outcomeStatus='unclear'`, `founderNote="Still early; new prompt has only generated 2 drafts."`

### 3.17 `notifications` — target **20 rows**
FK: `company_id`, `user_id → auth.users.id` (Anita).
- **CHECK constraints:** `kind IN ('approval_needed','insight_critical','workflow_completed','integration_failed')`. `ref_kind IN ('approval','insight','workflow_run','integration')`. PARTIAL UNIQUE on (company, user, kind, ref_kind, ref_id) for unread.
- **Pair-invariant CHECK:** `(ref_kind IS NULL) = (ref_id IS NULL)`.
- **Row distribution:**
  - `approval_needed`: 10 (key approvals over 30d; 5 read, 5 unread = the 5 pre-seeded pending)
  - `insight_critical`: 4 (Bake House anomaly, Theo OpenAI spike, pivot recommendation, agent-spend-under-budget)
  - `workflow_completed`: 3 (weekly wraps × 3 — Anita read all 4 weekly wraps but only 3 created notifications since week 4's email was paused)
  - `integration_failed`: 3 (Apr 14 Slack rate-limit, Apr 30 Stripe timeout, May 5 Anthropic 529 — all `read_at` set after Anita acknowledged)
- **`refId`** = uuid string of the source approval/insight/workflow_run/integration. **`refKind`** matches.
- **`readAt`:** ~70% set. Unread = the latest 6 (4 of 5 pre-seeded approvals + 2 recent insights).

### 3.18 `inbox_state` — target **30 rows**
FK: `user_id → auth.users.id`.
- **UNIQUE:** `(user_id, entity_type, entity_id)`. **CHECK:** `entity_type IN ('approval','issue','decision','mention')`, `state IN ('unread','read','snoozed','archived')`.
- **Row distribution:**
  - 5 unread (the 5 pre-seeded approvals) — `entity_type='approval'`, `state='unread'`
  - 15 read (approved/rejected approvals over the 30d) — `entity_type='approval'`, `state='read'`, `readAt` set
  - 5 read on issues (MIR-019, 026, 028 etc) — `entity_type='issue'`, `state='read'`
  - 3 archived (old resolved blockers) — `state='archived'`, `archivedAt` set
  - 2 snoozed (one approval Anita pushed to weekend, one issue) — `state='snoozed'`, `snoozedUntil` future

### 3.19 `composio_connections` — 3 already seeded (status=pending); update to `active` + add 2 more
- **UNIQUE:** `(company_id, user_id, app_name)`. **CHECK on `last_sync_status`:** `IN ('ok','fail','partial','syncing','never')`.
- **UPDATE existing 3** (Slack / Gmail / Stripe): set `status='active'`, `lastSyncAt` to a recent timestamp (~10 min ago), `lastSyncStatus='ok'`, `consecutiveFailures=0`, `composioConnectionId` to a synthetic-but-realistic-looking string like `ca_mira_slack_4f7a9b` (won't be called).
- **INSERT 2 NEW:** `linkedin` (status=active, lastSyncStatus=ok), `hubspot` (status=`failed`, lastSyncStatus=`fail`, lastError="OAuth refresh token expired 2026-05-08; reconnect required", consecutiveFailures=3). Both with `userId=<ANITA>`.

### 3.20 `events` — target **80 rows**
FK: `company_id → companies.id` ON DELETE RESTRICT. **CHECK on `source`:** `IN ('stripe','posthog','linkedin','notion','slack','hubspot')`. **UNIQUE:** `(company_id, source, dedup_key)`.
- `dedupKey` is NOT NULL — synthesize when missing natural ID: `${channel}:${ts}:${user}` for Slack; `evt_<random>` for Stripe (mirroring real Stripe IDs).
- **Distribution:**
  - **stripe**: 25 events — 4 invoice.created (Apr 1, May 1) × 4 clients, 4 invoice.paid + 1 invoice.payment_failed (Bake House May 7), 5 customer.subscription.updated, 1 customer.created (Shore Capital, Apr 22), plus ~10 charge.succeeded.
  - **slack**: 35 events — `message_posted` events on #mira-team (Maya's morning standups, ~25), #pipeline (Theo posts, ~5), #mira-finance (Iris weekly digest, ~5).
  - **linkedin**: 8 events — `connection_request_accepted` (3), `message_received` (5) from outreach Theo did on Day 22+.
  - **hubspot**: 0 events (integration broken, see §3.19)
  - **posthog**: 12 events — UI activity (`page_view` on /agents, /inbox, /goals) — exactly the kind of self-dogfood UX Anita does.
- **`payload` jsonb:** include realistic-shaped data per source. E.g., Stripe: `{ "id": "evt_...", "type": "invoice.payment_failed", "data": { "object": { "id": "in_...", "customer": "cus_bakehouse", "amount_due": 120000 } } }`.
- **`occurredAt`** distributed across the 30d window per the arc.

### 3.21 `cost_events` — target **175 rows** (one per heartbeat_run)
FK: `company_id`, `agent_id → agents.id` (required), `heartbeat_run_id → heartbeat_runs.id`.
- **Required cols:** `agentId`, `provider`, `biller`, `billingType`, `model`, `inputTokens`, `outputTokens`, `costCents`, `occurredAt`.
- **One cost_events row per heartbeat_runs row.** Provider = `'anthropic'` for Maya/Iris, `'openai'` for Theo. Model = exactly matches the agent's `adapter_config.model`.
- **Cost shape (cents):**
  - Maya (Opus 4.6): 5–12 cents/run
  - Theo (4.1-mini): 1–3 cents/run
  - Iris (Sonnet 4.6): 3–6 cents/run
- **Cumulative spend Apr→May 13:** Maya ≈ $4.50, Theo ≈ $1.80, Iris ≈ $1.40 → **~$8 total agent spend**. Update `agents.spent_monthly_cents` to mirror (Maya 450, Theo 180, Iris 140) and `companies.spent_monthly_cents = 770`.
- **`occurredAt`** = corresponding heartbeat_run's `finishedAt`.

### 3.22 `finance_events` — target **30 rows**
FK: chain via `companyId`, optional `agentId`, `issueId`, `projectId`, `goalId`, `heartbeatRunId`, `costEventId`.
- **Mix:**
  - `eventKind='revenue'` direction=`credit`: 8 rows — Stripe charge.succeeded for each client × 2 months × 4 clients minus the Bake House May failure. Mira's $4,800–$6,400 MRR materialised as credits.
  - `eventKind='agent_cost'` direction=`debit`: 12 rows — aggregated weekly per-agent costs (LLM API spend), linked to `costEventId` of a representative run.
  - `eventKind='tooling_cost'` direction=`debit`: 6 rows — synthetic Composio + FounderOS subscription estimates ($20/mo Composio + $50/mo FounderOS = 4 weeks × $70 ÷ 30 ≈ minor).
  - `eventKind='operating_cost'` direction=`debit`: 4 rows — Anita's salary (no-op for bootstrapping), domain renewal, etc.
- **`biller`** values: `'anthropic'`, `'openai'`, `'stripe'`, `'composio'`, `'founderos'`, `'aws'`. Free-text — no CHECK.

### 3.23 `marketing_spend` — target **3 rows**
FK: `company_id`. **CHECK:** `channel IN ('linkedin','paid_meta','paid_google','referral','seo','partnerships','content','other')`. `amount_cents >= 0`. `period_end >= period_start`.
- Anita is bootstrap; spend is small.
  - **LinkedIn:** $200 in April (Premium for outbound research) — `channel='linkedin'`, `periodStart='2026-04-01'`, `periodEnd='2026-04-30'`, `amountCents=20000`.
  - **Partnerships:** $0 — referrals from Northwood Dental (May, captured for completeness) — `channel='partnerships'`, `amountCents=0`, `periodStart='2026-05-01'`, `periodEnd='2026-05-31'`, `notes='Northwood→SkyBridge intro'`.
  - **Content:** $50 in April for Buffer scheduling — `channel='content'`, `amountCents=5000`.
- **`createdBy`** = `<ANITA>` for all.

### 3.24 `budget_incidents` — target **2 rows**
FK: `company_id`, `policy_id → budget_policies.id`, optional `approval_id`. Requires a `budget_policies` row to exist.
- **Implementation note:** If no `budget_policies` rows exist for Mira Labs, the implementer must create at least one POLICY row first (per agent budget). Recommended: 1 policy per agent with `scope=agent`, `windowKind=monthly`, `amountLimit` matching `agents.budget_monthly_cents`.
- **Incidents:**
  1. Day 12 — Theo OpenAI spike: `metric='cost_cents'`, `amountLimit=10000`, `amountObserved=2400` (24%, under budget — should trigger an "approaching threshold" only if policy thresholds are %-based; skip if not). Replace with a real overage: synthesize a fake "Anita asked Theo to run 12 proposals in one day on Apr 24" → `amountObserved=12500` (125% of $100). `status='resolved'`, `resolvedAt` 4h later after Anita rate-limited.
  2. Day 26 — Maya cumulative spend approaching limit: `amountObserved=13800` (92% of $150/mo cap, projecting overage by month-end). `status='open'`, `approvalId=null`.

### 3.25 `routines` + `routine_triggers` + `routine_runs`
- **Routines (3 rows):**
  1. "Iris monthly retainer summaries" — `assignee_agent_id=Iris`, project_id=Q2_PROJECT_ID, priority=high, `concurrencyPolicy='coalesce_if_active'`, `catchUpPolicy='enqueue_missed_with_cap'`. Trigger: cron `0 9 1,15 * *` `timezone='Asia/Kolkata'`.
  2. "Iris Friday finance digest" — Iris, priority=medium, cron `0 17 * * 5` IST.
  3. "Maya daily brief" — Maya, priority=critical, cron `30 7 * * *` IST.
- **routine_triggers (3 rows):** one per routine, `kind='schedule'`, `enabled=true`, `nextRunAt` populated, `lastFiredAt` set on weekday alignment with the arc.
- **routine_runs:** materialise ~40 rows total across the 3 routines (Maya ~22 weekday runs, Iris monthly × 2 + Friday × 4 = 6, plus a few `coalesced` rows). `status` mostly `issue_created` or `completed`; 1–2 `coalesced`. `idempotencyKey` set per fire. `linkedIssueId` populated for the retainer-summary firings.

### 3.26 `workflows` + `workflow_runs` — OPTIONAL — target **2 workflows, 6 runs**
- These are CRM/Lifecycle workflows. For a consultancy with 4 clients, this layer is light.
- **Optional rows:**
  1. Workflow: "Welcome retainer email" — template=`'onboarding-emails'`, status=`'active'`, autonomyLevel=`2` (draft only, requires Anita to approve).
  2. Workflow: "Monthly retainer-renewal nudge" — template=`'churn-rescue'`, status=`'active'`, autonomyLevel=`3`.
- **workflow_runs (~6 total):** 1 run per client signup (Shore Capital welcome) + 4 monthly renewal nudges + 1 failed (the Bake House one — `status='failed'`, error in metricSnapshot).
- **Status enum:** `IN ('pending_approval','running','approved','rejected','completed','failed','cancelled')`.

### 3.27 `activity_log` — target **120 rows**
FK: `company_id`, optional `agent_id`, optional `run_id → heartbeat_runs.id`.
- **High volume — captures every meaningful state transition.** 1 row per: agent run started/completed, approval status change, issue status change, integration connect, daily brief generated, weekly wrap delivered.
- **`actor_type`:** `'system' | 'user' | 'agent'`. **`actor_id`** = user UID, agent UUID, or `'system'`.
- **`action`** examples: `'agent.run.started'`, `'agent.run.completed'`, `'agent.run.failed'`, `'approval.created'`, `'approval.approved'`, `'approval.rejected'`, `'issue.created'`, `'issue.status_changed'`, `'integration.connected'`, `'daily_brief.generated'`, `'weekly_wrap.delivered'`, `'memory.created'`, `'agent_config.revised'`.
- **`details` jsonb:** include the from/to state for status changes; the run summary for run events.
- **`lineageRefs`:** populate `{ insightIds: [...], approvalIds: [...] }` where relevant — this is the field that gets used in the UI "trace lineage" feature.

### 3.28 `conversations` — target **2 rows** (optional)
FK: `company_id`.
- 2 captured-transcript rows: (1) Apr 17 Clearview Legal scope-expansion call notes, (2) Apr 27 manufacturing-prospect discovery call (the one that ended in the pivot). `extractionStatus='complete'`, `extractedInsights` populated with 3 LLM-extracted insights each.

### 3.29 `instance_api_keys` — DO NOT SEED
Per the existing seed script (council condition #4), this table stays empty. Vinamr enters API keys via the Settings UI on wake-up. **Implementation agents MUST NOT INSERT into this table.**

### 3.30 `runner_tokens`, `runner_jobs`, `agent_handoffs`, `agent_task_sessions`, `agent_wakeup_requests`, `execution_workspaces`, `project_workspaces` — SKIP UNLESS NEEDED
These are runner/BYO-execution layer. Mira Labs uses `anthropic_api`/`openai_api` adapters; the BYO runner is not in play. **Do not seed unless an implementation agent finds an explicit dependency.**

### 3.31 Other tables — SKIP
- `assets`, `documents`, `document_revisions`, `experiments` (advanced, optional), `feedback_*`, `plugin_*`, `magic_link_tokens`, `onboarding_drafts`, `instance_*`, `cli_auth_*`, `principal_permission_grants`, `customer_email_suppressions`, `join_requests`, `invites`, `agent_api_keys`, `board_api_keys`, `agent_reviews`, `agent_runtime_state`, `workspace_*`, `company_skills`, `company_secrets`, `company_secret_versions`, `company_financials`, `company_logos`, `inbox_dismissals`, `issue_documents`, `issue_attachments`, `issue_read_states`, `issue_inbox_archives`, `issue_execution_*`, `issue_work_products`, `budget_policies` (only if budget_incidents need them), `project_goals`, `departments` (optional).
- **Rationale:** dogfood goal is "the screens that matter look lived-in." These tables drive niche features not in the buyer's path.

---

## 4. Volume summary

| Table | Existing | New | Total |
|---|---|---|---|
| agents | 3 | 0 | 3 |
| goals | 3 | 5 | 8 |
| projects | 1 | 4 | 5 |
| issues | 5 | 30 | 35 |
| issue_comments | 0 | 40 | 40 |
| issue_labels | 0 | ~50 | ~50 |
| issue_relations | 0 | 6 | 6 |
| issue_approvals | 0 | ~20 | ~20 |
| labels | 0 | 8 | 8 |
| approvals | 5 | 25 | 30 |
| approval_comments | 0 | 15 | 15 |
| heartbeat_runs | 0 | 175 | 175 |
| heartbeat_run_events | 0 | ~1000 | ~1000 |
| cost_events | 0 | 175 | 175 |
| finance_events | 0 | 30 | 30 |
| daily_briefs | 1 | 29 | 30 |
| weekly_wraps | 0 | 4 | 4 |
| insights | 0 | 15 | 15 |
| company_memory | 0 | 12 | 12 |
| decision_outcomes | 0 | 3 | 3 |
| notifications | 0 | 20 | 20 |
| inbox_state | 0 | 30 | 30 |
| events | 0 | 80 | 80 |
| composio_connections | 3 (upd) | 2 | 5 |
| marketing_spend | 0 | 3 | 3 |
| budget_incidents | 0 | 2 | 2 |
| budget_policies | 0 | 3 | 3 |
| routines | 0 | 3 | 3 |
| routine_triggers | 0 | 3 | 3 |
| routine_runs | 0 | ~40 | ~40 |
| workflows (opt) | 0 | 2 | 2 |
| workflow_runs (opt) | 0 | 6 | 6 |
| agent_config_revisions | 0 | 1 | 1 |
| activity_log | 0 | 120 | 120 |
| conversations | 0 | 2 | 2 |

**~2200 new rows.** Heaviest tables: `heartbeat_run_events` (~1000), `heartbeat_runs` (175), `cost_events` (175), `activity_log` (120), `events` (80).

**Also: 1 UPDATE to existing rows:**
- `agents` (3 rows): set `spent_monthly_cents` per agent
- `companies` (1 row): set `spent_monthly_cents=770`, refresh `metrics.deltas`
- `composio_connections` (3 rows): flip `status='active'`, set `lastSyncAt` + `lastSyncStatus='ok'`

---

## 5. Cross-table coherence rules — global

Every seed script MUST respect these:

1. **Tenant scope:** every row carries `companyId = <MIRA>`. Verified by FK chain.
2. **Persona tag:** where the table has `metadata jsonb`, include `{ "persona": "mira-labs-dogfood" }`.
3. **Approvals reference real runs:** every `approvals.requestedByAgentId` agent has a corresponding `heartbeat_runs` row whose `resultJson.approval_id` matches the approval's UUID.
4. **Issues reference real runs:** every agent-assigned `done` issue has `executionRunId` pointing to a real `heartbeat_runs.id` for that agent, `status='succeeded'`.
5. **Daily-brief content threads back:** `daily_briefs.payload.topThreeActions[].approvalId` must be a valid `approvals.id` (or omitted). `anomalies[].insightId` / `opportunities[].insightId` must be valid `insights.id`.
6. **decision_outcomes link to memory:** when `outcomeStatus='worked' | 'did_not_work'`, the `memoryEntryId` should reference a `company_memory` row of `kind='experiment_outcome'`.
7. **events.dedupKey not null:** synthesize per source. Stripe `evt_<8hex>`, Slack `<channel>:<ts>:<user>`, posthog `synth:<event_name>:<ts>:<distinct_id>`.
8. **Idempotency:** every script MUST be safe to re-run. Use `onConflictDoNothing()` against the natural UNIQUE index, or pre-DELETE-by-`metadata->>'persona'` if explicit re-seed is intended (mirror the existing `purgeExistingMiraLabs` pattern).
9. **Timestamps:** **never** generate timestamps in the future. Cap at `now() = 2026-05-13T<current IST>`. Past timestamps must respect dependencies (`created_at <= updated_at <= completed_at`).
10. **Token/cost data plausibility:** `usageJson` numbers must be internally consistent with `cost_events.costCents`. Use the per-model rates listed in §3.21.
11. **Spend rollups update aggregates:** after inserting cost_events, recompute and UPDATE `agents.spent_monthly_cents` and `companies.spent_monthly_cents`.

---

## 6. Implementation roadmap — split across 6 agents

**Run order is dependency-driven. Agents A → F must run sequentially or honour the prerequisites column.**

| Wave | Agent | Script | Prereqs | Estimated insert volume |
|---|---|---|---|---|
| 1 | A | `seed-mira-labs-month1-runs.ts` | existing seed already ran | ~1175 rows |
| 2 | B | `seed-mira-labs-month1-issues.ts` | Wave 1 (uses run IDs) | ~150 rows |
| 3 | C | `seed-mira-labs-month1-inbox.ts` | Wave 2 (uses issue IDs) | ~125 rows |
| 4 | D | `seed-mira-labs-month1-knowledge.ts` | Wave 3 (uses approval IDs) | ~60 rows |
| 5 | E | `seed-mira-labs-month1-okrs.ts` | Wave 2 (uses goal/project) | ~13 rows |
| 6 | F | `seed-mira-labs-month1-finance.ts` | Wave 1 (uses run IDs) | ~150 rows |

Each script lives at `scripts/seed-mira-labs-month1-<part>.ts`.

### Agent A — `seed-mira-labs-month1-runs.ts`
**Inserts:** `agent_config_revisions` (1), `heartbeat_runs` (175), `heartbeat_run_events` (~1000), `routines` (3), `routine_triggers` (3), `routine_runs` (~40), `composio_connections` (2 new + UPDATE 3 existing), `activity_log` (subset — ~80 run-related entries).
**Why first:** every downstream agent needs `heartbeat_runs.id` values. Output a JSON file at `.planning/loop-2026-05-13-04/seeded-ids/runs.json` mapping `<date>:<agent>:<index>` → run UUID, so Agents B–F can FK against them deterministically.

### Agent B — `seed-mira-labs-month1-issues.ts`
**Inserts:** `labels` (8), `issues` (30 — MIR-006..035), `issue_comments` (40), `issue_labels` (~50), `issue_relations` (6).
**Depends on:** `runs.json` from Wave 1 (for `executionRunId`, `checkoutRunId`).
**Output:** `.planning/loop-2026-05-13-04/seeded-ids/issues.json` mapping `MIR-NNN → issue UUID`.

### Agent C — `seed-mira-labs-month1-inbox.ts`
**Inserts:** `approvals` (25 new), `approval_comments` (15), `issue_approvals` (~20), `daily_briefs` (29 — Apr 13→May 12), `weekly_wraps` (4), `notifications` (20), `inbox_state` (30).
**Depends on:** `issues.json` (issue UUIDs for `issue_approvals`), `runs.json` (run UUIDs for approval's `requestedByAgentId` cross-check).
**Output:** `.planning/loop-2026-05-13-04/seeded-ids/approvals.json`.

### Agent D — `seed-mira-labs-month1-knowledge.ts`
**Inserts:** `company_memory` (12), `insights` (15), `decision_outcomes` (3), `conversations` (2).
**Depends on:** `approvals.json` (for decision_outcomes.approvalId), `issues.json` (insights evidence).
**Notes:** Leave `company_memory.embedding=NULL`; do not block on pgvector availability.

### Agent E — `seed-mira-labs-month1-okrs.ts`
**Inserts:** `goals` (5 more — child goals under existing 3, e.g. team-level goals, agent-level goals), `projects` (4 more — "April Retainer Operations", "Q2 Pivot — Pro-Services GTM", "Brand & Content Foundation", "Onboarding Automation Internal").
**Depends on:** existing goals (1, 2, 3 already seeded). Establish parent-child via `goals.parent_id`.

### Agent F — `seed-mira-labs-month1-finance.ts`
**Inserts:** `cost_events` (175), `finance_events` (30), `marketing_spend` (3), `budget_policies` (3 — one per agent), `budget_incidents` (2), `workflows` (2 — OPTIONAL), `workflow_runs` (6 — OPTIONAL), `events` (80 — Stripe/Slack/LinkedIn/PostHog), `activity_log` (remaining ~40 entries).
**Final step:** UPDATE `agents.spent_monthly_cents`, `companies.spent_monthly_cents`, `companies.metrics.deltas` to reconcile with `cost_events` totals.
**Depends on:** `runs.json` (for `cost_events.heartbeatRunId`).

---

## 7. Script template contract

Every script MUST:

1. **Idempotency gate** at top:
```ts
if (process.env.FOUNDEROS_SEED_MIRA_LABS_MONTH1 !== "1") {
  console.error("[seed-mira-labs-month1-<part>] Refusing: set FOUNDEROS_SEED_MIRA_LABS_MONTH1=1");
  process.exit(1);
}
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL required"); process.exit(1); }
```
2. **Confirm Mira Labs exists first:**
```ts
const company = await db.select().from(companies)
  .where(sql`${companies.metadata}->>'persona' = 'mira-labs-dogfood'`).then(rs => rs[0]);
if (!company) throw new Error("Run scripts/seed-mira-labs.ts first.");
const MIRA = company.id;
```
3. **Resolve agent IDs at runtime** — no hardcoding:
```ts
const agentRows = await db.select().from(agents).where(eq(agents.companyId, MIRA));
const MAYA = agentRows.find(a => a.name === "Maya")!.id;
const THEO = agentRows.find(a => a.name === "Theo")!.id;
const IRIS = agentRows.find(a => a.name === "Iris")!.id;
```
4. **`onConflictDoNothing()`** on every insert that has a UNIQUE constraint to allow re-run.
5. **Read/write the seeded-ids JSON files** under `.planning/loop-2026-05-13-04/seeded-ids/` to share IDs across waves. Agents A–F MUST persist their output JSON and read prior waves' outputs.
6. **End-of-run summary:**
```
[seed-mira-labs-month1-<part>] Inserted: <N> rows across <M> tables. Total runtime: <s>s.
```
7. **Never INSERT into `instance_api_keys`** (council condition #4 carries over).
8. **Never set `companies.is_demo = true`** for this row (council condition #3 — DB trigger 0109 will reject).

---

## 8. Acceptable simplifications

- **Agent output text:** 1–2 sentence summaries in `stdoutExcerpt` are fine. No need to write 5000-token transcripts.
- **Embeddings:** leave `company_memory.embedding` and `experiments.hypothesis_embedding` NULL. The embedding backfill cron handles them.
- **`runner_jobs` / `runner_tokens`:** skip entirely. Mira's adapters are cloud, not BYO.
- **Plugin layer:** skip `plugin_*` tables.
- **`heartbeat_run_events`:** 2-6 events per run is enough — we don't need every tool invocation logged.
- **Cost data:** approximate, not exact. The aggregate per-agent monthly spend is what the UI surfaces.
- **`activity_log`:** focus on the ~120 most surfaced rows in the UI activity feed. Don't try to mirror every tiny state transition.
- **Composio connection IDs:** synthetic strings like `ca_mira_slack_<6hex>` are fine — they're never called against the real Composio API.

---

## 9. Verification checklist (after all 6 agents run)

Acceptance criteria — every "yes" before declaring the dogfood seed complete:

- [ ] `SELECT COUNT(*) FROM heartbeat_runs WHERE company_id = '<MIRA>'` returns **≥175**.
- [ ] `SELECT COUNT(*) FROM issues WHERE company_id = '<MIRA>'` returns **≥35**.
- [ ] `SELECT COUNT(*) FROM approvals WHERE company_id = '<MIRA>' AND status='pending'` returns **5** (unchanged from seed).
- [ ] `SELECT COUNT(*) FROM approvals WHERE company_id = '<MIRA>'` returns **≥30**.
- [ ] `SELECT COUNT(*) FROM daily_briefs WHERE company_id = '<MIRA>'` returns **30**.
- [ ] `SELECT COUNT(*) FROM weekly_wraps WHERE company_id = '<MIRA>'` returns **4**.
- [ ] `SELECT COUNT(*) FROM company_memory WHERE company_id = '<MIRA>' AND category='decision'` returns **≥1** (the pivot).
- [ ] `SELECT spent_monthly_cents FROM companies WHERE id = '<MIRA>'` returns **>0** (~770).
- [ ] `SELECT status, COUNT(*) FROM composio_connections WHERE company_id='<MIRA>' GROUP BY status` shows **4 active + 1 failed**.
- [ ] **UI smoke:** Sign in as Anita; verify `/agents` shows 3 agents with non-zero spend, `/inbox` shows 5 pending + 20+ historical items, `/issues` paginates past 35, `/goals` shows 8, `/brief` renders the today brief AND lets her scroll back 29 days, `/finance` shows runway + spend curve.
- [ ] **No CHECK violations:** every script run completes without DB CHECK errors.
- [ ] **Idempotent:** re-running every script is a no-op (zero new rows inserted).
- [ ] **Pure persona scope:** `DELETE FROM ... WHERE company_id = '<MIRA>'` cascades cleanly; no orphans in any other tenant.

---

**End of spec.**
