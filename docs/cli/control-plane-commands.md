---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
pnpm founderos issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get issue details
pnpm founderos issue get <issue-id-or-identifier>

# Create issue
pnpm founderos issue create --title "..." [--description "..."] [--status todo] [--priority high]

# Update issue
pnpm founderos issue update <issue-id> [--status in_progress] [--comment "..."]

# Add comment
pnpm founderos issue comment <issue-id> --body "..." [--reopen]

# Checkout task
pnpm founderos issue checkout <issue-id> --agent-id <agent-id>

# Release task
pnpm founderos issue release <issue-id>
```

## Company Commands

```sh
pnpm founderos company list
pnpm founderos company get <company-id>

# Export to portable folder package (writes manifest + markdown files)
pnpm founderos company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
pnpm founderos company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run

# Apply import
pnpm founderos company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

## Agent Commands

```sh
pnpm founderos agent list
pnpm founderos agent get <agent-id>
```

## Approval Commands

```sh
# List approvals
pnpm founderos approval list [--status pending]

# Get approval
pnpm founderos approval get <approval-id>

# Create approval
pnpm founderos approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
pnpm founderos approval approve <approval-id> [--decision-note "..."]

# Reject
pnpm founderos approval reject <approval-id> [--decision-note "..."]

# Request revision
pnpm founderos approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
pnpm founderos approval resubmit <approval-id> [--payload '{"..."}']

# Comment
pnpm founderos approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm founderos activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
pnpm founderos dashboard get
```

## Heartbeat

```sh
pnpm founderos heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```
