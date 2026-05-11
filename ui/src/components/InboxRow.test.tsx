// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InboxRow } from "./InboxRow";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("<InboxRow />", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function baseProps() {
    return {
      id: "row-1",
      title: "Approve Slack post: launch announcement",
      context: "Growth · drafted by CoS",
      source: "approval" as const,
      risk: "low" as const,
      age: "8m ago",
      onOpenDetail: vi.fn(),
      onSnooze: vi.fn(),
      onArchive: vi.fn(),
      onApprove: vi.fn(),
      onUndo: vi.fn(),
    };
  }

  it("renders title, context, age, and the risk pill", () => {
    const props = baseProps();
    act(() => {
      root.render(<InboxRow {...props} />);
    });

    expect(container.textContent).toContain(props.title);
    expect(container.textContent).toContain(props.context);
    expect(container.textContent).toContain(props.age);

    const pill = container.querySelector('[data-testid="inbox-row-risk"]');
    expect(pill).not.toBeNull();
    expect(pill?.textContent?.toLowerCase()).toContain("low");
  });

  it("renders QuickApprove inline for approval+low-risk rows", () => {
    const props = baseProps();
    act(() => {
      root.render(<InboxRow {...props} />);
    });
    expect(container.querySelector('[data-testid="quick-approve"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="quick-approve-disabled"]')).toBeNull();
  });

  it("renders DisabledQuickApprove on a high-risk approval row (D17 gate)", () => {
    const props = { ...baseProps(), risk: "high" as const };
    act(() => {
      root.render(<InboxRow {...props} />);
    });
    expect(container.querySelector('[data-testid="quick-approve"]')).toBeNull();
    const disabled = container.querySelector('[data-testid="quick-approve-disabled"]');
    expect(disabled).not.toBeNull();
    expect(disabled?.getAttribute("aria-label")).toContain("High-risk");
  });

  it("invokes onArchive and onSnooze from inline hover actions", () => {
    const props = baseProps();
    act(() => {
      root.render(<InboxRow {...props} />);
    });

    const archiveBtn = container.querySelector('button[aria-label="Archive"]') as HTMLButtonElement;
    expect(archiveBtn).not.toBeNull();
    act(() => archiveBtn.click());
    expect(props.onArchive).toHaveBeenCalledTimes(1);

    const snoozeBtn = container.querySelector('button[aria-label="Snooze"]') as HTMLButtonElement;
    expect(snoozeBtn).not.toBeNull();
    act(() => snoozeBtn.click());
    expect(props.onSnooze).toHaveBeenCalledTimes(1);
    const [snoozeArg] = props.onSnooze.mock.calls[0];
    expect(snoozeArg).toBeInstanceOf(Date);
  });

  it("invokes onOpenDetail when the row body is clicked", () => {
    const props = baseProps();
    act(() => {
      root.render(<InboxRow {...props} />);
    });

    const opener = container.querySelector(
      '[data-testid="inbox-row-open"]',
    ) as HTMLButtonElement;
    expect(opener).not.toBeNull();
    act(() => opener.click());
    expect(props.onOpenDetail).toHaveBeenCalledTimes(1);
  });
});
