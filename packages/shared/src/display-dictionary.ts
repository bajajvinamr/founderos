export type DisplayMode = 'founder' | 'engineer';

export interface DisplayLabel {
  founder: string;
  engineer: string;
}

export const DISPLAY_DICTIONARY = {
  // Concept renames (audit-verified engineer-jargon hot spots)
  issue:        { founder: "Task",            engineer: "Issue" },
  issues:       { founder: "Tasks",           engineer: "Issues" },
  adapter:      { founder: "AI Brain",        engineer: "Adapter" },
  run:          { founder: "Work shift",      engineer: "Run" },
  runs:         { founder: "Work shifts",     engineer: "Runs" },
  heartbeat:    { founder: "Check-in",        engineer: "Heartbeat" },
  workspace:    { founder: "Knowledge base",  engineer: "Workspace" },
  claim:        { founder: "Activate",        engineer: "Claim" },
  wakeup:       { founder: "Start work",      engineer: "Wakeup" },
  routine:      { founder: "Schedule",        engineer: "Routine" },
  routines:     { founder: "Schedules",       engineer: "Routines" },
  audit:        { founder: "History",         engineer: "Audit log" },
  byo_runner:   { founder: "Run on my computer", engineer: "BYO Runner" },

  // Provider canonical labels (the most important block)
  anthropic_api: { founder: "Claude (pay-per-use)",   engineer: "Anthropic API" },
  claude_local:  { founder: "Claude (subscription)",  engineer: "Claude Code CLI" },
  openai_api:    { founder: "ChatGPT (pay-per-use)",  engineer: "OpenAI API" },
  codex_local:   { founder: "ChatGPT (subscription)", engineer: "Codex CLI" },
  gemini_api:    { founder: "Gemini (pay-per-use)",   engineer: "Gemini API" },
  gemini_local:  { founder: "Gemini (subscription)",  engineer: "Gemini CLI" },

  // Action verbs / CTAs
  new_issue:     { founder: "Ask FounderOS",  engineer: "New Issue" },
  create_issue:  { founder: "Ask the team",   engineer: "Create Issue" },
  ask_action:    { founder: "What do you want done?", engineer: "Create new issue" },

  // Section headers
  agents:        { founder: "Your team",      engineer: "Agents" },
  integrations:  { founder: "Connections",    engineer: "Integrations" },
  providers:     { founder: "AI services",    engineer: "Providers" },
  decisions:     { founder: "Decisions",      engineer: "Decisions" },
  inbox:         { founder: "Inbox",          engineer: "Inbox" },

  // Onboarding — Step 4 (BL-002, P2.a founder-language sweep)
  "onboarding.step4.headline": {
    founder:  "How should FounderOS use AI?",
    engineer: "Adapter configuration",
  },
  "onboarding.step4.subtitle": {
    founder:  "Pick where the AI for your team should run",
    engineer: "Select adapter family + provider",
  },

  // Provider tile descriptions — BL-005 (P2.d founder-language sweep).
  // Engineer strings preserve the pre-BL-005 technical copy from
  // ProviderChooser.tsx so engineer mode keeps the prior description
  // surface verbatim. Founder strings explain what the founder is
  // bringing (subscription vs. pay-per-use, on laptop vs. cloud) in
  // plain language. Each founder string is ≤ 100 chars to fit the tile
  // layout in ProviderTile (`<p class="text-xs">{description}</p>`).
  "provider.claude_code.description": {
    founder:  "Use your existing Claude Code app — no extra cost beyond your Anthropic subscription.",
    engineer: "For developers — requires Claude Code CLI installed on your laptop.",
  },
  "provider.anthropic_api.description": {
    founder:  "Pay Anthropic directly for each agent call — runs in the cloud, no laptop required.",
    engineer: "Bring your own Anthropic API key for hosted deployments.",
  },
  "provider.gemini_cli.description": {
    founder:  "Use your Google AI subscription via Gemini CLI on your laptop.",
    engineer: "Use your Google AI subscription via the local CLI.",
  },
  "provider.google_api.description": {
    founder:  "Pay Google directly for each agent call — runs in the cloud, no laptop required.",
    engineer: "Bring your own Gemini API key for hosted deployments.",
  },
  "provider.codex_cli.description": {
    founder:  "Use your ChatGPT subscription via Codex CLI on your laptop.",
    engineer: "Use your OpenAI subscription via the local Codex CLI.",
  },
  "provider.openai_api.description": {
    founder:  "Pay OpenAI directly for each agent call — runs in the cloud, no laptop required.",
    engineer: "Bring your own OpenAI API key (GPT-4o / o3).",
  },
} as const;

export type DisplayKey = keyof typeof DISPLAY_DICTIONARY;

export function displayLabel(key: DisplayKey, mode: DisplayMode = 'founder'): string {
  return DISPLAY_DICTIONARY[key][mode];
}
