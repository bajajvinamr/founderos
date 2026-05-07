## [0.10.0] - 2026-05-07 07:18:52 UTC

## [0.10.0] - 2026-05-07 07:01:16 UTC

## [0.10.0] - 2026-05-07 06:55:38 UTC

## [0.10.0] - 2026-05-07 06:40:52 UTC

## [0.9.0] - 2026-05-07 06:24:06 UTC

### Added
- feat(ui): human-readable verbs for cycle-6 audit actions (#68) (8c59d84)

## [0.8.3] - 2026-05-07 06:11:40 UTC

### Fixed
- fix(e2e): navigate to /landing directly, not / (mode drift) (#70) (679f45a)

## [0.8.2] - 2026-05-07 05:49:58 UTC

## [0.8.2] - 2026-05-07 05:41:44 UTC

## [0.8.1] - 2026-05-07 05:34:59 UTC

### Fixed
- fix(ui): preserve HTTP status + requestId on onboarding bootstrap error (P1-8) (#64) (a613c55)

## [0.7.0] - 2026-05-07 05:30:23 UTC

### Added
- feat(billing): audit row on billing-gate 402 (P1-6c, ADR-013) (#63) (240502f)

## [0.6.15] - 2026-05-07 05:25:17 UTC

### Fixed
- fix(observability): audit log magic-link issuance + consumption (P1-6a) (#59) (bd5c9f2)

## [0.6.13] - 2026-05-07 05:14:15 UTC

### Fixed
- fix(e2e): decouple onboarding-v2 spec from literal step count (P1-9b) (#61) (2827b4b)

## [0.6.12] - 2026-05-06 22:21:40 UTC

## [0.6.11] - 2026-05-06 22:05:46 UTC

### Fixed
- fix(observability): extend env validator + delete master-branch dead workflow (P1-11) (#57) (aac7d9e)

## [0.6.9] - 2026-05-06 21:45:16 UTC

### Fixed
- fix(observability): wrap hubspot-sync BullMQ worker in runCronTaskWithRethrow (P1-5b) (#55) (ea40caf)

## [0.6.7] - 2026-05-06 21:25:01 UTC

### Fixed
- fix(observability): wrap 6 cron schedulers in runCronTick helper (P1-5) (#52) (06f442c)
- fix(seed): align heartbeat_runs demo status with 0085 enum (P1-5c) (#53) (5c937ad)

## [0.6.6] - 2026-05-06 21:08:28 UTC

## [0.6.5] - 2026-05-06 20:54:44 UTC

### Fixed
- fix(security): expand pino redact paths + drop signupUrl log (P1-7) (#50) (c554539)
- fix(security): wrap invite consume + role grant in db.transaction (P1-4) (#49) (565c5eb)

## [0.6.4] - 2026-05-06 20:42:52 UTC

## [0.6.3] - 2026-05-06 20:21:43 UTC

### Fixed
- fix(security): block agent self-PATCH on privileged fields (P0-1) (#43) (9e212f4)

## [0.6.1] - 2026-05-06 20:18:57 UTC

### Fixed
- fix(e2e): skip /api/health/deep probe in public-only profile (closes #42) (#45) (c594760)

## [0.6.0] - 2026-05-06 20:07:01 UTC

## [0.5.0] - 2026-05-06 15:24:53 UTC

### Added
- feat: 2-week LRP merge — Sprints 4.8/5/6 + READY FOR CLIENT verdict (b2ec2d7)
- feat(s6.10): MVP cutover — ADR-012 + design partner onboarding kit (38dae34)
- feat(s6.8): onboarding draft persistence — save-and-resume backbone (ab47910)
- feat(s6.7): magic-link tokens — service + schema + tests (cf871f7)
- feat(s6.6): notifications data layer (schema + service + route) (47c1351)
- feat(s6.4): agent memory schema — category + embedding + TTL (031463a)
- feat(s6.5): named workflow templates registry (bbe16dd)
- feat(s6.3): audit lineage — expand activity_log refs into upstream chain (e2262c5)
- feat(s6.2): approval engine — link to workflow runs + autonomy promotion (cc0bb6e)
- feat(s6.1): permissions matrix view (read-only) (240c2fe)
- feat(s5.10): wire scenario modeling into finance console (5b86d0e)
- feat(s5.4): natural-language finance scenario modeling (f55d7c2)
- feat(s5.8): cash planning with stackable scenario adjustments (ce5fd0f)
- feat(s5.7): experiment ROI rollup — completed lift → attributable MRR (1e6cbe9)
- feat(s5.5): runway forecast with conservative/base/optimistic bands (af39d5e)
- feat(s5.3): churn forecast — exp(-b·t) cohort retention curve fit (8045f57)
- feat(s5.2): pricing simulator — composes runScenario with elasticity (156ed66)
- feat(s5.1): revenue cockpit — live MRR/ARR/churn/LTV/CAC/payback math (39108d5)
- feat(s5.6): marketing_spend ledger — channel × period × amount (c57fd8e)
- feat(s5.9): finance settings — singleton-per-company manual inputs (9f01b52)
- feat(s6/security): strip /api/health ROOT to {status, version} (task #139) (cc1d891)
- feat(s4.8): churn-rescue trigger orchestrator — closes the create-time loop (#164 part 3) (57ca011)
- feat(s4.8): churn-rescue generator — run-CREATION time builder (#164 part 2) (7cba53b)
- feat(s4.8): churn-rescue template — composition of 8 prereqs (#164) (16bb70c)
- feat(s4.8-prereq): pre-compute recipient materialization gate (#195) (8dee293)
- feat(s4.8-prereq): workflow_run approval state machine (#194) (8bf3e97)
- feat(s4.8-prereq): cancellation-category PII allowlist for churn-rescue prompts (#193) (74f576c)
- feat(s4.8-prereq): typed connectedAccountId resolver for cross-org leak prevention (#198) (9f5f545)
- feat(s4.8-prereq): per-tenant daily rate limit on workflow_run creation (#199) (d6ca198)
- feat(s4.8-prereq): email-wrapper compliance layer + per-tenant physical address (#197) (3f82823)
- feat(s4.8-prereq): auto-insert customer_email_suppressions on Resend hard bounce + spam complaint (#196 layer 4) (77a4306)
- feat(s4.8-prereq): suppression skip + unsubscribe URL in upsell template (#196 layer 3e) (564a38e)
- feat(s4.8-prereq): suppression skip + unsubscribe URL in activation-nudge (#196 layer 3d) (a871d08)
- feat(s4.8-prereq): inject HMAC unsubscribe URL into onboarding email body (#196 layer 3c-2) (99f1a3f)
- feat(s4.8-prereq): pre-send suppression check in onboarding template (#196 layer 3c-1) (1a0e05e)
- feat(s4.8-prereq): unsubscribe route handler + URL convention (#196 layer 3b) (c139801)
- feat(s4.8-prereq): suppression check + idempotent insert helpers (#196 layer 3a) (9d2c820)
- feat(s4.8-prereq): unsubscribe token HMAC service (#196 layer 2) (425c7ae)
- feat(s4.8-prereq): customer_email_suppressions schema (#196 layer 1) (ce6b4c5)
- feat(s4.8-prereq): churn reason classifier + PII allowlist (89c8024)
- feat(s4.8-prereq): workflow_runs.idempotency_key + unique constraint (5aa22f1)
- feat(s4.4): automated content publishing with calendar UI (413348f)
- feat(s4.3): content attribution engine with tracking links and metrics (b1858c3)
- feat(w0.3b): runner token rotation endpoint + 90-day default TTL (council 2026-05-05 P1) (386590d)
- feat(w0.3a): runner token TTL + middleware expiry gate (council 2026-05-05 P1) (b24c63a)
- feat(w0.2c): Resend webhook receiver — close accept != deliver buyer-trust gap (f2fdc10)
- feat(s4.9): upsell workflow template (c2cb71a)
- feat(s4.7): activation nudge workflow template (9f1ef1e)
- feat(s4.2): multi-format content generator + content_drafts schema (ec63b9a)
- feat(s4.1): content brief schema + intake API (c5478fe)
- feat(s4.5): lifecycle CRM workflow registry + RBAC + autonomy gate (086faab)
- feat(tc-2): exorcise mock data from GrowthConsole on paid path + analytics milestone (ccaa661)
- feat(settings): add telemetry consent toggle to /settings/general (4f3bc5e)
- feat(onboarding): add explicit telemetry consent step at end of wizard (29e87fe)
- feat(telemetry): persist consent decision in instance_settings.general (4df4941)
- feat(tc-3): tenant invariants — composite FKs + status CHECKs (idx 82) (ce9959e)
- feat(tc-4): wire prod auth canary + Sentry alert routes + SLOs (7682c2a)
- feat(s3.10): magic activation gate — 10-min first-value via auto-backfill + first brief (4bbf4ac)
- feat(s3.6): growth experiment suggester (LLM proposals + pgvector dedup) (6a79405)
- feat(s3.8): channel recommendation engine (last-touch attribution, 30d window) (06d1e19)
- feat(s3.9): LinkedIn growth attribution insight (UTM-based + time-correlation fallback) (d02515c)
- feat(s3.3): daily founder brief generator (LLM-driven, idempotent, TZ-aware) (d1652e6)
- feat(s3.4): department status rollup endpoint + live grid card (dee1733)
- feat(s3.7): funnel diagnostics endpoint + Recharts UI + worst-step blocker insight (18094a2)
- feat(s3.2): KPI anomaly detection job (15-min cron, ±2σ threshold, 24h dedup) (97a7b0a)
- feat(s3.5): experiments schema + API + Growth Experiments tab (b3f30b2)
- feat(s3.1): insights schema + API + tests (8eff28e)

### Fixed
- fix(s6.9): defensive header read in api client + log v1.1 backup-lib flake (2fda41c)
- fix(s6.9): drain drizzle pool before embedded-pg cleanup (test flake) (f232984)
- fix(test): repair pre-existing scaffolding tests from commit 2db3d17 (a187d0f)
- fix(test): repair pre-existing fixture bugs unblocking 10 tests (920945b)
- fix(test): inject EMAIL_UNSUBSCRIBE_SECRET in workflows.test.ts beforeAll (8afafeb)
- fix(w0-r1-closeout): activation-nudge dispatcher + onboarding workflow_run_id tag (council R1 P1) (0759cbc)
- fix(w0.4): RunnerInstallDialog FOUNDEROS_API_URL → FOUNDEROS_RUNNER_URL + expiry hint (council 2026-05-05 P1) (97ff663)
- fix(w0.2-upsell-nudge): real EmailTransport for upsell + activation-nudge templates (893376c)
- fix(w0.2-onboarding): real EmailTransport for onboarding-emails template (3 of 4 stubs) (b93a94e)
- fix(w0.1): wire POST /workflows/:id/runs to executeWorkflowTemplate dispatcher (cb1a879)
- fix(security): council 2026-05-06 S4.5 BLOCK + R2 P2 — autonomy re-check + RBAC strict + workflowId audit + hubspot connectionId (52f1f7d)
- fix(security): council 2026-05-05 R1 P2 — telemetry consent runtime hydration + hubspot status=active filter (C1+C2) (b1b1e55)
- fix(security): hubspot Drizzle && bug — replaced with and() (cross-tenant + cross-app leak) (60a287c)
- fix(telemetry): default consent OFF in all config layers (adf1763)

## [0.4.0] - 2026-05-05 16:02:58 UTC

## [0.3.0] - 2026-05-05 14:49:22 UTC

### Added
- feat(s1+s2): Sprint 1 Foundation + Sprint 2 Integrations + pre-S3 trust closure + CodeQL fixes (5b02b1c)
- feat(billing): server-side plan-tier enforcement middleware (#35) (0c4c8db)
- feat(byo-runner): M3 — UI runner install dialog + status pill on Agents page (#25) (2886c79)
- feat(byo-runner): M2 — @founderos/runner npm package (poll + claim + spawn + events + complete) (#24) (90d2c52)
- feat(byo-runner): Sprint 1 BE — REST endpoints, runner adapter, observability (BYO-101→110) (#23) (ab9ad05)
- feat(byo-runner): Sprint 0+1 foundation — ADR + OpenAPI + DB + auth mw + adapter (BYO-001/002/003/005/101/102/103) (de284c7)
- feat(council-2026-05-03): Phase 0 production hardening — observability + atomic auth + Fly cutover (#20) (1abcf59)

### Fixed
- fix(billing): Stripe webhook idempotency + newest-row precedence + trialing as healthy (#33) (40c009d)
- fix(security): baseline CSP + security headers on every response (#32) (3b5e208)
- fix(security): rate limit on agent-invoke + onboarding bootstrap (#31) (caa8ef3)
- fix(security): close Composio cross-org leak — require connectedAccountId (#30) (3cf54a2)
- fix(self-serve): /deep auth gate + run-failure status + Fly release_command (#29) (6c00e21)
- fix(auth): mirror Supabase identity into public."user" + FK orphan guard (#28) (54cee94)
- fix(p0): placeholder.supabase.co — restore prod auth + heavy logging + DevOps plan (#27) (7221b88)
- fix(council-2026-05-03): Phase 0 follow-up fixes — 8 council items (#21) (cf4802c)
- fix(e2e): close #17 — add dialog role + testid to onboarding wizard (#19) (82ca8e2)

## [0.2.16] - 2026-05-02 01:32:34 UTC

## [0.2.15] - 2026-05-02 01:11:25 UTC

### Fixed
- fix(e2e): boot server before seed in critical-flows workflow (#15) (f1ce47d)

## [0.2.13] - 2026-05-02 00:13:01 UTC

### Fixed
- fix(onboarding): make bootstrap atomic and retry-safe (#14) (1095639)

## [0.2.11] - 2026-05-01 23:39:08 UTC

### Fixed
- fix(ci): grant actions:read on pr-info workflow (#13) (37ed506)

## [0.2.10] - 2026-05-01 23:23:30 UTC

## [0.2.10] - 2026-05-01 22:49:00 UTC

## [0.2.10] - 2026-05-01 22:34:05 UTC

## [0.2.10] - 2026-05-01 21:32:30 UTC

## [0.2.10] - 2026-05-01 21:17:58 UTC

### Changed
- refactor(routes): remove redundant actor cast in health.ts (4d6bdd0)

## [0.2.9] - 2026-05-01 21:06:24 UTC

### Fixed
- fix(types): remove unsafe cast in ExecutionRouteDeps by widening targetDate type (ac7928d)

### Changed
- refactor(types): add rawBody to Express.Request; export actorCanAccessCompany from authz (5db66c5)
- refactor(routes): export ClosedWorkspace from issues-execution; import in issues-comments (c4373ab)
- refactor(routes): have issues-feedback import query-utils directly; remove injected parse deps (32191f1)
- refactor(routes): extract parseBooleanQuery/parseDateQuery to shared utility; fix health.ts actor cast (6f78fa6)

## [0.2.8] - 2026-05-01 20:40:51 UTC

### Changed
- refactor(routes): split issues.ts into 5 focused route modules (e68e1b7)

## [0.2.7] - 2026-05-01 20:33:32 UTC

### Fixed
- fix(auth): run post-signup bootstrap on cookie-session path (db5c1b4)

## [0.2.5] - 2026-05-01 19:43:22 UTC

### Changed
- perf(auth): batch ensureLocalTrustedBoardPrincipal membership inserts (8999fa0)

## [0.2.3] - 2026-05-01 19:31:22 UTC

### Fixed
- fix(security): Phase 1+2 — log redaction, env log level, auth query dedup, lastUsedAt debounce (1a5ed86)

## [0.2.1] - 2026-05-01 19:27:30 UTC

### Fixed
- fix(ci): create git tag locally before push instead of via API (c2f8f4f)

## [0.1.0] - 2026-05-01 19:25:49 UTC

### Added
- feat(ui): branded boot splash + fast-path root → /landing (08dc28d)
- feat(composio): /status honest + 5 more toolkits in configured list (d196da8)
- feat(composio): v3 client migration (ticket 001) (d8ef5da)
- feat(composio): gate v1 client off by default (COMPOSIO_V3_READY flag) (70ced91)
- feat(billing): wire Stripe SDK — real checkout + webhook verification (af2a083)
- feat(wave-22): enterprise CI/CD — PR gates, deploy pipeline, security, release, hygiene (2168a1c)
- feat(wave-21): composio integration layer — one SDK for 250+ tools (7f1d415)
- feat(wave-19a): agent-to-agent handoffs — the AI company primitive (5e54fe8)
- feat(wave-19b): notion action skills (create_page, append_block) (a95588e)
- feat(wave-18): more agent actions + auto weekly delivery + contextual tour (04b8f77)
- feat(wave-17): agents that actually do things — daily digest, slack post, outcome loop, autonomy coach, customer conversations (eecd8da)
- feat(wave-16): tenant isolation + timeout UX + mobile + flake quarantine (2cb4e86)
- feat(wave-15): founder-native onboarding + interview-ready demo seed (7ce018a)
- feat(wave-14): anthropic-key validation + Sentry + rate limiting + MPG backup docs (ad9eea1)
- feat(auth): inline post-signup bootstrap in session resolver (a2be35c)
- feat(deploy): backend on Fly.io (founderos.fly.dev) + MPG lhr (f516ec2)
- feat(wave-13): Supabase Auth (email+pw + Google OAuth + magic links + reset) (0affe53)
- feat(wave-12): Notion integration, invite flow, billing scaffold, legal, Fly polish, runbooks (642d1cd)
- feat(waves-9-11): brief composer, real HubSpot, Slack, OAuth, tool-layer perms, PWA, monthly reviews, CI, hire-assist (e7ea953)
- feat(wave-8): docs site + board-claim UX + department empty states (4cb1691)
- feat(wave-7): real PostHog data + welcome email + E2E smoke test (f163461)
- feat(wave-6): Company Memory v1 + real scenario modeling engine (60551eb)
- feat(wave-5): Weekly Wrap + 1:1 chat drawer + mobile polish (56fce5b)
- feat(wave-4): integration framework + 5 connectors (Stripe deferred) (e669a05)
- feat(wave-3): 4-level permissions + audit log viewer (316f1d3)
- feat(wave-3): Decision Inbox — first-class approvals screen (f811385)
- feat(wave-2): four specialized department consoles + dispatcher (63e4f68)
- feat(wave-1): landing reposition + company charter + department nav scaffold (4638e6f)
- feat: full SaaS landing — 13 sections, humanized copy (85efdc0)
- feat: landing page reborn in Pulse Builders register (73d4c26)
- feat: deeper landing page — pulse beats, team roster, old-way comparison (a5353e2)
- feat: public marketing landing page at /landing (Coda-inspired) (155358d)
- feat: ROI signal on roster cards — issues closed this month per teammate (a7573f4)
- feat: Morning Brief adds Today's Focus + Runway chip (5c8d3bd)
- feat: Founder Briefing gains a "Brief the team" action (89ea0cb)
- feat: Founder's Briefing — the dashboard's new hero (4440953)
- feat: activity feed verbs use employment vocabulary (de7e013)
- feat: employment vocabulary on teammate actions + cost breakdowns (c8b7c05)
- feat: second-pass vocabulary — shift schedule, workstations, on-call (0feebda)
- feat: vocabulary sweep — business-first language across the product (a43244f)
- feat: sidebar section labels shed the mono-caps "dev tool" look (b26b718)
- feat: Costs page header + breadcrumb bar typography refresh (036bfb0)
- feat: editorial page headers + softer EmptyState (b0aa590)
- feat: MetricCard + Dashboard cards adopt editorial spec (ef05e83)
- feat: refine Company Pulse widget — editorial, no gradient (5d3b123)
- feat: deep design sweep — editorial headers + Notion/Coda roster cards (895ebde)
- feat: Notion/Coda-inspired editorial redesign of onboarding + auth (ce65578)
- feat: visible sign-out in the sidebar footer (fd86b1a)
- feat: AuthPage brand panel — team-framed pitch + accurate stats (c7ebff4)
- feat: per-teammate monthly budget bar on roster cards (5363929)
- feat: CompanyProvidersWidget uses team-framed language (fd777d8)
- feat: AgentDetail copy — teammate-framed tooltips and permission hints (2fd2df8)
- feat: agent-config help + placeholders → teammate language (e1c47a6)
- feat: onboarding + cost page copy refresh (3099338)
- feat: team-centric Dashboard copy (af741db)
- feat: teammate-style labels across status badges + onboarding + selectors (bb61221)
- feat: team-centric UX — rebrand "Agents" to "Team" + new roster card view (c16bae8)
- feat: provider demand analysis for built-in templates too (4ca15ab)
- feat: surface per-family provider demand for imported templates (bb1bce1)
- feat: preview imported templates before spawn (603f966)
- feat: one-click clone + template JSON import in onboarding (28dbd0f)
- feat: inline template JSON at spawn — true export→import round-trip (9567534)
- feat: dedicated liveness + readiness probes, dogfood playbook (92d9f02)
- feat: export company as template, filter agents by provider, 12 new tests (b9e382c)
- feat: onboarding wizard, provider overview, agent provider badges, smoke tests (4374f98)
- feat: template system, multi-provider agents, Clerk auth, deploy pipeline (b0c2158)

### Fixed
- fix(ci): guard GITHUB_OUTPUT version extraction against multi-line grep output (13692f8)
- fix(ci): skip generic system accounts in forbidden-token check (d5cbc58)
- fix(ci): resolve remaining lint and schema-drift failures (731246d)
- fix(ci): add tsx to root devDeps + exclude workflows from token check (aa43eb4)
- fix(ci): commit express.d.ts type augmentation + unignore types/ (a7eaed3)
- fix: bump SW cache to v2 + stop caching hashed JS/CSS bundles (7285f20)
- fix: guard AuthPage redirect on sessionLoading + add landing/legal to global routes (4cfaacb)
- fix(ci): remove empty 'with:' blocks left by pnpm version pin removal (0300e51)
- fix(ci): bump ossf/scorecard-action to v2.4.0 (v2 tag removed) (67175c9)
- fix(ci): remove pnpm version pins — let packageManager in package.json drive (cb9831a)
- fix(ci): repair Gitleaks secretGroup config and E2E pnpm version conflict (aa9067e)
- fix: repair auth redirect loop that kept users stuck on landing page (bd0ecd1)
- fix(security): enforce iss/aud in JWT verification; scope demo seeder to demo agents; fix resolvePluginUiDir containment check (5549346)
- fix(e2e): fix synthetic monitor — em dash in UA header + landing CTA regex (0af7460)
- fix: remediate P1/P2 council findings for production readiness (68696e2)
- fix(ui): broken Google Fonts URL returning 400 (9d83761)
- fix(review): harden cross-tenant isolation + HANDOVER curl + skills counter (f13cb2a)
- fix(test): health.test.ts un-skipped via module-level vi.mock (838fe52)
- fix(health): switch composio ping to v3 API (v1 fully deprecated) (7e9438e)
- fix(health): use stable Composio auth-configs endpoint, not deprecated /internal/sdk/metadata (410) (7550b4b)
- fix(onboarding): claude-local adapter works without API key (ddb71e2)
- fix(router): route roots that weren't registered were mis-parsed as company prefix (f198121)
- fix(wave-20): dynamic first-decisions + signup bootstrap race (a35f673)
- fix(bootstrap-gate): route to /auth when pending + unauthenticated (eab3263)
- fix: landing scrolls — override app-shell's overflow:hidden on body (a346aa7)
- fix: tsconfig refs — replace deleted droid-local with gemini-local (606bf76)
- fix: harden test infra against NODE_ENV=production and Node.js 25 builtins (1ce2eb7)
- fix: resolve typecheck and test failures across cli and ui (c88e3c7)

### Changed
- refactor(company-portability): extract pre-service helpers module (945bb16)
- refactor(heartbeat): extract pre-service helpers to heartbeat-helpers.ts (11ab707)
- refactor(ui): split AgentDetail.tsx into LogViewer + AgentTabs modules (fd839a6)
- refactor(cli): split worktree.ts into storage + infra modules (53b513a)

## [Unreleased]

### Added
- Release automation (Wave 22D): semantic versioning, git tagging, CHANGELOG generation, GitHub Releases, Sentry release markers
- Conventional Commits enforcement via commitlint

---

## Release History

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
