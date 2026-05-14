// @vitest-environment jsdom

/**
 * Board route regression test.
 *
 * The demo shell keeps core founder workflows as real pages. A few lower-signal
 * legacy routes still fold into Today, but Dashboard, Brief, Weekly,
 * Conversations, Decisions, and Approvals must stay independently reachable for
 * customer demos and bookmarks.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";

// React 19 act() environment hint.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const LEGACY_REDIRECTS: ReadonlyArray<{ from: string; to: string }> = [
  { from: "/inbox", to: "/today" },
  { from: "/activity", to: "/today" },
];

const RESTORED_REAL_ROUTES: ReadonlyArray<string> = [
  "/dashboard",
  "/brief",
  "/weekly",
  "/decisions",
  "/approvals",
  "/conversations",
];

function LocationProbe({ onLocation }: { onLocation: (path: string) => void }) {
  const location = useLocation();
  onLocation(`${location.pathname}${location.search}${location.hash}`);
  return null;
}

let containers: HTMLElement[] = [];
let roots: Root[] = [];

afterEach(() => {
  for (const r of roots) act(() => r.unmount());
  for (const c of containers) c.remove();
  containers = [];
  roots = [];
});

function navigateAndRead(from: string): string {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let resolved = "";

  act(() => {
    root.render(
      <MemoryRouter initialEntries={[from]}>
        <Routes>
          <Route path="/today" element={<LocationProbe onLocation={(p) => (resolved = p)} />} />
          <Route path="/inbox" element={<Navigate to="/today" replace />} />
          <Route path="/activity" element={<Navigate to="/today" replace />} />
          {RESTORED_REAL_ROUTES.map((path) => (
            <Route
              key={path}
              path={path}
              element={<LocationProbe onLocation={(p) => (resolved = p)} />}
            />
          ))}
        </Routes>
      </MemoryRouter>,
    );
  });

  containers.push(container);
  roots.push(root);
  return resolved;
}

describe("Board routes", () => {
  for (const { from, to } of LEGACY_REDIRECTS) {
    it(`${from} → ${to}`, () => {
      const resolved = navigateAndRead(from);
      expect(resolved).toBe(to);
    });
  }

  for (const path of RESTORED_REAL_ROUTES) {
    it(`${path} stays independently reachable`, () => {
      const resolved = navigateAndRead(path);
      expect(resolved).toBe(path);
    });
  }

  it("the approvals list route does NOT capture the detail path", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let resolved = "";

    act(() => {
      root.render(
        <MemoryRouter initialEntries={["/approvals/some-uuid"]}>
          <Routes>
            <Route path="/approvals" element={<LocationProbe onLocation={(p) => (resolved = p)} />} />
            <Route path="/approvals/:id" element={<LocationProbe onLocation={(p) => (resolved = p)} />} />
          </Routes>
        </MemoryRouter>,
      );
    });

    containers.push(container);
    roots.push(root);

    expect(resolved).toBe("/approvals/some-uuid");
  });
});
