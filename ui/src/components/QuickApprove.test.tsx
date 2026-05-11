// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QuickApprove, DisabledQuickApprove } from "./QuickApprove";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("<QuickApprove />", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it("commits onApprove only after the undo window elapses", () => {
    const onApprove = vi.fn();
    const onUndo = vi.fn();
    act(() => {
      root.render(
        <QuickApprove rowId="r-1" risk="low" onApprove={onApprove} onUndo={onUndo} undoMs={10_000} />,
      );
    });

    const btn = container.querySelector('[data-testid="quick-approve"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    act(() => btn.click());

    // Pending state shows the undo button; commit has not fired yet.
    expect(container.querySelector('[data-testid="quick-approve-undo"]')).not.toBeNull();
    expect(onApprove).not.toHaveBeenCalled();

    // Fast-forward 9.9s — still pending, no commit.
    act(() => {
      vi.advanceTimersByTime(9_900);
    });
    expect(onApprove).not.toHaveBeenCalled();

    // Cross the boundary — commit fires exactly once.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith("r-1");
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("undo within the window cancels the commit and calls onUndo", () => {
    const onApprove = vi.fn();
    const onUndo = vi.fn();
    act(() => {
      root.render(
        <QuickApprove rowId="r-2" risk="low" onApprove={onApprove} onUndo={onUndo} undoMs={10_000} />,
      );
    });

    const btn = container.querySelector('[data-testid="quick-approve"]') as HTMLButtonElement;
    act(() => btn.click());

    const undoBtn = container.querySelector(
      '[data-testid="quick-approve-undo"]',
    ) as HTMLButtonElement;
    expect(undoBtn).not.toBeNull();
    act(() => undoBtn.click());

    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onUndo).toHaveBeenCalledWith("r-2");

    // Even after the original window elapses, onApprove must not fire.
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("renders nothing when risk is not low (D17 safety guard)", () => {
    const onApprove = vi.fn();
    const onUndo = vi.fn();
    act(() => {
      root.render(
        <QuickApprove rowId="r-3" risk="high" onApprove={onApprove} onUndo={onUndo} />,
      );
    });
    expect(container.querySelector('[data-testid="quick-approve"]')).toBeNull();
    expect(container.children.length === 0 || container.firstElementChild?.children.length === 0).toBe(true);
  });
});

describe("<DisabledQuickApprove />", () => {
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

  it("invokes onClick (which the row wires to onOpenDetail) when activated", () => {
    const onClick = vi.fn();
    act(() => {
      root.render(<DisabledQuickApprove tooltip="High-risk — review details first" onClick={onClick} />);
    });
    const btn = container.querySelector(
      '[data-testid="quick-approve-disabled"]',
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("title")).toBe("High-risk — review details first");
    act(() => btn.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
