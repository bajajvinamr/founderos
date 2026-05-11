// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UndoToast } from "./UndoToast";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("<UndoToast />", () => {
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

  it("renders message + Undo button on mount", () => {
    const onUndo = vi.fn();
    act(() => {
      root.render(<UndoToast message="Archived 3 items." onUndo={onUndo} />);
    });

    const toast = container.querySelector('[data-testid="undo-toast"]');
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toContain("Archived 3 items.");

    const undoBtn = container.querySelector('[data-testid="undo-toast-undo"]') as HTMLButtonElement;
    expect(undoBtn).not.toBeNull();
    expect(undoBtn.textContent).toContain("Undo");
  });

  it("clicking Undo before the window expires fires onUndo and dismisses the toast", () => {
    const onUndo = vi.fn();
    const onDismiss = vi.fn();
    act(() => {
      root.render(
        <UndoToast message="Archived." onUndo={onUndo} onDismiss={onDismiss} durationMs={10_000} />,
      );
    });

    // Advance partway through the window — toast still mounted.
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(container.querySelector('[data-testid="undo-toast"]')).not.toBeNull();

    const undoBtn = container.querySelector('[data-testid="undo-toast-undo"]') as HTMLButtonElement;
    act(() => undoBtn.click());

    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    // After undo, the toast renders null.
    expect(container.querySelector('[data-testid="undo-toast"]')).toBeNull();
  });

  it("auto-dismiss fires onDismiss after the window elapses and the toast disappears", () => {
    const onUndo = vi.fn();
    const onDismiss = vi.fn();
    act(() => {
      root.render(
        <UndoToast message="Archived." onUndo={onUndo} onDismiss={onDismiss} durationMs={10_000} />,
      );
    });

    // Pre-boundary — still visible, no callbacks.
    act(() => {
      vi.advanceTimersByTime(9_999);
    });
    expect(container.querySelector('[data-testid="undo-toast"]')).not.toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();

    // Cross the boundary — timer fires once.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onUndo).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="undo-toast"]')).toBeNull();
  });

  it("returns null when visible has flipped to false (post-dismissal render path)", () => {
    const onUndo = vi.fn();
    const onDismiss = vi.fn();
    act(() => {
      root.render(
        <UndoToast message="Archived." onUndo={onUndo} onDismiss={onDismiss} durationMs={10_000} />,
      );
    });

    // Trigger the auto-dismiss path which sets visible=false internally.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    // visible === false → render returns null; no toast DOM remains.
    expect(container.querySelector('[data-testid="undo-toast"]')).toBeNull();
    expect(container.querySelector('[data-testid="undo-toast-undo"]')).toBeNull();
    expect(container.querySelector('[data-testid="undo-toast-progress"]')).toBeNull();
  });

  it("once onDismiss has fired, clicking the (already-unmounted) Undo button cannot dispatch onUndo", () => {
    const onUndo = vi.fn();
    const onDismiss = vi.fn();
    act(() => {
      root.render(
        <UndoToast message="Archived." onUndo={onUndo} onDismiss={onDismiss} durationMs={10_000} />,
      );
    });

    // Capture the button reference before dismissal (it's about to detach from DOM).
    const undoBtn = container.querySelector('[data-testid="undo-toast-undo"]') as HTMLButtonElement;
    expect(undoBtn).not.toBeNull();

    // Auto-dismiss fires.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);

    // Toast is gone — the button is no longer in the DOM (cannot be clicked by users).
    expect(container.querySelector('[data-testid="undo-toast-undo"]')).toBeNull();

    // Click the detached node — onUndo MUST NOT fire (no React listener bound after unmount).
    act(() => undoBtn.click());
    expect(onUndo).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
