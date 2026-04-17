<div align="center">
  <img src="docs/images/logo-light.svg#gh-light-mode-only" alt="FounderOS" height="32" />
  <img src="docs/images/logo-dark.svg#gh-dark-mode-only" alt="FounderOS" height="32" />
</div>

<p align="center">
  <em>The AI company OS for solo founders.</em>
</p>

<p align="center">
  <a href="#quickstart"><strong>Quickstart</strong></a> &middot;
  <a href="#what-is-founderos"><strong>What is FounderOS</strong></a> &middot;
  <a href="./NOTICE.md"><strong>Attribution</strong></a>
</p>

---

## What is FounderOS

FounderOS is an opinionated, hosted AI company operating system for solo founders and small teams. Run a company with 50 AI agents, governed budgets, and pre-built department templates — from a single dashboard.

Under the hood it's an agent orchestration engine (forked from the MIT-licensed [Paperclip](https://github.com/paperclipai/paperclip) project — see [`NOTICE.md`](./NOTICE.md)). What FounderOS adds on top:

- **Ready-made departments** — Chief of Staff, Growth, Content, Finance, and more, each shipped with a tuned agent roster, skills, and org chart.
- **Guided onboarding** — pick a template, plug in your Anthropic key, and your company is running in under ten minutes.
- **Company Pulse** — live MRR, signups, and spend on your dashboard via native Stripe integration.
- **BYO-key billing** — you bring your own Anthropic (or other model) key; we bill for hosting, templates, and the managed experience.
- **Single-tenant isolation** — every customer gets a dedicated instance, so no one else's agent can touch your data or your budget.

## Who it's for

Solo founders, indie operators, and lean teams who want the leverage of 50 agents without the infrastructure work of wiring them together. If you've tried to rig up "LangChain + a spreadsheet + cron" to run your company, this is the commercial version of that.

## Quickstart

```bash
pnpm install
pnpm dev
```

Then open <http://localhost:3000> and step through the onboarding wizard.

Full setup docs (deployment, BYO-key flow, Stripe integration, agent templates) live in [`docs/`](./docs/).

## Tech stack

- **Engine:** Node.js + TypeScript, pnpm workspaces
- **Frontend:** React + Vite + TailwindCSS + shadcn/ui
- **Database:** Postgres via Drizzle
- **Agents:** provider-agnostic — Claude, Codex, Cursor, OpenClaw, or your own

## Contributing

FounderOS is open source under MIT. Upstream engine improvements flow from and to Paperclip where applicable. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

MIT. See [`LICENSE`](./LICENSE) for the full text and [`NOTICE.md`](./NOTICE.md) for attribution to Paperclip, the original upstream project.
