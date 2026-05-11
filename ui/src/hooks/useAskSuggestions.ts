import { useMemo } from "react";

/**
 * AskBar suggestion model — 4 groups + 1 sticky-foot row.
 *
 * Per `docs/design/founderos-frontend-plan/01-shell-revised.md §6.3`:
 *   1. Commands (verbs that map to existing UI affordances)
 *   2. Agents (named with live status)
 *   3. Pages (sidebar sections + their second-level children)
 *   4. Recent (last viewed entities)
 *
 *   + sticky-foot row "Ask the team this →" (NEVER default-highlighted —
 *     red-team F-01 BLOCK; reached only by click or Cmd+Enter)
 *
 * Ranking (F-08): label-prefix > label-substring > content-fuzzy >
 * recency tiebreaker. Within each group.
 */

export type AskSuggestionKind = "command" | "agent" | "page" | "recent";

export interface AskSuggestionBase {
  /** Stable DOM id (used for aria-activedescendant). */
  domId: string;
  /** Stable canonical id (used for keying + onSelect). */
  id: string;
  /** Sentence-case, founder-language label. */
  label: string;
  /** Optional one-line subtitle. */
  subtitle?: string;
  /** Optional kbd hint (e.g., `C` for new issue). */
  shortcut?: string;
}

export interface AskCommandSuggestion extends AskSuggestionBase {
  kind: "command";
  /** Fired when the row is selected. */
  onSelect: () => void;
}

export interface AskAgentSuggestion extends AskSuggestionBase {
  kind: "agent";
  status: "running" | "active" | "idle" | "paused" | "error";
  /** Navigation target (agent detail). */
  to: string;
}

export interface AskPageSuggestion extends AskSuggestionBase {
  kind: "page";
  /** Navigation target. */
  to: string;
}

export interface AskRecentSuggestion extends AskSuggestionBase {
  kind: "recent";
  /** Navigation target. */
  to: string;
}

export type AskSuggestion =
  | AskCommandSuggestion
  | AskAgentSuggestion
  | AskPageSuggestion
  | AskRecentSuggestion;

export interface AskSuggestionGroup {
  kind: AskSuggestionKind;
  label: string;
  items: AskSuggestion[];
}

/** Inputs to the hook. Kept loose so callers can pass partial data. */
export interface UseAskSuggestionsInput {
  query: string;
  commands: AskCommandSuggestion[];
  agents: AskAgentSuggestion[];
  pages: AskPageSuggestion[];
  recent: AskRecentSuggestion[];
}

const PER_GROUP_LIMIT = 5;

/**
 * Rank score for a single row given a typed query. Lower is better.
 * (We sort ascending — index 0 ranks first.)
 *
 * Encoded ranks (F-08):
 *   0 — label-prefix match (case-insensitive)
 *   1 — label-substring match
 *   2 — subtitle-substring match (fuzzy content)
 *   3 — no textual match (kept as recent / no-query default)
 */
function scoreRow(row: AskSuggestion, q: string): number {
  if (!q) return 3;
  const lq = q.toLowerCase();
  const label = row.label.toLowerCase();
  if (label.startsWith(lq)) return 0;
  if (label.includes(lq)) return 1;
  const subtitle = row.subtitle?.toLowerCase();
  if (subtitle && subtitle.includes(lq)) return 2;
  return 4; // does not match — filtered out below
}

function filterAndRank<T extends AskSuggestion>(items: T[], q: string): T[] {
  if (!q) return items.slice(0, PER_GROUP_LIMIT);
  const scored = items
    .map((row) => ({ row, score: scoreRow(row, q) }))
    .filter(({ score }) => score < 4);
  // Stable sort: rely on Array.prototype.sort which is stable in
  // modern V8 (Node 12+, all evergreen browsers). Original order is
  // the recency tiebreaker per F-08.
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, PER_GROUP_LIMIT).map(({ row }) => row);
}

/**
 * Build ranked, grouped suggestion list from raw inputs.
 *
 * Returns groups in fixed order (commands → agents → pages → recent).
 * Empty groups are omitted from the result. Caller renders the
 * sticky-foot "Ask the team this →" row separately.
 */
export function useAskSuggestions(input: UseAskSuggestionsInput): AskSuggestionGroup[] {
  const { query, commands, agents, pages, recent } = input;

  return useMemo(() => {
    const q = query.trim();

    const rankedCommands = filterAndRank(commands, q);
    const rankedAgents = filterAndRank(agents, q);
    const rankedPages = filterAndRank(pages, q);
    // Recent is shown only when there's no query — F-08 keeps the
    // history visible on empty input. With a query, recent items
    // that don't match are filtered out.
    const rankedRecent = filterAndRank(recent, q);

    const groups: AskSuggestionGroup[] = [];
    if (rankedCommands.length > 0) {
      groups.push({ kind: "command", label: "Commands", items: rankedCommands });
    }
    if (rankedAgents.length > 0) {
      groups.push({ kind: "agent", label: "Agents", items: rankedAgents });
    }
    if (rankedPages.length > 0) {
      groups.push({ kind: "page", label: "Pages", items: rankedPages });
    }
    if (rankedRecent.length > 0) {
      groups.push({ kind: "recent", label: "Recent", items: rankedRecent });
    }

    return groups;
  }, [query, commands, agents, pages, recent]);
}

/**
 * Flatten grouped suggestions into a single ordered array — used for
 * arrow-key navigation (down/up moves through the flat list).
 *
 * The sticky-foot "Ask the team this" row is NOT part of this flat
 * list — the AskBar renders it separately with its own id and adds
 * it to the activeId rotation as the LAST reachable row (so plain
 * Enter on a typed query never lands on it by default — F-01).
 */
export function flattenGroups(groups: AskSuggestionGroup[]): AskSuggestion[] {
  return groups.flatMap((g) => g.items);
}
