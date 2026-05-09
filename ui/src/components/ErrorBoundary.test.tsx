// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Sentry init never fires in tests (no VITE_SENTRY_DSN), so
// captureBrowserErrorWithEventId resolves to null. No mock needed for the
// happy-path assertions; we only need the fallback UI to render.

const Boom = (): never => {
  throw new Error("boom");
};

describe("ErrorBoundary", () => {
  let container: HTMLDivElement;
  let root: Root;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // Suppress React's render-error log noise so test output stays clean.
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    consoleErrorSpy.mockRestore();
  });

  it("renders children when no error is thrown", () => {
    act(() => {
      root.render(
        <ErrorBoundary>
          <div>healthy child</div>
        </ErrorBoundary>,
      );
    });

    expect(container.textContent).toContain("healthy child");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("renders the recovery UI when a child throws during render", () => {
    act(() => {
      root.render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(container.textContent).toContain("Something went wrong");
    expect(container.textContent).toContain("Try again");
    expect(container.textContent).toContain("Go home");
  });

  it("clears the error state when the user clicks 'Try again'", () => {
    act(() => {
      root.render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );
    });

    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    const resetButton = Array.from(
      container.querySelectorAll("button"),
    ).find((btn) => btn.textContent?.includes("Try again"));
    expect(resetButton).toBeDefined();

    // Re-render with a healthy child BEFORE clicking reset, so the next
    // render after the click has something safe to mount.
    act(() => {
      root.render(
        <ErrorBoundary>
          <div>recovered child</div>
        </ErrorBoundary>,
      );
    });

    // The boundary's internal hasError flag is still true even though the
    // children prop changed — that's the React semantic this skill targets.
    // Clicking 'Try again' resets state and re-renders the children.
    const resetButtonAfter = Array.from(
      container.querySelectorAll("button"),
    ).find((btn) => btn.textContent?.includes("Try again"));
    expect(resetButtonAfter).toBeDefined();

    act(() => {
      resetButtonAfter!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("recovered child");
  });
});
