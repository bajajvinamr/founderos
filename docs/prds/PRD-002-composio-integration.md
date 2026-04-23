# PRD-002: Composio Integration Layer

**Status:** Shipped
**Owner:** @vinamr
**Last updated:** 2026-04-21
**Related:** Wave 21, Composio OAuth, Agent skills

## Problem

Agents can act in only a handful of tools (Slack, HubSpot, Notion, LinkedIn via native OAuth). Each new tool requires 4-6 weeks of OAuth registration, credential storage, skill implementation, and testing. Founders can't give their agents access to the 250+ tools they actually use (Salesforce, Stripe, Airtable, Zapier, Typeform, etc.). Without a unified integration layer, agents are permanently locked to a small tool ecosystem.

## Goal

One key (`COMPOSIO_API_KEY`) activates OAuth + skill execution for 250+ tools, free at our scale, with zero additional credential storage or OAuth app management.

## Non-goals

- Replacing native Slack/HubSpot/Notion clients (they remain as fast-path fallback)
- Self-hosted Composio (always managed SaaS)
- Custom tool wrapping (Composio's library only)
- Workflow orchestration across tools (agent orchestration responsibility)
- Billing pass-through (Composio usage tracked, not billed to users)

## User stories

1. As a founder I want to connect my Salesforce account so that agents can move deals and log activities without manual copy-paste.
2. As an agent I want to call `slack.post_message` or `salesforce.create_task` and have Composio route it so that the skill code doesn't know whether it's native or Composio.
3. As a founder I want to see which tools I've connected via a single Integrations page so that I know what agents can access.
4. As an agent I want the Composio call to fail loudly if the user hasn't connected the tool so that I don't silently skip actions.
5. As a founder I want to revoke a tool connection so that I can remove access if an employee leaves.
6. As a operator I want Composio failures to be visible in Sentry so that I can debug integration issues without asking the user.

## Success metrics

- **Tool adoption:** ≥ 3 founders connect ≥ 1 non-native tool within 14 days of signup
- **Connection success rate:** ≥ 95% of OAuth flows complete without error
- **Founder time-to-integrate:** Median time from Integrations page → OAuth redirect → working skill ≤ 3 min
- **Agent reliability:** ≥ 99.5% of Composio skill calls succeed (when tool is connected)

## UX / Flow

### Founder: Connect a tool
1. Founder navigates `/integrations`
2. See cards for Slack, HubSpot, Notion, LinkedIn (native) + Composio-backed section
3. Click "Connect Salesforce" (or any Composio app)
4. Modal appears with "Connect via Composio" button
5. Click → OAuth redirect to Composio login
6. User grants permissions → redirects back to `/integrations`
7. Status changes to "Connected" + "Last connected: 2 min ago"
8. Founder can click "Disconnect" to revoke (soft delete in DB)

### Founder: Integrations page
- List all connected apps (native + Composio)
- Each card shows: app logo, status (connected/expired/error), last connected, "Disconnect" button
- Expired OAuth tokens are re-asked on next agent action (no manual refresh)

### Agent: Skill execution
1. Agent code calls skill: `await slack.postMessage({channel: "general", text: "..."})`
2. Skill service checks: Is user using Composio? (env var + DB row)
3. If yes: Route to `composio-skill-bridge.ts` → call Composio API with user's connection ID
4. If no: Route to native client (fallback for backward compatibility)
5. If Composio call fails: Log to Sentry + throw (fail-loud, don't silently use fallback)

### Operator: Connection lifecycle
1. User connects tool via Composio OAuth → `composio_connections` row inserted (pending)
2. OAuth callback → row marked connected
3. Composio token refresh happens transparent to us (Composio manages token lifecycle)
4. If token expires → agent action fails + error logged to Sentry
5. Founder sees "Reconnect" button on `/integrations` (UX TBD in future PR)

## API / Data contract

### Tables

**composio_connections**
- `id`, `company_id`, `user_id` (founder who authorized)
- `app_name` (e.g., "salesforce", "stripe", "airtable")
- `composio_connection_id` (reference into Composio workspace)
- `status` (pending | connected | expired | error)
- `error_message` (null if status=connected, else error text)
- `last_used_at`, `created_at`, `updated_at`

### Endpoints

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/api/composio/status` | — | `{enabled: bool, configuredApps: string[]}` |
| POST | `/api/companies/:companyId/composio/connect` | `{appName}` | `{redirectUrl, connectionId}` (302 redirect) |
| GET | `/api/companies/:companyId/composio/connections` | — | List[ComposioConnection] |
| DELETE | `/api/companies/:companyId/composio/connections/:id` | — | 204 |

### Events

- `composio.connection.initiated` → Slack notify operator
- `composio.connection.verified` → Composio connection live, ready for agent use
- `composio.connection.failed` → Token refresh failed, operator alert to Sentry

### Skills affected

All existing skills that have a Composio equivalent:
- `slack.post_message`, `slack.add_reaction`
- `hubspot.create_contact`, `hubspot.log_note`, `hubspot.move_deal`
- `notion.create_page`, `notion.append_block`
- `salesforce.create_task` (NEW via Composio)
- `airtable.create_record` (NEW via Composio)
- `stripe.create_charge` (NEW via Composio)
- Many others

## Risks & open questions

- **Composio SaaS dependency:** If Composio goes down, all agent actions fail. No fallback for non-native tools. Mitigated by monitoring + status page subscription.
- **Token refresh latency:** If a user's Composio token expires during an action, we fail. Composio handles refresh async; we may need retry logic.
- **App discovery:** Founders won't know 250+ apps exist. Mitigated by search + "Popular integrations" section on `/integrations` (future UI work).
- **Rate limiting:** Composio's free tier has per-app rate limits (e.g., Slack: 30 calls/min). If an agent hammers Slack, we'll hit limits. Add operator-facing monitoring to detect this.
- **Cost creep:** Composio charges per connection beyond free tier. Monitor spend; set Composio API key to read-only in prod to prevent accidental enablement of paid features.

## Out of scope (but considered)

- Zapier, Make, or other automation platform integrations (Composio covers most use cases)
- Custom OAuth scopes per app (use Composio defaults)
- Proxy OAuth (Composio handles all OAuth, we don't manage user credentials)
- Two-way sync (Composio is action-only, no webhook ingestion)
- Scheduled actions via Composio (agent scheduler owns that)

## Test plan

### Manual
- [ ] Enable `COMPOSIO_API_KEY` in local env → Composio status endpoint returns enabled=true
- [ ] Connect Slack via Composio → credentials stored, verified
- [ ] Agent calls `slack.postMessage` via Composio → message appears in real Slack channel
- [ ] Disconnect Salesforce → future skill calls fail loudly (not silently use fallback)
- [ ] Native Slack client still works as fallback (if Composio disabled)

### E2E (must be green)
- [ ] `test/e2e/composio-connect.spec.ts` — full OAuth flow: initiate → authorize → verify
- [ ] `test/e2e/composio-skill-routing.spec.ts` — skill called with Composio connection → action succeeds
- [ ] `test/e2e/composio-skill-fallback.spec.ts` — Composio disabled, native client still works
- [ ] `test/e2e/composio-disconnect.spec.ts` — revoke connection, future skills fail

### Coverage
- `composio-client.ts`: 85%+ unit test coverage (mock Composio API)
- `composio-skill-bridge.ts`: 80%+ coverage (mock agent skills)
- `composio-routes.ts`: 90%+ endpoint coverage

### Known test gaps (to write)
- Token refresh / expiry scenarios (requires Composio mock w/ time travel)
- Multi-user connection isolation (two founders connecting same app independently)
