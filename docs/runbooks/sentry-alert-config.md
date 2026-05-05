# Sentry Alert Configuration

_TC-4, 2026-05-05 — paired with `docs/devops/observability-plan.md` SLO table._

This runbook is the **source of truth** for Sentry alert rules in the
production project. Sentry rules are configured via the Sentry UI (or the
`sentry-cli` API) — this file defines them in code-review-able form so the
rules can be reproduced if the Sentry org is ever rebuilt.

## How to read this doc

Each section below corresponds to one SLO from
`docs/devops/observability-plan.md`. The rule definition is the JSON-like
shape Sentry's API expects (`POST /api/0/projects/{org}/{project}/rules/`),
captured as YAML for legibility.

If you change a rule in Sentry's UI, **update this file in the same PR**.
A drifted runbook is worse than no runbook.

## Prerequisites

1. A Sentry project is provisioned for FounderOS prod. The DSN lives in
   the Fly secret `SENTRY_DSN` (server) and GitHub secret `VITE_SENTRY_DSN`
   (UI bundle).
2. Sentry has at least one notification action wired:
   - **Slack integration** routing to channel `#oncall`.
   - Slack channel filter splits *page* vs *warn* by message tag (the
     filter rule is in Slack's channel settings, not Sentry).
3. The Sentry tags `requestId`, `traceId`, `routePath`, `httpMethod`,
   `actorType`, `companyId`, `runnerTokenId` are auto-populated on every
   captured exception by `server/src/observability/sentry.ts`. Filter on
   these in alert conditions.

## Rules

### `prod-5xx-rate` — SLO 1

**Severity tiers:** warn at >1% over 5 min; page at >5% over 5 min.

```yaml
name: prod-5xx-rate (5xx error rate)
environment: production
frequency: 5 # 5-minute windows
filterMatch: all
conditionMatch: any
filters:
  - id: sentry.rules.filters.tagged_event.TaggedEventFilter
    key: routePath
    match: ne
    value: ""  # only count tagged routes; un-tagged exceptions skipped
conditions:
  # Percent of total requests is computed via the Sentry Performance
  # transaction count for `http.server` op. The frequency rule below is the
  # absolute-count fallback for projects without performance enabled.
  - id: sentry.rules.conditions.event_frequency_percent.EventFrequencyPercentCondition
    interval: 5m
    value: 1.0       # warn threshold
    comparisonType: count
    name: "Issue triggers >1% of all transactions in 5 min"
actions:
  - id: sentry.integrations.slack.notify_action.SlackNotifyServiceAction
    workspace: founderos
    channel: "#oncall"
    tags: "requestId,routePath,httpMethod,actorType"
    notes: "[WARN] 5xx error rate >1% over 5 min — see runbook §5xx-rate"
```

For the **page** tier, clone the rule above with `value: 5.0` and
`notes: "[PAGE] 5xx >5% over 5 min — broad outage. Check /api/readyz, fly logs."`.

**Playbook (§5xx-rate):**
1. Open the issue in Sentry. Note the `requestId` from the tag.
2. `fly logs --app founderos | grep <requestId>` — pulls every log line
   for that single request.
3. If the same `routePath` is dominating: targeted regression.
4. If multiple routes: check `/api/readyz` and `/api/health/deep` (admin
   creds required for deep) — likely DB or Composio platform outage.
5. If broad and recent deploy: trigger rollback via
   `flyctl releases rollback <previous>`.

---

### `auth-error-config` — paired with SLO 2/3 (legacy specific tag)

**Severity:** page on first occurrence.

```yaml
name: auth-error-config (auth misconfiguration)
environment: production
frequency: 1
filterMatch: all
conditionMatch: any
filters:
  - id: sentry.rules.filters.tagged_event.TaggedEventFilter
    key: error.type
    match: eq
    value: "auth-error.config-error"
conditions:
  - id: sentry.rules.conditions.first_seen_event.FirstSeenEventCondition
actions:
  - id: sentry.integrations.slack.notify_action.SlackNotifyServiceAction
    workspace: founderos
    channel: "#oncall"
    tags: "requestId,buildSha,routePath"
    notes: "[PAGE] auth-error.config-error — Supabase URL or key likely broken in bundle. See docs/runbooks/auth-canary.md."
```

**Playbook:**
1. Pull `buildSha` from the tag. Run
   `scripts/ci/check-deployed-supabase.sh https://founderos.fly.dev`
   to confirm the bundle has the placeholder URL.
2. If yes → re-deploy with correct `VITE_SUPABASE_URL` /
   `VITE_SUPABASE_ANON_KEY` GitHub secrets.
3. Cross-check with the auth canary — if the canary is also failing, this
   is the same root cause.

---

### `agent-failure-rate` — SLO 4

**Severity:** warn at >5% failure rate over 1 h.

```yaml
name: agent-failure-rate (agent run failures)
environment: production
frequency: 60   # 1 hour
filterMatch: all
conditionMatch: any
filters:
  - id: sentry.rules.filters.tagged_event.TaggedEventFilter
    key: error.type
    match: eq
    value: "agent.run.failed"
  # Exclude billing-gated 402s — those are intentional, not agent errors.
  - id: sentry.rules.filters.tagged_event.TaggedEventFilter
    key: billing.gated
    match: ne
    value: "true"
conditions:
  - id: sentry.rules.conditions.event_frequency_percent.EventFrequencyPercentCondition
    interval: 1h
    value: 5.0
    comparisonType: count
actions:
  - id: sentry.integrations.slack.notify_action.SlackNotifyServiceAction
    workspace: founderos
    channel: "#oncall"
    tags: "agentId,companyId,actorType,root_cause"
    notes: "[WARN] >5% agent runs failing in last hour — see runbook §agent-run-failures"
```

**Playbook (§agent-run-failures):**
1. Sort the issue by `root_cause` tag — usually one root_cause dominates.
2. Common root causes and fixes:
   - `composio.rate_limit` → cool-off, no action.
   - `anthropic.529` → upstream overload, no action.
   - `anthropic.401` → API key rotated; refresh `ANTHROPIC_API_KEY` Fly secret.
   - `runner.token.expired` → user needs to re-issue runner token.
   - `db.timeout` → check `/api/health/deep`, possibly investigate slow query.
3. If no dominant root_cause: real regression — investigate the most
   recent deploy.

---

### `heartbeat-stale` — SLO 5

**Severity:** warn at p95 > 5 min over 15 min.

```yaml
name: heartbeat-stale (heartbeat job claim-to-complete p95 high)
environment: production
filterMatch: all
filters:
  - id: sentry.rules.filters.tagged_event.TaggedEventFilter
    key: job.name
    match: eq
    value: "heartbeat.invoke"
conditions:
  - id: sentry.rules.conditions.event_attribute.EventAttributeCondition
    attribute: timing.duration_ms
    match: gt
    value: 300000   # 5 minutes in ms
  - id: sentry.rules.conditions.event_frequency.EventFrequencyCondition
    interval: 15m
    value: 5        # at least 5 occurrences in 15 min before alerting
actions:
  - id: sentry.integrations.slack.notify_action.SlackNotifyServiceAction
    workspace: founderos
    channel: "#oncall"
    tags: "agentId,companyId"
    notes: "[WARN] heartbeat p95 >5min — runner stuck or DB slow. See runbook §heartbeat-stale"
```

**Playbook (§heartbeat-stale):**
1. `fly logs --app founderos | grep heartbeat.invoke | tail -50` —
   look for `claim-to-complete` traces.
2. Check `runner_tokens.lastSeenAt` for the affected `companyId` — if
   stale (>30s), the runner is offline.
3. Check Fly Managed Postgres slow query log (Supabase dashboard if MPG
   integrated, otherwise `pg_stat_statements`).
4. If only one runner is affected: contact founder via Slack DM.

---

### `agent-crashloop` — SLO 6

**Severity:** page on detection.

```yaml
name: agent-crashloop (same agent failing repeatedly with same root cause)
environment: production
filterMatch: all
filters:
  - id: sentry.rules.filters.tagged_event.TaggedEventFilter
    key: error.type
    match: eq
    value: "agent.run.failed"
conditions:
  # Group by both agentId AND root_cause: 3+ in 10 min on the same pair.
  - id: sentry.rules.conditions.event_frequency.EventFrequencyCondition
    interval: 10m
    value: 3
    # Sentry's standard frequency condition operates on the issue grouping;
    # the issue grouping in our project is keyed off (error.type, agentId,
    # root_cause) per server/src/observability/sentry.ts setup. So 3
    # occurrences of the SAME issue in 10 min == same agent + same cause.
actions:
  - id: sentry.integrations.slack.notify_action.SlackNotifyServiceAction
    workspace: founderos
    channel: "#oncall"
    tags: "agentId,companyId,root_cause"
    notes: "[PAGE] agent crashloop — same agent failing 3x with same root cause in 10 min. See runbook §agent-crashloop"
```

**Playbook (§agent-crashloop):**
1. Identify the agent + root cause from the issue tags.
2. Use the agent admin endpoint (instance_admin gated) to **pause** the
   agent: `POST /api/agents/:id/pause` with `Authorization: Bearer <admin>`.
   This stops the wakeup wave from re-firing.
3. Investigate the root cause via the standard agent-failure playbook.
4. Resume the agent only when the underlying issue is resolved
   (`POST /api/agents/:id/resume`).

---

### `readyz-monitor` — SLO 7

This is **NOT a Sentry rule** — it's a BetterStack / UptimeRobot monitor
because Sentry doesn't probe URLs.

**Setup (manual, one-time):**
1. BetterStack free tier → New monitor → HTTP(S) check.
2. URL: `https://founderos.fly.dev/api/readyz`
3. Expected: HTTP 200 + body equals `ready`.
4. Frequency: 60 s.
5. Alert: 2 consecutive failures → Slack `#oncall` webhook.
6. Webhook URL: same as the GitHub `SLACK_DEPLOY_WEBHOOK_URL` (a Slack
   incoming webhook — channel filter at the Slack side).

**Playbook (§readyz-monitor):**
1. `curl -i https://founderos.fly.dev/api/readyz` from any host. Expected
   `HTTP 200` + body `ready`.
2. If 503: `fly logs --app founderos | tail -100` — likely a DB-down or
   bootstrap-not-ready state.
3. If timeout: `fly status --app founderos` — machine count, region, last
   release. If a recent deploy: ROLLBACK.
4. If 401/403: `/api/readyz` is supposed to be public — a code change
   broke that. Investigate the diff in the most recent merge.

---

## Rule lifecycle

- New SLO → add a row to `docs/devops/observability-plan.md` AND a section here.
- Rule tweak → update Sentry UI + this file in same commit.
- Rule retired → delete from Sentry UI + this file. Keep the rationale in
  the commit message.

If a rule fires repeatedly without action being taken, that's a tuning
problem — adjust the threshold here, document the reasoning in the
commit. **Do not silence rules in the Sentry UI without updating this
file** — silenced rules drift into "we forgot why" territory within
weeks.
