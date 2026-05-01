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
