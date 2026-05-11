// @vitest-environment jsdom
//
// BL-012 (P4.a) — the localStorage write side flips the data-view-mode
// attribute on RunTranscriptView's outer container. This is the seam BL-013
// (P4.b founder-mode rendering) will branch on. Rendering behavior is
// otherwise unchanged in this dispatch.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ThemeProvider } from "../../context/ThemeContext";
import { RunTranscriptView } from "./RunTranscriptView";

const STORAGE_KEY = "founderos.viewMode";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("RunTranscriptView — viewMode seam (BL-012)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    localStorage.clear();
  });

  it("renders data-view-mode='founder' by default", () => {
    act(() => {
      root.render(
        <ThemeProvider>
          <RunTranscriptView
            entries={[
              {
                kind: "assistant",
                ts: "2026-03-12T00:00:00.000Z",
                text: "hello",
              },
            ]}
          />
        </ThemeProvider>,
      );
    });

    const outer = container.querySelector("[data-view-mode]");
    expect(outer).not.toBeNull();
    expect(outer?.getAttribute("data-view-mode")).toBe("founder");
  });

  it("renders data-view-mode='engineer' when localStorage is set", () => {
    localStorage.setItem(STORAGE_KEY, "engineer");

    act(() => {
      root.render(
        <ThemeProvider>
          <RunTranscriptView
            entries={[
              {
                kind: "assistant",
                ts: "2026-03-12T00:00:00.000Z",
                text: "hello",
              },
            ]}
          />
        </ThemeProvider>,
      );
    });

    const outer = container.querySelector("[data-view-mode]");
    expect(outer?.getAttribute("data-view-mode")).toBe("engineer");
  });

  it("flips data-view-mode when a cross-tab storage event fires", () => {
    act(() => {
      root.render(
        <ThemeProvider>
          <RunTranscriptView
            entries={[
              {
                kind: "assistant",
                ts: "2026-03-12T00:00:00.000Z",
                text: "hello",
              },
            ]}
          />
        </ThemeProvider>,
      );
    });

    expect(container.querySelector("[data-view-mode]")?.getAttribute("data-view-mode")).toBe(
      "founder",
    );

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: STORAGE_KEY,
          newValue: "engineer",
          oldValue: null,
        }),
      );
    });

    expect(container.querySelector("[data-view-mode]")?.getAttribute("data-view-mode")).toBe(
      "engineer",
    );
  });
});
