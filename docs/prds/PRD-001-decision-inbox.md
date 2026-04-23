# PRD-001: Decision Inbox

**Status:** Shipped
**Owner:** @vinamr
**Last updated:** 2026-04-21
**Related:** Wave 10, Approvals service

## Problem

Founders are drowning in copy-pasted decisions. Agents draft decisions in Slack, threads scatter across channels, founders re-read the same context 3× to approve/reject, and half the decisions never get a decision at all. Without a single surface to see what's pending and act on it, decisions pile up and block agent work.

## Goal

A single Decision Inbox where agents' drafted decisions land, founders review + approve/reject in one place, and outcomes are tracked 14 days later.

## Non-goals

- Collaborative commenting on decisions (single-author; future feature)
- Bulk approval workflows
- Decision template builder
- Integration with external tools for decision pre-flight validation
- Multi-stage approvals (single approval per decision)

## User stories

1. As a founder I want to see all pending decisions in one list so that I can prioritize what to review.
2. As a founder I want to click a decision, read the agent's context + recommendation, and approve/reject it in < 30 sec so that I don't lose context.
3. As an agent I want my drafted decision to appear in the founder's Inbox immediately so that the founder can act on it.
4. As a founder I want rejected decisions to include a reason so that I can learn what the agent missed.
5. As a founder I want to see what happened after I approved a decision (outcome follow-up) 14 days later so that I can measure agent effectiveness.
6. As a founder I want approved decisions to route to the agent and auto-create an issue so that the agent starts executing without friction.

## Success metrics

- **Time-to-approval:** Median time from decision draft to founder approval ≤ 4 hours
- **Approval rate:** ≥ 60% of decisions approved (proxy for agent accuracy)
- **Outcome completion:** ≥ 70% of outcomes reported 14 days post-approval
- **Founder engagement:** 80%+ of founders approve ≥ 1 decision per week

## UX / Flow

### Founder: Review Inbox
1. Founder navigates `/decisions`
2. See list of pending decisions (most recent first), sorted by type + urgency
3. Click a decision → modal opens with:
   - Agent name + role + timestamp
   - Decision type (e.g., "Hire Agent", "Create Content", "Update Pricing")
   - Full context + recommendation
   - Approve / Reject buttons
4. On approval: Modal closes, issue auto-created, Slack notification sent to agent
5. On rejection: Modal prompts "Why?" → stores reason → notifies agent

### Agent: Decision drafted
1. Agent calls `POST /api/companies/:id/approvals` with decision payload
2. Decision appears in founder's Inbox immediately
3. Agent can see status via `GET /api/companies/:id/approvals` + filtering by requestedByAgentId
4. Agent receives Slack notification of approval/rejection

### Founder: 14-day follow-up
1. Cron job runs 14 days post-approval
2. Sends Slack DM to founder: "What happened with [decision name]?"
3. Founder replies: "Shipped ✓", "Blocked on X", or "Cancelled"
4. Outcome stored in `decision_outcomes` table for measurement

## API / Data contract

### Tables

**approvals**
- `id`, `company_id`, `type`, `status` (pending | approved | rejected)
- `payload` (JSONB: decision context, recommendation, outcome data)
- `requested_by_agent_id`, `requested_by_user_id`
- `decided_by_user_id`, `decided_at`, `decision_note`
- `created_at`, `updated_at`

**approval_comments**
- Links founder notes (rejection reason, outcome follow-up) to approvals

**decision_outcomes**
- `approval_id`, `outcome` (shipped | blocked | cancelled), `notes`, `reported_at`

### Endpoints

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/api/companies/:companyId/approvals` | `?status=pending\|approved\|rejected` | List[Approval] |
| GET | `/api/approvals/:id` | — | Approval |
| POST | `/api/companies/:companyId/approvals` | `{type, payload, requestedByAgentId}` | Approval (201) |
| PATCH | `/api/approvals/:id` | `{status, decidedByUserId, decisionNote}` | Approval |
| POST | `/api/approvals/:id/comments` | `{text}` | Comment |

### Events

- `approval.created` → Slack notification to founder
- `approval.resolved` (approved/rejected) → Slack notification to agent
- `approval.outcome_requested` → Slack DM 14 days post-approval

## Risks & open questions

- **Cold-start context:** If an agent's charter is stale, decision context may be incorrect. Mitigated by founder review, but watch for approval rate < 60%.
- **Slack notification spam:** If agents spam decisions, founder ignores Inbox. Rate-limit to 1 decision per agent per hour during beta.
- **Outcome follow-up delivery:** Founder may not see Slack DM if they're on vacation. No retry logic yet; outcome may be lost.
- **Third-party data:** Outcome follow-up depends on Slack channel being live; if Slack app loses permission, cron fails silently.

## Out of scope (but considered)

- Auto-approval based on decision confidence score
- Delegated approval (founder assigns to cofounder)
- Decision templates / quick-approve buttons
- A/B testing different decision phrasings
- Integration with HubSpot deals or Notion projects to pre-check decision validity

## Test plan

### Manual
- [ ] Create a decision draft via agent API → appears in Inbox within 5 sec
- [ ] Approve a decision → issue auto-created + Slack notification sent
- [ ] Reject with reason → reason stored + agent notified
- [ ] 14-day follow-up: simulate cron, verify Slack DM received

### E2E (must be green)
- [ ] `test/e2e/decisions.spec.ts` — full flow: draft → approve → outcome
- [ ] `test/e2e/decisions-rejection.spec.ts` — rejection with reason + agent notification
- [ ] `test/e2e/outcomes-followup.spec.ts` — 14-day cron delivers DM

### Coverage
- `approvals.ts` service: 80%+ unit test coverage
- `approval-routes.ts`: 90%+ endpoint coverage
