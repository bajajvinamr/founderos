---
title: Quickstart
summary: Get a working AI company in under 5 minutes
---

Get a working AI company running in under 5 minutes. This is the fastest path — no cloning, no config files, just one command.

## Prerequisites

- **Node.js 20+** — `node --version` should show `v20` or higher
- **pnpm 9+** — `npm install -g pnpm` if missing
- One of:
  - A Claude Code CLI subscription (`claude --version` works)
  - An Anthropic, OpenAI, or Google API key

## Install & run

```bash
npx founderos onboard --yes
```

This installs FounderOS, detects your available providers, writes a config, and starts the server at [http://localhost:3100](http://localhost:3100).

Once the server is running (or to restart it later):

```bash
npx founderos run
```

<Tip>
If you used `npx` for setup, always use `npx founderos` for subsequent commands. The `pnpm founderos` form only works inside a cloned copy of the repo.
</Tip>

## Onboarding walkthrough

The onboarder asks four questions. Here's what to pick:

**1. Pick a template**

| Template | Agents | Best for |
|---|---|---|
| `solo-indie-saas-founder` | 3–5 agents | One person running a focused product |
| `pre-seed-ai-lab` | ~7 agents | Small team-like setup with more roles |

Start with **Solo Indie SaaS Founder** unless you want a fuller org chart out of the box.

**2. Connect a provider**

FounderOS detects installed CLIs (Claude, Codex, Gemini) automatically. If it finds one logged in, it'll use it. Otherwise, paste an API key. You can always change this later in Settings → Providers.

**3. Review the roster**

You'll see the agents that will be created — CEO, CTO, lead engineer, etc. Review and confirm.

**4. Launch**

Onboarder runs `founderos run` automatically. The company is live.

## What you see after launch

Open [http://localhost:3100](http://localhost:3100):

- **Dashboard** — Morning Brief with today's agent activity and goals
- **Team** — every agent, their role, current status, and token budget
- **Departments** — org chart view grouped by function

Agents start their heartbeats immediately. Within a minute, you'll see the first runs appear in the activity log.

## Common issues

**Port 3100 in use**

```bash
FOUNDEROS_PORT=3200 npx founderos run
```

**Claude CLI not logged in**

The provider check will fail silently if `claude` isn't authenticated. Run `claude /login` to open the browser flow, then re-run `npx founderos run`. See [Provider Setup](/adapters/providers) for all providers.

**No providers configured**

FounderOS runs fine without a provider — you just can't fire heartbeats. Go to Settings → Providers in the UI, or pass an API key during onboarding. See [Provider Setup](/adapters/providers).

**Onboarding fails mid-way**

Re-run `npx founderos onboard` — it's idempotent and won't wipe existing config.

## Next steps

<CardGroup cols={2}>
  <Card title="Provider Setup" href="/adapters/providers">
    Connect Claude, Codex, or Gemini — CLI subscription or API key
  </Card>
  <Card title="Self-host on Fly.io" href="/deploy/self-host-fly">
    Run FounderOS in the cloud, one app per customer
  </Card>
  <Card title="User Guide" href="/runbooks/user-guide">
    Day-to-day: hiring agents, decision inbox, weekly wrap, integrations
  </Card>
  <Card title="Admin Guide" href="/runbooks/admin-guide">
    For the instance operator: invites, backups, migrations, upgrades
  </Card>
</CardGroup>
