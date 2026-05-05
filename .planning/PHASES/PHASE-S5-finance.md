# Sprint 5 — Finance + scenario modeling

_Status: not_started · Effort: 1 week · Depends on: S2 (parallel-able with S4) · Blocks: S6_

## Goal

> CFO moat. Founders can answer "what happens if I X?" without a spreadsheet. Revenue cockpit + pricing simulator + churn forecast + LTV/CAC + experiment ROI rollup, all live from `events` data.

## Success criteria — the demo line

> _Founder: "What happens if I reduce free credits by 70%?"_
> _AI: "Free→paid lift +12%, churn risk +3%, MRR impact +$8.4k/mo, payback delta +1.4 months."_

## Specific success criteria

1. Revenue cockpit shows: MRR, ARR, expansion, churn, LTV, payback period, gross margin — live from S2 events
2. Pricing simulator: change a price tier value → preview MRR/churn impact within 2s
3. Churn forecast: cohort-based projection 90 days out
4. Runway forecast: current cash + monthly burn + projected revenue → "X months until cash-out"
5. LTV/CAC model: per-channel rollup
6. Experiment ROI model: completed Growth experiments with actual lift roll up to MRR/runway impact
7. Cash planning: 6-month cash flow projection with toggleable scenario inputs

QA acceptance: smoke workspace with 90d Stripe data → revenue cockpit shows correct numbers; toggle "increase pricing 20%" → simulator shows MRR +X% / churn +Y% within 2s.

## What exists today (don't rebuild)

| Surface | Where | Status |
|---|---|---|
| FinanceConsole stub | `ui/src/pages/departments/FinanceConsole.tsx` | ✓ shell |
| `finance_events` schema | `packages/db/src/schema/finance_events.ts` | ✓ — verify shape vs what we need |
| AccountingModelCard component | `ui/src/components/AccountingModelCard.tsx` | ✓ existing |
| BillerSpendCard | `ui/src/components/BillerSpendCard.tsx` | ✓ |
| Stripe events ingestion | (S2.2) | ✓ available after S2 |
| KPI snapshots | `company_kpi_snapshots` (S2.9) | ✓ has MRR/churn |

## Tickets

---

### Ticket S5.1 — Revenue cockpit (the canonical Finance home)

**PM intent**: First screen of the Finance dept. Single dashboard. All numbers live from Stripe + Events.

**Engineering**:
- New endpoint `GET /api/companies/:id/finance/cockpit` returning:
  ```ts
  {
    mrr: { cents, deltaPctMoM, deltaPctYoY },
    arr: { cents },
    expansion: { cents, source: 'upgrades+addons' },
    churn: { rate30d, lostMrrCents },
    ltv: { cents, sampleSize },
    cac: { cents, channelBreakdown: [...] },
    paybackMonths: number,
    grossMarginPct: number,
    customerCount: { total, paying, free },
    arpu: { cents }
  }
  ```
- All values computed from `events` + `instance_subscription` table
- LTV calc: median customer lifetime × ARPU; or just `ARPU / churn_rate` if not enough data
- CAC: if Stripe has `customer.metadata.attribution_source`, group by; else flat-rate single CAC across channels (informational warning surfaced in UI)
- Gross margin: revenue minus per-customer Fly cost from `instance_cost_history` (if available) — else stub at 70% with disclaimer

- UI: `ui/src/pages/departments/finance/RevenueCockpit.tsx`
  - Top row: 4 big metrics (MRR, ARR, Customers, ARPU) with deltas
  - Second row: charts (MRR trend 90d, customer count trend, churn rate trend)
  - Third row: cohort retention table (rows = signup month, cols = month-N retention %)

**QA**:
- Workspace with 90d Stripe events → cockpit numbers match a hand-calculated truth set
- Empty workspace → cockpit shows "Connect Stripe to see revenue" empty state
- Cohort table renders correctly for 12 monthly cohorts

**Files**:
- New: `server/src/services/finance/cockpit.ts`
- New: `server/src/routes/finance.ts`
- New: `ui/src/pages/departments/finance/RevenueCockpit.tsx`
- Edit: `FinanceConsole.tsx` (Revenue tab)
- Tests: per-metric calc against fixed dataset

---

### Ticket S5.2 — Pricing simulator

**PM intent**: Founder edits a price → instant projected MRR/churn impact based on price-elasticity model.

**Engineering**:
- Static model in v1 (the LLM doesn't simulate prices):
  - Price elasticity assumption: ε = -1.2 (industry default for SaaS) — overridable via workspace setting
  - For each tier change Δprice%:
    - new_subscribers_pct_change = ε × Δprice%
    - lost_subscribers_pct = max(0, ε × Δprice% × -0.5) // half of price-driven loss
    - new MRR = current_count × current_arpu × (1 + Δprice%) × (1 + new_subscribers_pct_change)
- Endpoint `POST /api/companies/:id/finance/pricing-simulate`:
  ```ts
  body: { tierChanges: [{ tierId, currentPriceCents, newPriceCents }] }
  response: { mrrDelta, churnDelta, paybackDelta, customerCountDelta, confidence: 'low' (always — flag the elasticity assumption) }
  ```
- UI: simulator card on `RevenueCockpit.tsx`
  - Sliders or numeric input per tier
  - Live recomputed delta below
  - Disclaimer: "Based on industry-default elasticity (-1.2). Replace with your data after 50+ price changes observed."

**Open question**: should we require LLM here? **Default: no — math model in v1.** LLM plays in S5.4 scenario modeling where natural language is the input.

**QA**:
- Increase price 20% → MRR up by less than 20% (elasticity drag)
- Decrease price 10% → customer count up
- Disclaimers visible

**Files**:
- New: `server/src/services/finance/pricing-elasticity.ts`
- New: `server/src/routes/finance/pricing.ts`
- Edit: `RevenueCockpit.tsx` (simulator card)
- Tests: math against textbook elasticity

---

### Ticket S5.3 — Churn forecast (cohort-based)

**PM intent**: Project next 90d churn from cohort retention curve.

**Engineering**:
- Service: `server/src/services/finance/churn-forecast.ts`
- Compute monthly cohort retention from past 12 months
- Fit a simple decay curve: retention(t) = a × exp(-b × t)
- Apply curve to current cohorts for next 90d
- Return: per-month projected churn count + dollar amount

- UI: chart on RevenueCockpit + "Forecast" tab

**QA**:
- Workspace with 12 cohorts → forecast within ±20% of actual when held-out test data
- Workspace with 1 cohort → "insufficient data" empty state

**Files**:
- New: `server/src/services/finance/churn-forecast.ts`
- New: `ui/src/pages/departments/finance/ChurnForecast.tsx`
- Tests: forecast accuracy against synthetic cohorts

---

### Ticket S5.4 — Scenario modeling (LLM-driven)

**PM intent**: This is the killer demo. Founder asks "what happens if I reduce free credits by 70%?" — agent runs the simulation.

**Engineering**:
- New endpoint `POST /api/companies/:id/finance/scenario`:
  ```ts
  body: { question: "what happens if I reduce free credits by 70%?" }
  response: { explanation, variables: { free_to_paid_lift, churn_risk, mrr_impact_cents, payback_delta }, confidence }
  ```
- Service: agent receives the question + current cockpit values + last 90d events
- LLM call with structured output (Claude tool use):
  - Tool: `run_pricing_simulation({ tierChanges })` → calls S5.2
  - Tool: `run_churn_forecast({ assumptionAdjustments })` → adjusts curve
  - Tool: `compute_payback({ cacAdjustment, mrrImpact })` → simple math
- Agent reasons: "reducing free credits 70% likely raises free→paid by ~12% based on similar SaaS data, but increases churn risk 3% as new paid users churn faster"
- Persists scenario as `insights` row with kind=`scenario_analysis`

**Critical**: agent must NEVER claim certainty. All outputs prefixed with confidence band. If no proxy data exists, return "we need 30 more days of data to give you a confident answer."

**UI**:
- Chat-like interface within the Finance console "Scenarios" tab
- Each scenario persists; founder can revisit + re-run

**QA**:
- "what if I double prices?" → coherent answer with churn risk + MRR delta
- "what if a meteor hits earth?" → graceful "this isn't a finance question" response
- Cite which tool calls were made (transparency)

**Files**:
- New: `server/src/services/agents/finance-scenario.ts`
- New: `server/src/services/agents/__prompts__/finance-scenario.md`
- New: `ui/src/pages/departments/finance/ScenarioConsole.tsx`
- Tests: tool-use mocking + structured output

---

### Ticket S5.5 — Runway forecast

**PM intent**: "Months until cash-out, given current burn and projected revenue."

**Engineering**:
- Founder inputs: current cash balance + monthly burn (from a settings page)
- Service combines this with S5.3 churn forecast + new-revenue projection
- Endpoint `GET /api/companies/:id/finance/runway` → `{ monthsRemaining, projectedCashOutDate, scenarioBands: { conservative, base, optimistic } }`
- Bands:
  - Conservative: 25th-percentile forecast revenue
  - Base: median
  - Optimistic: 75th
- UI: gauge chart + scenario band visualization on RevenueCockpit

**QA**:
- Cash 100k, burn 20k/mo, no revenue → 5 months runway exact
- Cash 100k, burn 20k/mo, revenue 15k/mo → ~20 months
- Scenario bands have correct ordering (conservative ≤ base ≤ optimistic)

**Files**:
- New: `server/src/services/finance/runway-forecast.ts`
- New: `ui/src/pages/departments/finance/RunwayForecast.tsx`
- Tests: math + edge cases

---

### Ticket S5.6 — LTV/CAC + per-channel ROI

**PM intent**: Tie Growth dept's experiments back to Finance. Per channel: cost spent (manual input or ad-platform integration), customers acquired, LTV.

**Engineering**:
- Manual ad-spend input v1 (don't integrate Meta/Google ads in MVP — too much surface)
- New schema: `marketing_spend` simple table with `{ companyId, channel, periodStart, periodEnd, amountCents }`
- Aggregation reads spend + signups attributed (from S3.8 channel attribution) → CAC per channel
- LTV per channel: median revenue from customers attributed to that channel
- Output: ranked table; surfaces "Channel X has 3.2× LTV/CAC, channel Y has 0.8× — kill Y"

**QA**:
- Add 5k spend on LinkedIn + 50 attributed signups → CAC = $100
- Multi-channel ranking works
- Empty state if no spend data

**Files**:
- New: schema + migration 0087
- New: `server/src/services/finance/ltv-cac.ts`
- New: `ui/src/pages/departments/finance/LtvCac.tsx`
- Tests: aggregation correctness

---

### Ticket S5.7 — Experiment ROI rollup

**PM intent**: Completed Growth experiments (S3.5) report actual lift; that lift translates to MRR impact in Finance.

**Engineering**:
- Service reads `experiments` where `status='completed'` AND `actualLiftPct IS NOT NULL`
- Computes MRR delta attributable to the experiment based on the channel and current MRR
- Rolls up to per-month attributable lift over last 90d
- New endpoint `GET /api/companies/:id/finance/experiment-roi` → list + summary
- UI: card on RevenueCockpit "Experiments contributed +$X to MRR this quarter"

**QA**:
- 5 completed experiments with measured lift → cumulative MRR impact computed
- Negative-lift experiments shown separately (learning value)

**Files**:
- New: `server/src/services/finance/experiment-roi.ts`
- New: `ui/src/pages/departments/finance/ExperimentRoi.tsx`
- Tests: rollup math

---

### Ticket S5.8 — Cash planning layer (6-month projection)

**PM intent**: Visual 6-month cash flow projection with scenario toggles ("what if we hire 2 engineers?", "what if churn doubles?").

**Engineering**:
- UI-driven scenario toggles:
  - Add hire (impacts burn)
  - Pricing change (impacts MRR)
  - Churn delta (impacts revenue projection)
  - Marketing spend change (impacts CAC + acquisition)
- Endpoint composes existing services (S5.3, S5.5, S5.6) with adjustments
- Visualization: stacked area chart showing inflows + outflows + cash balance

**QA**:
- Toggle hire +1 → projected cash balance drops by salary × 6 mo
- Toggle no scenarios → matches plain runway forecast

**Files**:
- New: `server/src/services/finance/cash-planning.ts`
- New: `ui/src/pages/departments/finance/CashPlanning.tsx`
- Tests: scenario composability

---

### Ticket S5.9 — Finance settings (manual inputs)

**PM intent**: Founder needs to tell us cash balance, monthly burn, and channel spend. Single settings page.

**Engineering**:
- New schema: `companyFinancials` (singleton row per company with `{ cashBalanceCents, monthlyBurnCents, lastUpdatedAt, lastUpdatedBy }`)
- API: GET/PUT
- UI: `ui/src/pages/departments/finance/FinanceSettings.tsx`
- Auto-prompt to fill if values are missing when founder opens cockpit

**QA**: standard CRUD

**Files**:
- New: schema + migration 0088
- New: `server/src/routes/finance/settings.ts`
- New: `ui/src/pages/departments/finance/FinanceSettings.tsx`

---

### Ticket S5.10 — Finance Console layout + tabs

**PM intent**: Pull S5.1-S5.9 together into one navigable Finance dept.

**Engineering**:
- `FinanceConsole.tsx` tabs: Revenue / Forecasting / Pricing / Burn / Treasury (placeholder for v2) / Billing
- Revenue → RevenueCockpit
- Forecasting → ChurnForecast + RunwayForecast + ExperimentRoi
- Pricing → PricingSimulator + ScenarioConsole
- Burn → CashPlanning
- Treasury → "Coming in v2 — this is where multi-account treasury automation lives"
- Billing → existing customer-portal redirect (Stripe)

**QA**:
- All 6 tabs render
- Direct links work
- Treasury empty state visible

**Files**:
- Edit: `ui/src/pages/departments/FinanceConsole.tsx`

---

## Definition of done

- 10 PRs merged
- ROADMAP.md S5 row updated
- Migrations 0087–0088 land
- Demo line works: "What happens if I reduce free credits by 70%?" → coherent multi-variable answer
- All 6 tabs in Finance dept render with real (or empty-state) data
- `/vanta-sync` after merge

## Notes for the agent

- **S5.4 (scenario modeling) is the demo killer — invest in prompt engineering + tool-use design.**
- **Pricing simulator (S5.2) uses static elasticity — explicit disclaimer everywhere.** Don't pretend it's per-customer-trained.
- **No Meta/Google ad-spend integrations in v1.** Manual input only. Ad integrations are a big surface — defer to post-MVP.
- **Treasury layer is explicitly v2.** Stub the tab with a roadmap note. Don't waste time scoping yield optimization or stablecoin treasury — those are venture-studio-tier features.
- **All forecasts MUST band confidence.** A point estimate looks confident but is wrong; bands reflect reality.
