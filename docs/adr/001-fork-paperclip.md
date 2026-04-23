# ADR-001 — Fork Paperclip as the base, rebrand as FounderOS

## Status

Accepted (2026-04-21)

## Context

A buyer has offered $4k for a white-label AI company OS built in two weeks. Building the primitives from scratch (agent runtime, heartbeat scheduler, multi-provider adapters, template spawning, issues/goals/org chart) would eat the full timeline with zero time left for the surfaces that justify the price. Paperclip is MIT-licensed, 53k stars, and already solves roughly 70% of the plumbing we need.

## Decision

Fork Paperclip, rebrand as FounderOS, and spend the timeline building the opinionated surfaces on top — Decision Inbox, Company Memory, Weekly Wrap, permission ladder, Composio integrations. Treat Paperclip as the agent runtime; FounderOS is the operating system above it.

## Consequences

- Week 1 ships real product instead of reinventing heartbeat loops.
- Upstream improvements (new agents, adapter fixes) merge in cleanly as long as we don't fork internal APIs we rely on.
- Every boundary we add on top of Paperclip is a merge-conflict surface later. Keep the delta thin where we can.
- Attribution obligations — MIT requires keeping the upstream copyright. Handled in `NOTICE.md`.
- Pitch risk: "you just forked an open-source project" is a fair question. Mitigation: the wrapper (departments, decisions, memory, governance) is the actual product, and that's not in Paperclip.

## Alternatives considered

- **Greenfield build from scratch** — honest engineering, and lets us pick our own abstractions. But blows the two-week deadline and the $4k deal goes away.
- **Wrap Lindy / Zapier as the runtime** — faster to start, zero flexibility on agent behavior, and we'd own none of the IP. Wrong side of the build/buy line for something we want to charge $299/mo for.
- **Fork another agent framework (CrewAI, AutoGen, LangGraph)** — smaller communities, less mature multi-provider support, and none have the agent library Paperclip ships with.
