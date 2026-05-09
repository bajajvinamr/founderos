/**
 * S7.C.1 — Multi-provider chooser tile grid for the onboarding wizard.
 *
 * Renders six provider tiles (Claude Code, Anthropic API, Gemini CLI,
 * Google API, Codex CLI, OpenAI API) in a responsive grid:
 *   desktop (>= md):  3 columns × 2 rows
 *   tablet  (>= sm):  2 columns × 3 rows
 *   mobile  (<  sm):  1 column  × 6 rows
 *
 * Two tiles are LIVE at S7.0 ship; four are COMING SOON with `S7.B.x`
 * ETAs surfaced via tooltip on hover/focus. Coming-soon tiles are
 * `aria-disabled="true"` and `tabIndex={-1}` so keyboard nav skips them.
 *
 * Out of scope for this ticket:
 *   - Inline key-entry drawer (S7.C.2 owns ProviderKeyDrawer)
 *   - Telemetry events (S7.C.4 owns chooser_viewed / option_selected etc.)
 *   - Mobile touch tooltip dismissal (S7.C.5 polish)
 *   - Waitlist email capture for Coming Soon tiles (S7.C.6)
 *
 * The chooser is purely a selection surface here. The wizard owns
 * routing logic and downstream draft persistence.
 */

import { Cloud, Cpu, Key, Sparkles, Terminal, Zap } from "lucide-react";
import type { ComponentType } from "react";
import { ProviderTile } from "./ProviderTile.js";

export type ProviderAdapterType =
  | "claude_local"
  | "gemini_local"
  | "codex_local"
  | "openai_api";

export type ProviderAuthMode = "subscription" | "api_key";

export type ProviderStatus = "live" | "coming-soon";

export interface ProviderOption {
  /** Stable id used in tests, telemetry, and the draft row. */
  id: string;
  /** User-facing display name on the tile. */
  label: string;
  /** One-line description, ~6-12 words. */
  description: string;
  /**
   * Plain-English "what this requires" line shown under the description.
   * Tells the founder up-front what they need (CLI / key / signup) so the
   * choice is honest before they pick — surfaces audit P0.4. Roughly 8-16
   * words; never empty.
   */
  requirement: string;
  status: ProviderStatus;
  /** Engineering-ticket reference (e.g., "S7.B.2") — only set when coming-soon. */
  etaPhase?: string;
  /** Internal adapter enum (4 values, NOT 6 — see PRD §1). */
  adapterType: ProviderAdapterType;
  /** Auth mode flag — separate from adapterType because two tiles share an adapter. */
  authMode: ProviderAuthMode;
}

/**
 * Registry order matches PRD §3.2 left-to-right, top-to-bottom on a
 * 3-column desktop grid. Live tiles are first so keyboard tab order
 * lands on the working options before any coming-soon tile.
 */
export const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    id: "claude_code",
    label: "Claude Code",
    description: "Use your existing Claude subscription via the local CLI.",
    requirement: "Requires Claude Code CLI installed on your laptop.",
    status: "live",
    adapterType: "claude_local",
    authMode: "subscription",
  },
  {
    id: "anthropic_api",
    label: "Anthropic API",
    description: "Bring your own Anthropic API key for hosted deployments.",
    requirement:
      "Requires an Anthropic API key (get one at console.anthropic.com).",
    status: "live",
    adapterType: "claude_local",
    authMode: "api_key",
  },
  {
    id: "gemini_cli",
    label: "Gemini CLI",
    description: "Use your Google AI subscription via the local CLI.",
    requirement: "Requires Google AI Studio account and Gemini CLI on your laptop.",
    status: "coming-soon",
    etaPhase: "S7.B.2",
    adapterType: "gemini_local",
    authMode: "subscription",
  },
  {
    id: "google_api",
    label: "Google API",
    description: "Bring your own Google AI API key for hosted deployments.",
    requirement: "Requires a Google AI API key (aistudio.google.com/apikey).",
    status: "coming-soon",
    etaPhase: "S7.B.2",
    adapterType: "gemini_local",
    authMode: "api_key",
  },
  {
    id: "codex_cli",
    label: "Codex CLI",
    description: "Use your OpenAI subscription via the local Codex CLI.",
    requirement: "Requires GitHub Codex CLI installed on your laptop.",
    status: "coming-soon",
    etaPhase: "S7.B.1",
    adapterType: "codex_local",
    authMode: "subscription",
  },
  {
    id: "openai_api",
    label: "OpenAI API",
    description: "Bring your own OpenAI API key (GPT-4o / o3).",
    requirement: "Requires an OpenAI API key (platform.openai.com/api-keys).",
    status: "coming-soon",
    etaPhase: "S7.B.4",
    adapterType: "openai_api",
    authMode: "api_key",
  },
];

/** Per-tile glyph. Cosmetic only — registry order is the contract. */
const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  claude_code: Terminal,
  anthropic_api: Key,
  gemini_cli: Sparkles,
  google_api: Cloud,
  codex_cli: Cpu,
  openai_api: Zap,
};

interface Props {
  /** Currently-selected option id, or null if no selection yet. */
  selectedId: string | null;
  /** Fires when the founder selects a live tile. Coming-soon tiles never fire. */
  onSelect: (option: ProviderOption) => void;
}

export function ProviderChooser({ selectedId, onSelect }: Props) {
  function handleSelect(option: ProviderOption) {
    // TODO(S7.C.4): fire chooser_viewed/option_selected events here
    onSelect(option);
  }

  return (
    <div className="space-y-3" data-testid="provider-chooser">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">
          Pick your AI provider
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Two providers run agents today (Claude Code + Anthropic API). The
          other four are coming soon — they're shown so you can plan, but
          they can't be selected yet. Each tile lists exactly what it
          requires.
        </p>
      </div>

      <div
        role="radiogroup"
        aria-label="AI provider"
        className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3"
      >
        {PROVIDER_OPTIONS.map((option) => (
          <ProviderTile
            key={option.id}
            option={option}
            selected={selectedId === option.id}
            onSelect={handleSelect}
            icon={ICONS[option.id]}
          />
        ))}
      </div>
    </div>
  );
}
