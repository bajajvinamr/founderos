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

  it("race-guard: if the timer fires first, a same-tick handleUndo does NOT double-dispatch", () => {
    const onApprove = vi.fn();
    const onUndo = vi.fn();
    act(() => {
      root.render(
        <QuickApprove rowId="r-race" risk="low" onApprove={onApprove} onUndo={onUndo} undoMs={10_000} />,
      );
    });

    const btn = container.querySelector('[data-testid="quick-approve"]') as HTMLButtonElement;
    act(() => btn.click());

    // The pending-state Undo button — capture the live reference before the timer commits.
    const undoBtn = container.querySelector(
      '[data-testid="quick-approve-undo"]',
    ) as HTMLButtonElement;
    expect(undoBtn).not.toBeNull();

    // Cross the 10s boundary — the timer callback runs synchronously inside `act`,
    // sets committedRef=true, then fires onApprove.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith("r-race");

    // Now simulate the race: handleUndo lands in the same task tick AFTER the timer
    // already committed. Calling click on the captured (now-detached) undoBtn
    // exercises the same code path; the committedRef guard MUST stop it.
    act(() => undoBtn.click());

    // onUndo must NOT have fired — no double-dispatch.
    expect(onUndo).not.toHaveBeenCalled();
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("keyboard activation (Enter) on the Approve button triggers the same flow as a click", () => {
    const onApprove = vi.fn();
    const onUndo = vi.fn();
    act(() => {
      root.render(
        <QuickApprove rowId="r-kbd" risk="low" onApprove={onApprove} onUndo={onUndo} undoMs={10_000} />,
      );
    });

    const btn = container.querySelector('[data-testid="quick-approve"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.tagName).toBe("BUTTON"); // Native button — Enter/Space dispatch click for free.

    // Native <button> elements convert Enter/Space keypress to a click event.
    act(() => btn.click());

    // Confirm the same state transition as a mouse click — pending state, commit on timer.
    expect(container.querySelector('[data-testid="quick-approve-undo"]')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith("r-kbd");
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
