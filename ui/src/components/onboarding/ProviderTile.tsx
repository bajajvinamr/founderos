/**
 * S7.C.1 — Single tile in the provider chooser grid.
 *
 * Renders one provider option as a card with logo / name / one-line
 * description / status badge. Two states:
 *   - live  : interactive button, calls onSelect when clicked.
 *   - coming-soon : 55% opacity, aria-disabled, tabIndex=-1, no-op click,
 *                   tooltip on hover/focus surfaces the unlock-phase ETA
 *                   (e.g. "S7.B.2").
 *
 * The drawer / inline key entry is owned by S7.C.2 — this component only
 * deals with selection. Telemetry events are S7.C.4.
 *
 * BL-003 (P2.b, founder-language sweep) — when `option.displayKey` is
 * set the rendered label flips between founder voice ("Claude (pay-per-
 * use)") and engineer voice ("Anthropic API") based on `founderos.viewMode`.
 * Engineer mode falls back to `option.label` so technical strings still
 * surface for power users. The brand logo is injected via the `icon`
 * prop from the chooser registry.
 */

import type { ComponentType, KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { useDisplay } from "@/lib/use-display";
import type { ProviderOption } from "./ProviderChooser.js";

interface Props {
  option: ProviderOption;
  selected: boolean;
  onSelect: (option: ProviderOption) => void;
  /**
   * Optional icon. Defaults to a generic terminal/key glyph injected by
   * the chooser when the option-registry entry doesn't carry one.
   */
  icon?: ComponentType<{ className?: string }>;
}

export function ProviderTile({ option, selected, onSelect, icon: Icon }: Props) {
  const isLive = option.status === "live";
  const isComingSoon = option.status === "coming-soon";

  // BL-003 (P2.b) — resolve user-facing label from the DisplayDictionary
  // when this tile carries a `displayKey`. Founder mode shows "Claude
  // (pay-per-use)" style copy, engineer mode shows the technical name.
  // Hooks must run unconditionally; we always call `useDisplay` with a
  // safe fallback key and then pick between dictionary text and the
  // engineer-canonical `option.label`.
  const dictionaryLabel = useDisplay(option.displayKey ?? "providers");
  const label = option.displayKey ? dictionaryLabel : option.label;

  // Tooltip text — disabled tiles surface a hover/focus message tied to
  // the engineering-ticket ETA. Live tiles have no tooltip (the badge
  // copy already states the auth mode).
  const tooltip = isComingSoon
    ? `${label} support ships in ${option.etaPhase}`
    : undefined;

  function handleClick() {
    if (!isLive) return;
    onSelect(option);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!isLive) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(option);
    }
  }

  return (
    <button
      type="button"
      role="button"
      aria-disabled={isComingSoon ? "true" : undefined}
      aria-pressed={isLive ? selected : undefined}
      tabIndex={isComingSoon ? -1 : 0}
      title={tooltip}
      data-testid={`provider-tile-${option.id}`}
      data-status={option.status}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        "relative w-full text-left rounded-md border px-4 py-3 transition-colors",
        "min-h-[88px] flex flex-col gap-1.5",
        // Live + selected
        isLive && selected && "border-foreground bg-accent",
        // Live + not selected
        isLive && !selected && "border-border hover:bg-accent/40 cursor-pointer",
        // Coming Soon — 55% opacity, default cursor, no hover
        isComingSoon && "border-border opacity-[0.55] cursor-default",
      )}
    >
      <div className="flex items-start gap-2.5">
        {Icon ? (
          <Icon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
        ) : null}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-sm font-medium leading-tight">{label}</p>
            <Badge option={option} />
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-snug">
            {option.description}
          </p>
          <p
            className="text-[11px] text-muted-foreground/80 mt-1.5 leading-snug italic"
            data-testid={`provider-requirement-${option.id}`}
          >
            {option.requirement}
          </p>
        </div>
      </div>
    </button>
  );
}

function Badge({ option }: { option: ProviderOption }) {
  if (option.status === "coming-soon") {
    return (
      <span
        className={cn(
          "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
          "bg-muted text-muted-foreground",
        )}
        data-testid="provider-badge-coming-soon"
      >
        Coming Soon · {option.etaPhase}
      </span>
    );
  }
  if (option.authMode === "subscription") {
    return (
      <span
        className={cn(
          "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
          "bg-teal-500/15 text-teal-700 dark:text-teal-300",
        )}
        data-testid="provider-badge-subscription"
      >
        Subscription
      </span>
    );
  }
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
        "bg-amber-500/15 text-amber-700 dark:text-amber-300",
      )}
      data-testid="provider-badge-api-key"
    >
      API Key
    </span>
  );
}
