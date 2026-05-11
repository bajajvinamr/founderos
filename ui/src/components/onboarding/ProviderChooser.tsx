/**
 * S7.C.1 — Multi-provider chooser tile grid for the onboarding wizard.
 *
 * Renders six provider tiles (Claude Code, Anthropic API, Gemini CLI,
 * Gemini API, Codex CLI, OpenAI API) in a responsive grid:
 *   desktop (>= md):  3 columns × 2 rows
 *   tablet  (>= sm):  2 columns × 3 rows
 *   mobile  (<  sm):  1 column  × 6 rows
 *
 * All six tiles are LIVE and selectable. The chooser is purely a selection
 * surface; the wizard owns routing logic and downstream draft persistence.
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

import type { DisplayKey } from "@founderos/shared";
import type { ComponentType } from "react";
import { PROVIDER_BRAND_LOGOS } from "./brand-logos.js";
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
  /**
   * User-facing display name on the tile.
   *
   * BL-003 (P2.b) — this is now the ENGINEER-mode fallback only. When
   * `displayKey` is set, the tile reads the active label from
   * `DisplayDictionary` based on `founderos.viewMode`. `label` is still
   * the canonical engineer string so a missing dictionary entry or a
   * `viewMode === "engineer"` setting always produces the technical
   * name even without the lookup.
   */
  label: string;
  /**
   * Optional DisplayDictionary key for this provider's tile label.
   * BL-003 (P2.b) — when set, ProviderTile resolves the user-facing
   * label via `useDisplay(displayKey)` and falls back to `label` if
   * the dictionary entry is missing. Engineer viewMode renders the
   * engineer side of the dictionary entry which equals `label` by
   * convention, so engineer-mode founders still see "Anthropic API"
   * etc. — satisfying BL-003 done_criteria #2.
   */
  displayKey?: DisplayKey;
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
  /** Engineering-ticket reference (e.g., "S7.B.2") — only set when coming-soon. Removed in Phase D. */
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
    // Engineer fallback / canonical technical name. Founder copy
    // ("Claude (subscription)") comes from DisplayDictionary key
    // `claude_local` via `displayKey` below.
    label: "Claude Code",
    displayKey: "claude_local",
    description:
      "For developers — requires Claude Code CLI installed on your laptop.",
    requirement: "Requires Claude Code CLI installed on your laptop.",
    status: "live",
    adapterType: "claude_local",
    authMode: "subscription",
  },
  {
    id: "anthropic_api",
    label: "Anthropic API",
    displayKey: "anthropic_api",
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
    displayKey: "gemini_local",
    description: "Use your Google AI subscription via the local CLI.",
    requirement: "Requires Google AI Studio account and Gemini CLI on your laptop.",
    status: "live",
    adapterType: "gemini_local",
    authMode: "subscription",
  },
  {
    id: "google_api",
    label: "Gemini API",
    displayKey: "gemini_api",
    description: "Bring your own Gemini API key for hosted deployments.",
    requirement: "Requires a Gemini API key (aistudio.google.com/apikey).",
    status: "live",
    adapterType: "gemini_local",
    authMode: "api_key",
  },
  {
    id: "codex_cli",
    label: "Codex CLI",
    displayKey: "codex_local",
    description: "Use your OpenAI subscription via the local Codex CLI.",
    requirement: "Requires GitHub Codex CLI installed on your laptop.",
    status: "live",
    adapterType: "codex_local",
    authMode: "subscription",
  },
  {
    id: "openai_api",
    label: "OpenAI API",
    displayKey: "openai_api",
    description: "Bring your own OpenAI API key (GPT-4o / o3).",
    requirement: "Requires an OpenAI API key (platform.openai.com/api-keys).",
    status: "live",
    adapterType: "openai_api",
    authMode: "api_key",
  },
];

/**
 * Per-tile glyph. BL-003 (P2.b) — replaces the prior lucide icon set
 * with brand-family marks (Anthropic / OpenAI / Google) so the tiles
 * carry the brand the founder is actually choosing, not a generic
 * shape. Three logos cover all six tiles via the family map in
 * `brand-logos.tsx`.
 */
const ICONS: Record<string, ComponentType<{ className?: string }>> =
  PROVIDER_BRAND_LOGOS;

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
          Six AI providers are available: Claude Code, Anthropic API, Gemini CLI,
          Gemini API, Codex CLI, and OpenAI API. Each tile lists exactly what it
          requires so you can make an informed choice.
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
