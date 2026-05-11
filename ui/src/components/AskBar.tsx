import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Search, Loader2 } from "lucide-react";
import { cn } from "../lib/utils";
import { AskBarSuggestionList } from "./AskBarSuggestionList";
import {
  flattenGroups,
  type AskSuggestion,
  type AskSuggestionGroup,
} from "../hooks/useAskSuggestions";

/**
 * AskBar — the keystone component of the new shell.
 *
 * Owns:
 *   - Cmd+K global listener (replaces CommandPalette; that component is
 *     left in the codebase for now to keep this PR scope tight, but its
 *     Cmd+K handler is dominated by AskBar's listener — registered first
 *     in the effect order, calls e.preventDefault).
 *   - Esc / outside-click dismiss with TYPED QUERY PRESERVED (F-06).
 *   - WAI-ARIA combobox attributes + listbox child.
 *   - Submit semantics (red-team F-01 BLOCK):
 *       Enter → activate highlighted suggestion, NEVER auto-create issue
 *       Cmd+Enter → always submit as "Ask the team this" (advanced escape hatch)
 *       Enter with no matches → no-op (renders "Nothing matches" copy)
 *
 * Out of scope for this component:
 *   - Server-backed search (Wave 2-3 will replace the in-memory rank with
 *     an API call; the suggestion-list API surface is stable).
 *   - Mobile full-screen sheet variant (handled via `variant="compact"`).
 */

interface AskBarProps {
  placeholder?: string;
  /**
   * Compact variant (mobile sticky-top). Default variant (desktop chrome
   * header) shows the kbd hint and uses a 560px-wide dropdown.
   */
  variant?: "default" | "compact";
  /** Whether the ⌘K kbd badge renders inside the input. Default true. */
  showShortcutHint?: boolean;
  /**
   * Suggestion groups produced by `useAskSuggestions(...)`. The parent
   * owns the query state to support cross-page persistence.
   */
  groups: AskSuggestionGroup[];
  /** Controlled value. Preserved across Esc / outside-click per F-06. */
  value: string;
  /** Fired on every keystroke. */
  onChange: (next: string) => void;
  /** Fired when a non-ask suggestion is selected. */
  onSelectSuggestion: (suggestion: AskSuggestion) => void;
  /** Fired when the founder submits an ad-hoc ask (Cmd+Enter or sticky-foot click). */
  onAskTeam: (sentence: string) => void;
}

const ASK_TEAM_ROW_ID = "askbar-ask-team-row";

export function AskBar({
  placeholder = "Ask the team or jump to…",
  variant = "default",
  showShortcutHint = true,
  groups,
  value,
  onChange,
  onSelectSuggestion,
  onAskTeam,
}: AskBarProps) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const trimmedQuery = value.trim();
  const flatRows = useMemo(() => flattenGroups(groups), [groups]);

  // Order of focus targets when arrow-keying through the dropdown:
  //   1. All non-ask rows in flat order (flatRows)
  //   2. The sticky-foot "Ask the team this" row (only when query is non-empty)
  // First row in `flatRows` is the default-highlighted target — Enter resolves
  // to navigation (F-01); the sticky-foot row is reachable only by clicking
  // it, arrow-down past the last group, or Cmd+Enter.
  const focusableIds = useMemo<string[]>(() => {
    const ids = flatRows.map((row) => row.domId);
    if (trimmedQuery.length > 0) ids.push(ASK_TEAM_ROW_ID);
    return ids;
  }, [flatRows, trimmedQuery]);

  // Reset highlight whenever groups change. First focusable row wins.
  // When the query is empty we leave nothing highlighted (so Enter is
  // a no-op — F-01 keystone).
  useEffect(() => {
    if (!open) {
      setActiveId(null);
      return;
    }
    if (trimmedQuery.length === 0) {
      setActiveId(null);
      return;
    }
    const nextId = focusableIds[0] ?? null;
    setActiveId(nextId === ASK_TEAM_ROW_ID ? null : nextId);
  }, [open, trimmedQuery, focusableIds]);

  // Global ⌘K / Ctrl+K listener — opens the bar and focuses input.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(true);
        // Focus is requested synchronously — Apple Spotlight pattern. The
        // dropdown animation does NOT gate input (F-07).
        inputRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Outside-click dismiss. Typed query is preserved per F-06.
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const submitAsk = useCallback(() => {
    const sentence = value.trim();
    if (sentence.length === 0) return;
    onAskTeam(sentence);
    setOpen(false);
  }, [value, onAskTeam]);

  const selectSuggestion = useCallback(
    (suggestion: AskSuggestion) => {
      onSelectSuggestion(suggestion);
      setOpen(false);
    },
    [onSelectSuggestion],
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      // Esc — close dropdown, PRESERVE typed query (F-06).
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        inputRef.current?.blur();
        return;
      }

      // Cmd/Ctrl + Enter — ALWAYS submit as "Ask the team this" (F-01).
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submitAsk();
        return;
      }

      // Plain Enter — activate highlighted suggestion. If no highlight,
      // this is a no-op (the keystone regression test — F-01).
      if (e.key === "Enter") {
        e.preventDefault();
        if (!activeId) return; // F-01: no auto-submit on no-match
        if (activeId === ASK_TEAM_ROW_ID) {
          submitAsk();
          return;
        }
        const match = flatRows.find((row) => row.domId === activeId);
        if (match) {
          selectSuggestion(match);
        }
        return;
      }

      // Arrow navigation.
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (focusableIds.length === 0) return;
        const idx = activeId ? focusableIds.indexOf(activeId) : -1;
        const nextIdx = (idx + 1) % focusableIds.length;
        const next = focusableIds[nextIdx];
        if (next) setActiveId(next);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (focusableIds.length === 0) return;
        const idx = activeId ? focusableIds.indexOf(activeId) : 0;
        const nextIdx = (idx - 1 + focusableIds.length) % focusableIds.length;
        const next = focusableIds[nextIdx];
        if (next) setActiveId(next);
        return;
      }
    },
    [activeId, flatRows, focusableIds, selectSuggestion, submitAsk],
  );

  const isCompact = variant === "compact";

  return (
    <div
      ref={wrapperRef}
      className={cn(
        "relative",
        isCompact ? "w-full" : "w-full max-w-[560px]",
      )}
    >
      <div
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-owns="askbar-listbox"
        aria-controls="askbar-listbox"
        className={cn(
          "relative flex items-center gap-2 rounded-md border border-border bg-muted/40 transition-colors",
          isCompact ? "h-11 px-3" : "h-9 px-3",
          "focus-within:bg-background focus-within:ring-[3px] focus-within:ring-ring/40",
        )}
      >
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          role="searchbox"
          aria-autocomplete="list"
          aria-controls="askbar-listbox"
          aria-activedescendant={activeId ?? undefined}
          aria-label="Ask the team or jump to a page"
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            onChange(e.currentTarget.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {showShortcutHint && !isCompact && !open && (
          <kbd className="ml-2 rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            ⌘K
          </kbd>
        )}
        {open && (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground/0" aria-hidden="true" />
        )}
      </div>
      {open && (
        <div
          className={cn(
            "absolute left-0 right-0 z-50 mt-1.5 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg",
            isCompact ? "w-full" : "w-[560px]",
          )}
        >
          <div
            aria-live="polite"
            className="sr-only"
          >
            {focusableIds.length} suggestions available.
          </div>
          <AskBarSuggestionList
            groups={groups}
            activeId={activeId}
            query={value}
            askTeamRowId={ASK_TEAM_ROW_ID}
            onSelect={selectSuggestion}
            onAskTeam={submitAsk}
            onHoverRow={setActiveId}
          />
        </div>
      )}
    </div>
  );
}

/** Exported for tests so the sticky-foot row id is referenceable. */
export const ASK_BAR_ASK_TEAM_ROW_ID = ASK_TEAM_ROW_ID;
