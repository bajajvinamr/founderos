import { ChevronRight, Bot, FileText, Clock, Sparkles } from "lucide-react";
import { cn } from "../lib/utils";
import type {
  AskAgentSuggestion,
  AskSuggestion,
  AskSuggestionGroup,
} from "../hooks/useAskSuggestions";

interface AskBarSuggestionListProps {
  /** Grouped, ranked suggestions to render (commands / agents / pages / recent). */
  groups: AskSuggestionGroup[];
  /** Currently highlighted row's DOM id, or null for the sticky-foot row. */
  activeId: string | null;
  /** Trimmed typed query; non-empty enables the sticky-foot "Ask the team" row. */
  query: string;
  /** Stable DOM id used by the sticky-foot row for aria-activedescendant. */
  askTeamRowId: string;
  /** Fired when a non-ask row is selected (click or Enter). */
  onSelect: (suggestion: AskSuggestion) => void;
  /** Fired when the sticky-foot row is selected (click). */
  onAskTeam: () => void;
  /** Fired on hover to keep the activeId in sync with mouse position. */
  onHoverRow: (id: string | null) => void;
}

/**
 * AskBar suggestion list — rendered inside the dropdown / mobile sheet.
 *
 * Layout per `01-shell-revised.md §6.3`:
 *   - Group headers in uppercase
 *   - Rows are clickable with hover highlight
 *   - Sticky-foot row "Ask the team this →" lives at the bottom and is
 *     visually distinct (different bg tint); it is NEVER default-highlighted
 *     and is only reachable via click, arrow-down past the last group, or
 *     Cmd+Enter (F-01 BLOCK regression-test target).
 */
export function AskBarSuggestionList({
  groups,
  activeId,
  query,
  askTeamRowId,
  onSelect,
  onAskTeam,
  onHoverRow,
}: AskBarSuggestionListProps) {
  const trimmedQuery = query.trim();
  const hasGroups = groups.length > 0;
  const showAskTeamRow = trimmedQuery.length > 0;
  const showEmpty = !hasGroups && trimmedQuery.length > 0;

  return (
    <ul
      id="askbar-listbox"
      role="listbox"
      aria-label="Suggestions"
      className="max-h-[480px] overflow-y-auto py-1"
    >
      {groups.map((group) => {
        // ARIA: `role="listbox"` requires `option` (or `optgroup`) direct
        // children. `role="group"` is NOT a valid listbox child — assistive
        // tech will either ignore the grouping or miscount options. The
        // wrapping <li> is therefore `role="presentation"` (layout-only),
        // the section heading is a visually-hidden label, and the option
        // rows are emitted at the top level of the listbox tree below
        // (the inner <ul> wrapper is also presentation-only so the
        // structural <li role="option"> rows remain valid listbox children).
        const headerId = `askbar-group-${group.kind}-label`;
        return (
          <li
            key={group.kind}
            role="presentation"
            className="py-1"
          >
            <div
              id={headerId}
              className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              {group.label}
            </div>
            <span className="sr-only" id={`${headerId}-sr`}>
              Section: {group.label}, {group.items.length} option
              {group.items.length === 1 ? "" : "s"}
            </span>
            <ul role="presentation" className="flex flex-col">
              {group.items.map((item) => (
                <SuggestionRow
                  key={item.id}
                  item={item}
                  active={activeId === item.domId}
                  onSelect={() => onSelect(item)}
                  onHover={() => onHoverRow(item.domId)}
                  onLeave={() => onHoverRow(null)}
                />
              ))}
            </ul>
          </li>
        );
      })}
      {showEmpty && (
        <li className="px-3 py-3 text-sm italic text-muted-foreground">
          Nothing matches. <kbd className="rounded border border-border bg-muted px-1 py-0.5 text-[10px]">⌘↵</kbd> to ask the team this.
        </li>
      )}
      {showAskTeamRow && (
        <li
          id={askTeamRowId}
          role="option"
          aria-selected={activeId === askTeamRowId}
          aria-label="Ask the team this question"
          className={cn(
            "sticky bottom-0 flex cursor-pointer items-center gap-3 border-t border-border bg-muted/40 px-3 py-2.5 text-sm transition-colors hover:bg-muted/60",
            activeId === askTeamRowId && "bg-muted/60",
          )}
          onMouseEnter={() => onHoverRow(askTeamRowId)}
          onMouseLeave={() => onHoverRow(null)}
          onClick={onAskTeam}
        >
          <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Ask the team this
            </div>
            <div className="truncate text-sm text-foreground">"{trimmedQuery}"</div>
          </div>
          <kbd className="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            ⌘↵
          </kbd>
        </li>
      )}
    </ul>
  );
}

interface SuggestionRowProps {
  item: AskSuggestion;
  active: boolean;
  onSelect: () => void;
  onHover: () => void;
  onLeave: () => void;
}

function SuggestionRow({ item, active, onSelect, onHover, onLeave }: SuggestionRowProps) {
  const Icon = iconForKind(item);
  return (
    <li
      id={item.domId}
      role="option"
      aria-selected={active}
      className={cn(
        "flex cursor-pointer items-center gap-3 px-3 py-2 text-sm transition-colors",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onClick={onSelect}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{item.label}</div>
        {item.subtitle && (
          <div className="truncate text-xs text-muted-foreground">{item.subtitle}</div>
        )}
      </div>
      {item.shortcut && (
        <kbd className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {item.shortcut}
        </kbd>
      )}
      {item.kind === "page" && (
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden="true" />
      )}
    </li>
  );
}

function iconForKind(item: AskSuggestion) {
  if (item.kind === "agent") return agentStatusIcon(item);
  if (item.kind === "recent") return Clock;
  if (item.kind === "page") return FileText;
  return Sparkles;
}

function agentStatusIcon(_item: AskAgentSuggestion) {
  return Bot;
}
