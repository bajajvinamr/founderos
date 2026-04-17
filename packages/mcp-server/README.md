# FounderOS MCP Server

Model Context Protocol server for FounderOS.

This package is a thin MCP wrapper over the existing FounderOS REST API. It does
not talk to the database directly and it does not reimplement business logic.

## Authentication

The server reads its configuration from environment variables:

- `FOUNDEROS_API_URL` - FounderOS base URL, for example `http://localhost:3100`
- `FOUNDEROS_API_KEY` - bearer token used for `/api` requests
- `FOUNDEROS_COMPANY_ID` - optional default company for company-scoped tools
- `FOUNDEROS_AGENT_ID` - optional default agent for checkout helpers
- `FOUNDEROS_RUN_ID` - optional run id forwarded on mutating requests

## Usage

```sh
npx -y @founderos/mcp-server
```

Or locally in this repo:

```sh
pnpm --filter @founderos/mcp-server build
node packages/mcp-server/dist/stdio.js
```

## Tool Surface

Read tools:

- `founderosMe`
- `founderosInboxLite`
- `founderosListAgents`
- `founderosGetAgent`
- `founderosListIssues`
- `founderosGetIssue`
- `founderosGetHeartbeatContext`
- `founderosListComments`
- `founderosGetComment`
- `founderosListIssueApprovals`
- `founderosListDocuments`
- `founderosGetDocument`
- `founderosListDocumentRevisions`
- `founderosListProjects`
- `founderosGetProject`
- `founderosListGoals`
- `founderosGetGoal`
- `founderosListApprovals`
- `founderosGetApproval`
- `founderosGetApprovalIssues`
- `founderosListApprovalComments`

Write tools:

- `founderosCreateIssue`
- `founderosUpdateIssue`
- `founderosCheckoutIssue`
- `founderosReleaseIssue`
- `founderosAddComment`
- `founderosUpsertIssueDocument`
- `founderosRestoreIssueDocumentRevision`
- `founderosCreateApproval`
- `founderosLinkIssueApproval`
- `founderosUnlinkIssueApproval`
- `founderosApprovalDecision`
- `founderosAddApprovalComment`

Escape hatch:

- `founderosApiRequest`

`founderosApiRequest` is limited to paths under `/api` and JSON bodies. It is
meant for endpoints that do not yet have a dedicated MCP tool.
