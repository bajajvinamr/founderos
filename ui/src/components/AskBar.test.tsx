// @vitest-environment jsdom

/**
 * P3 Wave 1 — AskBar component tests.
 *
 * Source spec: 06-engineering-handoff.md §2.3 (Wave 1 test contract).
 *
 * Asserts the keystone regressions (red-team F-01 BLOCK):
 *   - Cmd+K opens the bar from anywhere
 *   - Esc dismisses + preserves typed query (F-06)
 *   - Enter on a navigation match routes (NEVER auto-creates an issue — F-01)
 *   - Enter on no-match is a no-op (NEVER auto-creates an issue — DoD #10)
 *   - Cmd+Enter forces "Ask the team" route (OQ-1 pre-fill IssueDialog)
 *   - Combobox ARIA attributes are present
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AskBar } from "./AskBar";
import type {
  AskCommandSuggestion,
  AskPageSuggestion,
  AskSuggestion,
  AskSuggestionGroup,
} from "../hooks/useAskSuggestions";

// React 19 act() environment hint.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

interface RenderHandle {
  container: HTMLElement;
  root: Root;
  input: HTMLInputElement;
}

interface RenderOpts {
  initialValue?: string;
  groups?: AskSuggestionGroup[];
  onAskTeam?: (sentence: string) => void;
  onSelectSuggestion?: (s: AskSuggestion) => void;
}

function buildPageGroup(items: AskPageSuggestion[]): AskSuggestionGroup {
  return { kind: "page", label: "Pages", items };
}

function buildCmdGroup(items: AskCommandSuggestion[]): AskSuggestionGroup {
  return { kind: "command", label: "Commands", items };
}

function renderAskBar(opts: RenderOpts = {}): RenderHandle {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  let currentValue = opts.initialValue ?? "";
  const groups = opts.groups ?? [];

  function renderWith(value: string, openGroups: AskSuggestionGroup[]) {
    root.render(
      <AskBar
        groups={openGroups}
        value={value}
        onChange={(next) => {
          currentValue = next;
          renderWith(next, openGroups);
        }}
        onSelectSuggestion={(s) => opts.onSelectSuggestion?.(s)}
        onAskTeam={(s) => opts.onAskTeam?.(s)}
      />,
    );
  }

  act(() => {
    renderWith(currentValue, groups);
  });

  const input = container.querySelector<HTMLInputElement>('input[role="searchbox"]');
  if (!input) throw new Error("AskBar input not rendered");
  return { container, root, input };
}

function pressGlobalKey(key: string, modifiers: { meta?: boolean; ctrl?: boolean } = {}) {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        metaKey: modifiers.meta ?? false,
        ctrlKey: modifiers.ctrl ?? false,
        bubbles: true,
      }),
    );
  });
}

function pressInputKey(
  input: HTMLInputElement,
  key: string,
  modifiers: { meta?: boolean; ctrl?: boolean } = {},
) {
  act(() => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        metaKey: modifiers.meta ?? false,
        ctrlKey: modifiers.ctrl ?? false,
        bubbles: true,
      }),
    );
  });
}

function typeIntoInput(input: HTMLInputElement, value: string) {
  act(() => {
    // Use the native HTMLInputElement value setter so React's
    // synthetic event handlers fire properly.
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    desc?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

let mounts: RenderHandle[] = [];

afterEach(() => {
  for (const mount of mounts) {
    act(() => {
      mount.root.unmount();
    });
    mount.container.remove();
  }
  mounts = [];
});

function mount(opts: RenderOpts = {}): RenderHandle {
  const handle = renderAskBar(opts);
  mounts.push(handle);
  return handle;
}

describe("AskBar — Wave 1 keystone tests", () => {
  it("opens on Cmd+K (focuses input)", () => {
    const handle = mount();
    expect(document.activeElement).not.toBe(handle.input);
    pressGlobalKey("k", { meta: true });
    expect(document.activeElement).toBe(handle.input);
    expect(handle.input.getAttribute("aria-controls")).toBe("askbar-listbox");
  });

  it("Esc dismisses dropdown but PRESERVES typed query (F-06)", () => {
    const handle = mount();
    pressGlobalKey("k", { meta: true });
    typeIntoInput(handle.input, "draft the weekly");
    expect(handle.input.value).toBe("draft the weekly");

    pressInputKey(handle.input, "Escape");
    // Dropdown closed, but the typed value persists in the input's
    // controlled value.
    expect(handle.input.value).toBe("draft the weekly");
  });

  it("Enter on a navigation match routes to the suggestion (red-team F-01 BLOCK)", () => {
    const pageGroup = buildPageGroup([
      { kind: "page", id: "page-team", domId: "askbar-page-team", label: "Team", to: "/team" },
    ]);
    const onSelectSuggestion = vi.fn();
    const onAskTeam = vi.fn();

    const handle = mount({
      groups: [pageGroup],
      onSelectSuggestion,
      onAskTeam,
    });
    pressGlobalKey("k", { meta: true });
    typeIntoInput(handle.input, "tea");
    pressInputKey(handle.input, "Enter");

    expect(onSelectSuggestion).toHaveBeenCalledTimes(1);
    expect(onSelectSuggestion.mock.calls[0]?.[0]?.kind).toBe("page");
    expect(onAskTeam).not.toHaveBeenCalled();
  });

  it("Enter with NO matching suggestions does NOT auto-create issue (DoD #10, F-01)", () => {
    const onSelectSuggestion = vi.fn();
    const onAskTeam = vi.fn();
    // Groups is empty → no rows, no highlight. Plain Enter must be a no-op.
    const handle = mount({
      groups: [],
      onSelectSuggestion,
      onAskTeam,
    });
    pressGlobalKey("k", { meta: true });
    typeIntoInput(handle.input, "abc123");
    pressInputKey(handle.input, "Enter");

    expect(onSelectSuggestion).not.toHaveBeenCalled();
    expect(onAskTeam).not.toHaveBeenCalled();
  });

  it("Cmd+Enter ALWAYS submits as Ask the team (OQ-1 pre-fill IssueDialog path)", () => {
    const pageGroup = buildPageGroup([
      { kind: "page", id: "page-team", domId: "askbar-page-team", label: "Team", to: "/team" },
    ]);
    const onSelectSuggestion = vi.fn();
    const onAskTeam = vi.fn();

    const handle = mount({
      groups: [pageGroup],
      onSelectSuggestion,
      onAskTeam,
    });
    pressGlobalKey("k", { meta: true });
    typeIntoInput(handle.input, "Find the churn risk");
    pressInputKey(handle.input, "Enter", { meta: true });

    expect(onAskTeam).toHaveBeenCalledTimes(1);
    expect(onAskTeam).toHaveBeenCalledWith("Find the churn risk");
    // Even though "Team" suggestion existed, Cmd+Enter forces the ask
    // route — the highlighted row is NOT activated as a navigation.
    expect(onSelectSuggestion).not.toHaveBeenCalled();
  });

  it("renders WAI-ARIA combobox attributes on the wrapper", () => {
    const handle = mount();
    const combobox = handle.container.querySelector<HTMLElement>('[role="combobox"]');
    expect(combobox).toBeTruthy();
    expect(combobox?.getAttribute("aria-haspopup")).toBe("listbox");
    expect(combobox?.getAttribute("aria-controls")).toBe("askbar-listbox");

    expect(handle.input.getAttribute("role")).toBe("searchbox");
    expect(handle.input.getAttribute("aria-autocomplete")).toBe("list");
    expect(handle.input.getAttribute("aria-label")).toContain("Ask the team");
  });

  it("flat-list ordering keeps the sticky-foot Ask-team row out of plain-Enter default (F-01)", () => {
    // Critical regression — when groups exist AND a query is typed,
    // the FIRST flat-list row (a non-ask row) is the default-highlighted
    // target. The sticky-foot ask-team row must never be the default.
    const pageGroup = buildPageGroup([
      { kind: "page", id: "page-settings", domId: "askbar-page-settings", label: "Settings", to: "/settings" },
    ]);
    const commandGroup = buildCmdGroup([
      { kind: "command", id: "cmd-new", domId: "askbar-cmd-new", label: "New issue", onSelect: () => {} },
    ]);
    const onSelectSuggestion = vi.fn();
    const onAskTeam = vi.fn();
    const handle = mount({
      groups: [commandGroup, pageGroup],
      onSelectSuggestion,
      onAskTeam,
    });
    pressGlobalKey("k", { meta: true });
    typeIntoInput(handle.input, "settings");
    pressInputKey(handle.input, "Enter");
    // The default-highlighted row is the first flat-list entry — a command
    // or page — NEVER the sticky-foot Ask-team row. onAskTeam must not fire.
    expect(onAskTeam).not.toHaveBeenCalled();
    expect(onSelectSuggestion).toHaveBeenCalledTimes(1);
  });
});
