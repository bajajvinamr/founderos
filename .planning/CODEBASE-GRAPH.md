# FounderOS — Codebase Graph

Navigable map. Tables/trees beat prose. Filenames only — line numbers rot.
See `CLAUDE.md` for stack/known pitfalls. See `AGENTS.md` for contributor guide.

---

## 1. Top-level layout

```
founderos/                          pnpm workspaces (root scripts: dev, build, typecheck, test, db:*)
├── ui/                             @founderos/ui — React 19 + Vite SPA (entry: ui/src/main.tsx)
│   └── src/
│       ├── App.tsx                 router tree + auth gates (CloudAccessGate)
│       ├── pages/                  ~70 route components (lazy + 9 hot)
│       ├── components/             Layout, Sidebar, Onboarding wizards (x3), shadcn UI
│       ├── api/                    typed REST clients per domain (~50 files)
│       ├── context/                CompanyContext, SupabaseAuthContext, DialogContext
│       └── lib/                    router shim, queryKeys, branding, company-routes
├── server/                         @founderos/server — Node 24 + Express + Drizzle (entry: src/index.ts)
│   └── src/
│       ├── app.ts                  createApp(): mounts middleware + 80+ route routers + crons
│       ├── routes/                 83 route modules (~431 endpoints total)
│       ├── services/               146 domain service modules
│       ├── middleware/             auth, billing-gate, request-id, error-handler, rate-limit
│       ├── auth/                   better-auth, clerk, supabase, post-signup-hook
│       ├── lib/                    request-context (ALS), ssrf-guard, queues, env-validation
│       └── jobs/                   cron-style background jobs
├── packages/
│   ├── shared/                     Zod schemas, types, API path constants (re-exported)
│   ├── db/                         Drizzle schema (~92 tables), migrations, embedded-pg helper
│   ├── adapters/                   10 adapter packages (API + CLI families) — see §6
│   ├── runner/                     @founderos/runner — laptop CLI process that runs CLI-family adapters
│   ├── adapter-utils/              shared adapter helpers
│   ├── plugins/                    plugin framework + example plugins
│   ├── mcp-server/                 MCP server impl
│   └── templates/                  template registry assets
├── cli/                            @founderos/cli — `founderos` command (auth bootstrap-ceo, etc.)
├── e2e/                            Playwright (deployed-origin, Wave 23A critical-flows)
├── tests/e2e/                      Playwright (local webServer for onboarding/signoff)
├── supabase/                       Supabase project config + edge fns (auth provider)
└── scripts/                        dev-runner, deploy helpers, migration tooling
```

---

## 2. UI route map (`ui/src/App.tsx`)

All routes inside `<CloudAccessGate>` (the `<Outlet/>` wrapper) require a Supabase session in `authenticated` deployment mode. Routes outside the gate are public.

### Public (outside CloudAccessGate)

| Path | Component | API calls |
|---|---|---|
| `/landing` | `Landing` (eager) | none |
| `/auth`, `/auth/forgot`, `/auth/reset` | `AuthPage`, `ForgotPassword`, `ResetPassword` | `/api/auth/config`, Supabase SDK |
| `/legal/terms`, `/legal/privacy` | `LegalTerms`, `LegalPrivacy` | none |
| `/board-claim/:token` | `BoardClaimPage` | `/api/access/claim/*` |
| `/cli-auth/:id` | `CliAuthPage` | `/api/access/cli-auth/*` |
| `/invite/:token` | `InviteLandingPage` | `/api/instance/invites/*` |
| `*` (catch-all) | `NotFoundPage scope=global` | none |

### Auth-gated, instance-scoped (under CloudAccessGate)

| Path | Component | API calls |
|---|---|---|
| `/` | `CompanyRootRedirect` → `/:prefix/dashboard` | `/api/health/bootstrap-state`, `/api/auth/session`, `/api/companies` |
| `/onboarding` | `OnboardingRoutePage` | opens dialog (no direct fetch) |
| `/instance/settings/general` | `InstanceGeneralSettings` | `/api/instance/settings*` |
| `/instance/settings/members` | `InstanceAdminMembers` | `/api/instance/members*`, `/api/instance/invites*` |
| `/instance/settings/providers` | `InstanceProvidersSettings` | `/api/providers/*`, `/api/byo-key/*` |
| `/instance/settings/heartbeats` | `InstanceSettings` | `/api/instance/scheduler-heartbeats` |
| `/instance/settings/experimental` | `InstanceExperimentalSettings` | `/api/instance/*` |
| `/instance/settings/plugins[/:id]` | `PluginManager`, `PluginSettings` | `/api/plugins/*` |
| `/instance/settings/adapters` | `AdapterManager` | `/api/adapters/*` |
| `/instance/settings/ai-connections` | `AiConnections` | `/api/byo-key/*`, `/api/providers/*` |
| `/settings/notifications` | `NotificationsSettings` | `/api/notifications/*` |
| Unprefixed `companies\|issues\|agents\|projects\|...` | `UnprefixedBoardRedirect` | redirects to `/:prefix/<path>` |

### Board (company-scoped: `/:companyPrefix/...`)

Grouped because there are 50+ routes under `Layout` + `boardRoutes()`.

| Domain | Paths | Components | Primary API calls |
|---|---|---|---|
| Today/Inbox | `today`, `inbox/*` | `Today`, `Inbox` | `/api/dashboard`, `/api/inbox-state` |
| Dashboard | `dashboard` | `Dashboard` | `/api/dashboard`, `/api/sidebar-badges` |
| Agents | `agents/all\|active\|paused\|error`, `agents/new`, `agents/:id[/:tab][/runs/:runId]`, `hire` | `Agents`, `NewAgent`, `AgentDetail`, `HireTeammate` | `/api/agents/*`, `/api/hire-proposal/*` |
| Companies | `companies`, `company/settings`, `company/export`, `company/import`, `memory`, `skills/*` | `Companies`, `CompanySettings`, `CompanyExport`, `CompanyImport`, `CompanyMemory`, `CompanySkills` | `/api/companies/*`, `/api/company-memory/*`, `/api/skills/*` |
| Projects | `projects[/:id[/overview\|issues[/:filter]\|workspaces[/:wsId]\|configuration\|budget]]` | `Projects`, `ProjectDetail`, `ProjectWorkspaceDetail` | `/api/projects/*`, `/api/execution-workspaces/*` |
| Issues | `issues`, `issues/:id` | `Issues`, `IssueDetail` | `/api/issues/*` |
| Routines | `routines[/:id]` | `Routines`, `RoutineDetail` | `/api/routines/*` |
| Workspaces | `execution-workspaces/:wsId[/configuration\|issues]` | `ExecutionWorkspaceDetail` | `/api/execution-workspaces/*` |
| Goals | `goals[/:id]` | `Goals`, `GoalDetail` | `/api/goals/*` |
| Approvals | `approvals[/pending\|all\|:approvalId]`, `decisions` | `Approvals`, `ApprovalDetail`, `DecisionsInbox` | `/api/approvals/*`, `/api/decision-outcomes/*` |
| Costs | `costs` | `Costs` | `/api/companies/:id/costs/*` |
| Org | `org`, `departments[/:id]` | `OrgChart`, `DepartmentConsole` | `/api/companies/:id/org*`, `/api/departments/*` |
| Integrations | `integrations` | `Integrations` | `/api/integrations/*`, `/api/composio/*`, `/api/oauth/*` |
| Permissions/Audit | `permissions`, `audit`, `alerts` | `Permissions`, `AuditLog`, `Alerts` | `/api/permissions-matrix/*`, `/api/audit-lineage/*` |
| Reports | `weekly`, `brief` | `WeeklyWrap`, `DailyBrief` | `/api/weekly-wraps/*`, `/api/daily-briefs/*` |
| Conversations | `conversations[/:id]` | `Conversations` | `/api/conversations/*` |
| Plugins | `plugins/:id`, `:pluginRoutePath` | `PluginPage` | `/api/plugins/:id/ui/*` |
| Dev/UX labs | `design-guide`, `tests/ux/chat`, `tests/ux/runs` | `DesignGuide`, `IssueChatUxLab`, `RunTranscriptUxLab` | varies |
| 404 | `*` (board scope) | `NotFoundPage scope=board` | none |

Onboarding wizard is a global `<Dialog>` (V2 `FounderOnboardingWizard` default, V1 `OnboardingWizard` legacy fallback), opened via `useDialog().openOnboarding()`. A third variant `OnboardingWizardNew` is rendered by `Dashboard.tsx` empty state. See CLAUDE.md "THREE onboarding wizards exist" pitfall.

---

## 3. API endpoint map

431 endpoints across 83 route modules — grouped by domain. All mount on `/api`. Public webhooks/tracking mount above `/api`. Method counts represent unique handlers within the file. Auth resolved globally by `actorMiddleware` (`middleware/auth.ts`); per-route gates noted below.

### Public (no auth)

| Method | Path prefix | Handler | Notes |
|---|---|---|---|
| ALL | `/api/auth/*` | `betterAuthHandler` / Supabase | provided by external auth lib |
| GET | `/api/auth/get-session` | `app.ts` | thin wrapper around `req.actor` |
| GET | `/api/auth/config` | `app.ts` | provider/publishable key only |
| POST | `/api/auth/webhook` | `routes/auth-webhook.ts` | Supabase user.created (Svix verified) |
| POST | `/api/webhooks/resend` | `routes/resend-webhook.ts` | Svix verified |
| GET | `/api/healthz`, `/api/readyz` | `app.ts` | liveness/readiness probes |
| GET | `/api/health` (root) | `routes/health.ts` | `{status, version}` only |
| GET | `/api/health/bootstrap-state` | `routes/health.ts` | deploymentMode/bootstrapStatus |
| GET | `/api/health/diagnostics` | `routes/health.ts` | **admin-gated** |
| GET | `/api/health/deep` | `routes/health.ts` | **admin-gated** (assertInstanceAdmin) |
| GET | `/c/:trackingId` | `routes/content-tracking.ts` | content-link redirect, no auth |
| GET/POST | `/u/customer/:token` | `routes/customer-email-unsubscribe.ts` | HMAC-trusted, CAN-SPAM |
| POST | `/api/providers/validate-key` | `routes/providers.ts` | rate-limited 10/5min/IP |
| GET/POST | `/api/runner/*` | `routes/runner.ts` | Bearer `fos_*` runner token (when `FOUNDEROS_BYO_RUNNER_ENABLED=1`) |

### Auth-gated session API (mounted under `Router` with `boardMutationGuard()`)

Endpoint count per route file (top 40; total 83 files / 431 endpoints):

| Endpoints | Route file | Domain | Notable gates |
|---|---|---|---|
| 53 | `agents.ts` | agents, hires, configurations, runtime-state, wakeup | `billingGate` on `:id/wakeup` |
| 29 | `access.ts` | board-claim, CLI auth, member access | claim tokens hashed |
| 26 | `plugins.ts` | plugin lifecycle, jobs, tools, UI mount | per-plugin capability checks |
| 19 | `costs.ts` | LLM cost summary by agent/model/project | company-scoped |
| 17 | `companies.ts` | CRUD, branding, archive, export/import | `validate(...)` Zod per route |
| 13 | `issues.ts` | issue CRUD, labels, read-state, inbox-archive | + 6 sub-files (attachments, comments, documents, execution, feedback, checkout-wakeup) |
| 11 | `routines.ts` | routine CRUD, runs, triggers | |
| 10 | `projects.ts` | project CRUD, workspaces | |
| 10 | `company-skills.ts` | skill registry per company | |
| 10 | `approvals.ts` | approve/reject/request-revision/comments | |
| 9 | `runner.ts` | token issuance, job claim/heartbeat | bearer token + `runnerAuthMiddleware` |
| 9 | `adapters.ts` | install, override, reload, reinstall, list | |
| 8 | `workflows.ts` | workflow + run CRUD | |
| 7 | `templates.ts`, `finance.ts` | templates / finance events | |
| 6 | `secrets.ts`, `integrations.ts`, `execution-workspaces.ts`, `agent-handoffs.ts`, `issues-execution.ts` | per name | |
| 5 | `notifications.ts`, `digest.ts`, `inbox-state.ts`, `goals.ts`, `company-memory.ts`, `content-drafts.ts`, `content-briefs.ts`, `activity.ts`, `issues-feedback.ts` | per name | |
| 4 | `onboarding.ts`, `marketing-spend.ts`, `instance-settings.ts`, `instance-invites.ts`, `health.ts`, `decision-outcomes.ts`, `daily-briefs.ts`, `conversations.ts`, `agent-reviews.ts`, `issues-attachments.ts` | per name | onboarding bootstrap rate-limited |
| ≤3 | 35 remaining files | dashboard, sidebar-badges, departments, billing, composio, oauth, posthog-connector, weekly-wraps, hire-proposal, llms, assets, permission-coach, byo-key, providers, audit-lineage, template-registry, onboarding-draft, department-status, experiments, funnel, integration-data, integration-health, integration-dlq, finance-settings, company-providers, company-memory, companies-export, debug, stripe-backfill, permissions-matrix, org-chart-svg, issues-documents, issues-comments | all wired in `app.ts` lines 343–504 |

Mount sequence (in `server/src/app.ts` `createApp`):
```
trust-proxy → requestId → securityHeaders → json(10mb, rawBody) → httpLogger
→ privateHostnameGuard → actorMiddleware → updateRequestContext
→ better-auth handler + auth-webhook + resend-webhook + llmRoutes + runner (outside session)
→ Router(api) with boardMutationGuard → healthz/readyz + 80 routers
→ contentTrackingRoutes + customerEmailUnsubscribeRoutes (above /api)
→ /api 404 → pluginUiStatic → static UI / Vite dev
→ sentryErrorHandler → errorHandler
→ Crons: dailyDigest, decisionFollowup, weeklyWrapDelivery, linkedinSync, dailyFounderBrief
```

---

## 4. Service layer (`server/src/services/`)

146 modules. Grouped by domain. Refer to file for full DB-table touch list.

| Domain | Files | Purpose |
|---|---|---|
| **Agents/runtime** | `agents.ts`, `agent-handoff.ts`, `agent-instructions.ts`, `agent-permissions.ts`, `agent-reviews.ts`, `default-agent-instructions.ts`, `heartbeat.ts`, `heartbeat-helpers.ts`, `heartbeat-run-summary.ts`, `hire-hook.ts`, `hire-proposal.ts`, `live-events.ts`, `agents/` (subdir) | agent CRUD, heartbeat loop, wakeup gating, run telemetry |
| **Onboarding/bootstrap** | `onboarding-bootstrap.ts` (in routes path?), `magic-link.ts`, `instance-invite.ts`, `instance-api-keys.ts`, `instance-settings.ts`, `board-auth.ts`, `anthropic-key-validator.ts`, `provider-credentials.ts` | first-user-wins flow, key vault, invites |
| **Companies/orgs** | `companies.ts`, `company-export-readme.ts`, `company-memory.ts`, `company-portability.ts`, `company-portability-helpers.ts`, `company-skills.ts` | company lifecycle, export bundles, RAG memory |
| **Issues/projects** | `issues.ts`, `issue-approvals.ts`, `issue-assignment-wakeup.ts`, `issue-execution-policy.ts`, `issue-goal-fallback.ts`, `projects.ts`, `project-workspace-runtime-config.ts`, `goals.ts`, `routines.ts`, `approvals.ts` | task/project state machines |
| **Workspaces** | `workspace-operations.ts`, `workspace-operation-log-store.ts`, `workspace-runtime.ts`, `workspace-runtime-read-model.ts`, `execution-workspaces.ts`, `execution-workspace-policy.ts` | execution-workspace lifecycle + ops log |
| **Billing/finance** | `subscription.ts`, `stripe-client.ts`, `stripe-backfill.ts`, `budgets.ts`, `cancellation-categories.ts`, `churn-reason-classifier.ts`, `costs.ts`, `finance.ts`, `finance/` (subdir), `quota-windows.ts` | Stripe subscription mirror, budget enforcement, USD spend rollups |
| **Integrations** | `composio-client.ts`, `composio-connection-resolver.ts`, `slack-client.ts`, `slack-digest.ts`, `slack-sync-cron.ts`, `hubspot-client.ts`, `hubspot-sync.ts`, `hubspot-sync-cron.ts`, `notion-client.ts`, `notion-sync-cron.ts`, `posthog-client.ts`, `posthog-poll.ts`, `posthog-sync.ts`, `linkedin-sync-cron.ts`, `github-fetch.ts`, `integrations/` (subdir) | per-vendor clients + sync crons |
| **Events/ingest** | `event-ingest.ts` (singleton — see CLAUDE.md), `conversation-extractor.ts`, `decision-outcomes.ts`, `decision-followup-cron.ts`, `audit-lineage.ts`, `activity.ts`, `activity-log.ts` | cross-source event normalization + audit |
| **Notifications/digests** | `notifications.ts`, `daily-digest.ts`, `daily-digest-cron.ts`, `email-sender.ts`, `email-templates.ts`, `email-unsubscribe-tokens.ts`, `customer-email-suppressions.ts`, `feedback-redaction.ts`, `feedback-share-client.ts`, `feedback.ts`, `weekly-wrap-generator.ts`, `weekly-wrap-poster.ts`, `weekly-wrap-delivery-cron.ts`, `yesterday-summary.ts`, `recipient-materialization.ts` | email + in-app notifications, weekly/daily reports |
| **Adapters** | `adapter-resolver.ts`, `adapter-plugin-store.ts`, `local-service-supervisor.ts` | adapter family mapping (anthropic_api → claude_local collapse) |
| **Plugins** | 16 `plugin-*.ts` files (`plugin-loader`, `plugin-lifecycle`, `plugin-registry`, `plugin-runtime-sandbox`, `plugin-job-scheduler`, `plugin-job-store`, `plugin-tool-dispatcher`, `plugin-worker-manager`, `plugin-secrets-handler`, `plugin-state-store`, `plugin-stream-bus`, `plugin-event-bus`, `plugin-host-services`, `plugin-manifest-validator`, `plugin-log-retention`, `plugin-tool-registry`) | plugin SDK runtime + worker pool |
| **Workflows** | `workflows.ts`, `workflow-autonomy.ts`, `workflow-rate-limit.ts`, `workflow-run-approval.ts`, `workflows/` (subdir) | declarative workflow runner |
| **CoS / dashboard** | `cos/` (subdir), `dashboard.ts`, `sidebar-badges.ts`, `documents.ts`, `assets.ts`, `secrets.ts`, `inbox-dismissals.ts` | chief-of-staff helpers, board UI feeds |
| **Templates/skills** | `template-export.ts`, `template-spawn.ts`, `skills/` (subdir) | starter template materialization |
| **Runner/transports** | `transports/` (subdir), `run-log-store.ts` | runner protocol + log streaming |
| **Misc** | `agents/`, `cron.ts`, `index.ts`, `work-products.ts` | re-exports + cron facade |

---

## 5. DB schema (`packages/db/src/schema/*.ts`)

92 table modules — exported through `schema/index.ts`. Grouped by domain.

### Auth / identity (DB: Fly MPG, mirror of Supabase `auth.users`)
`auth.ts` (authUsers/Sessions/Accounts/Verifications), `instance_settings`, `instance_user_roles`, `instance_invites`, `instance_api_keys`, `instance_subscription`, `board_api_keys`, `cli_auth_challenges`, `magic_link_tokens`, `invites`, `join_requests`, `principal_permission_grants`, `company_memberships`

### Companies / org structure
`companies`, `company_logos`, `company_memberships`, `company_secrets`, `company_secret_versions`, `company_skills`, `company_memory`, `departments`, `workspace_departments`, `company_financials`

### Agents
`agents`, `agent_api_keys`, `agent_config_revisions`, `agent_runtime_state`, `agent_task_sessions`, `agent_wakeup_requests`, `agent_handoffs`, `agent_reviews`

### Projects / workspaces / goals
`projects`, `project_workspaces`, `project_goals`, `execution_workspaces`, `workspace_operations`, `workspace_runtime_services`, `goals`

### Issues / approvals
`issues`, `issue_relations`, `issue_labels`, `labels`, `issue_approvals`, `issue_comments`, `issue_attachments`, `issue_documents`, `issue_work_products`, `issue_execution_decisions`, `issue_inbox_archives`, `issue_read_states`, `approvals`, `approval_comments`, `inbox_dismissals`, `inbox_state`, `decision_outcomes`

### Content / experiments / workflows
`content_briefs`, `content_drafts`, `experiments`, `workflows` (incl. `workflowRuns`), `routines` (incl. `routineTriggers`, `routineRuns`), `insights`

### Documents / assets
`documents`, `document_revisions`, `assets`

### Finance / billing / costs
`cost_events`, `finance_events`, `marketing_spend`, `budget_policies`, `budget_incidents`, `instance_subscription`

### Heartbeats / runner
`heartbeat_runs`, `heartbeat_run_events`, `runner` (exports `runnerTokens`, `runnerJobs`)

### Events / ingest
`events` (CHECK-constrained `source` enum), `conversations`

### Plugins
`plugins`, `plugin_config`, `plugin_company_settings`, `plugin_state`, `plugin_entities`, `plugin_jobs` (incl. `pluginJobRuns`), `plugin_webhooks`, `plugin_logs`

### Integrations
`integrations`, `integration-data` (note: filename uses dash), `composio_connections`

### Reports / notifications / feedback
`daily_briefs`, `weekly_wraps`, `notifications`, `feedback_votes`, `feedback_exports`, `activity_log`, `customer_email_suppressions`

### Onboarding
`onboarding_drafts` (partial UNIQUE on `(user_id) WHERE completed_at IS NULL`)

---

## 6. Adapter packages (`packages/adapters/*`)

10 packages. All have a `src/server/` (server-side dispatch); CLI-family also have `src/cli/` and `src/ui/` (install dialog). Runner-side handlers live in `packages/runner/src/adapters/`.

| Package | Family | Server module | Runner handler | Status |
|---|---|---|---|---|
| `@founderos/adapter-anthropic-api` | API | `src/server/execute.ts` (SDK `messages.create`) | — | Live as of 2026-05-18 (G3b) |
| `@founderos/adapter-openai-api` | API | `src/server/execute.ts` (SDK) | — | Live |
| `@founderos/gemini-api` | API | `src/server/execute.ts` (SDK) | — | Live |
| `@founderos/adapter-claude-local` | CLI | `src/server/execute.ts` (hosted-mode hardening only) | `runner/src/adapters/claude.ts` | Live — primary CLI path |
| `@founderos/adapter-codex-local` | CLI | `src/server/execute.ts` | `runner/src/adapters/codex.ts` | Dormant (V2 dispatcher flag) |
| `@founderos/adapter-gemini-local` | CLI | `src/server/execute.ts` | `runner/src/adapters/gemini.ts` | Dormant |
| `@founderos/adapter-cursor-local` | CLI | `src/server/execute.ts` | — (not in `ADAPTER_HANDLERS`) | Future |
| `@founderos/adapter-opencode-local` | CLI | `src/server/execute.ts` | — | Future |
| `@founderos/adapter-openclaw-gateway` | CLI/proxy | `src/server/execute.ts` + `src/shared/` | — | Experimental |
| `@founderos/adapter-pi-local` | CLI | `src/server/execute.ts` | — | Experimental |

Runner registry (`packages/runner/src/adapters/index.ts`): only `claude_local`, `codex_local`, `gemini_local` registered today via `ADAPTER_HANDLERS` (Partial Record + `satisfies`). API-family adapters intentionally absent — dispatched server-side.

---

## 7. Cross-cuts (where critical concerns live)

| Concern | File | Notes |
|---|---|---|
| Actor resolution / session auth | `server/src/middleware/auth.ts` (`actorMiddleware`) | Decides board/agent/system actor type; runs `runPostSignupBootstrap` for fresh Supabase users (`server/src/auth/post-signup-hook.ts`) |
| Request-scoped context (ALS) | `server/src/lib/request-context.ts` | All req-scoped logging/Sentry tags flow through `updateRequestContext`; background tasks need explicit `runInCronContext` |
| Request ID middleware | `server/src/middleware/request-id.ts` | Returns `x-request-id` header + `{requestId}` in JSON errors |
| Error handler | `server/src/middleware/error-handler.ts` + `sentry.ts` | Sentry first, then JSON envelope. Mounted last in `app.ts` |
| Billing gate | `server/src/middleware/billing-gate.ts` | OPT-IN via `FOUNDEROS_BILLING_GATE_ENABLED=1`. Mounted on `/agents/:id/wakeup`, `/heartbeat/invoke`. Defense-in-depth at `services/heartbeat.ts` `enqueueWakeup()` |
| JWT / Supabase auth bridge | `server/src/auth/supabase.ts` + `better-auth.ts` + `clerk.ts` | Asymmetric ES256 expected; mirror upserted into `public."user"` |
| Composio client | `server/src/services/composio-client.ts` (v3 only) + `composio-connection-resolver.ts` | `connectedAccountId` required to prevent cross-org leak |
| Stripe webhook | `server/src/routes/billing.ts` + `services/stripe-client.ts` + `services/subscription.ts` | Raw body via `verify` callback in `express.json`; idempotent on `stripeSubscriptionId` |
| Runner auth (bearer) | `server/src/middleware/runner-auth.ts` | sha256-hashed `fos_*` tokens, `timingSafeEqual` compare, updates `lastSeenAt` |
| Security headers / CSP | `server/src/middleware/security-headers.ts` | Baseline CSP applied to every response branch; per-route overrides layer on top |
| Rate limiting | `server/src/middleware/rate-limit.ts` | IP-keyed (relies on `app.set("trust proxy", 1)`); used by providers, byo-key, onboarding bootstrap |
| Private hostname guard | `server/src/middleware/private-hostname-guard.ts` | Only in `authenticated + private` deployments |
| Board mutation guard | `server/src/middleware/board-mutation-guard.ts` | Applied to the `api` Router (rejects unsafe verbs without session) |
| SSRF guard | `server/src/lib/ssrf-guard.ts` | Validates outbound URLs before fetches |
| Embedded postgres test helper | `packages/db/src/embedded-postgres-error.ts`, `client.ts` | `startEmbeddedPostgresTestDatabase(prefix)` returns `{connectionString, cleanup}` |
| UI auth state | `ui/src/context/SupabaseAuthContext.tsx` | Use `useSupabaseAuthOptional()` outside provider; `enabled: !auth.loading` gate on auth'd queries |
| UI router shim | `ui/src/lib/router.ts` + `lib/company-routes.ts` | `BOARD_ROUTE_ROOTS` set must include new top-level routes |
| Branding | `ui/src/branding.ts` + `server/src/ui-branding.ts` | Applied to `index.html` at static-serve time |
