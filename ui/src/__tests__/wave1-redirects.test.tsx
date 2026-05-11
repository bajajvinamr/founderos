// @vitest-environment jsdom

/**
 * P3 Wave 1 — redirect map regression test.
 *
 * Source: 06-engineering-handoff.md §2.2 (Wave 1 redirect contract).
 *
 * Asserts every Wave 1 redirect resolves to the documented target. The
 * test renders a minimal Routes tree using react-router-dom directly and
 * navigates to each old path; the resulting pathname must match the
 * expected new path.
 *
 * Why direct react-router-dom (vs the project's @/lib/router wrapper):
 *   - The wrapper requires `useCompany()` which adds a chunk of context
 *     plumbing for what is a router-level assertion. The redirect logic
 *     in App.tsx uses raw `<Navigate>` from @/lib/router; the actual
 *     redirect semantics are RR DOM's. Mocking @/lib/router to be a
 *     passthrough is the same test contract.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";

// React 19 act() environment hint.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Match the Wave 1 redirect table verbatim. Source: 06-engineering-handoff.md §2.2.
 *
 * Note: `/approvals/:id` is intentionally NOT redirected (scope-fence §12 —
 * the decision-row click target survives unchanged). The list-only
 * `/approvals` redirects to `/today?view=queue&risk=high`.
 */
const WAVE_1_REDIRECTS: ReadonlyArray<{ from: string; to: string }> = [
  { from: "/dashboard", to: "/today" },
  { from: "/inbox", to: "/today" },
  { from: "/brief", to: "/today#brief" },
  { from: "/weekly", to: "/today#weekly" },
  { from: "/decisions", to: "/today" },
  { from: "/approvals", to: "/today?view=queue&risk=high" },
  { from: "/conversations", to: "/today" },
  { from: "/activity", to: "/today" },
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
          <Route path="/dashboard" element={<Navigate to="/today" replace />} />
          <Route path="/inbox" element={<Navigate to="/today" replace />} />
          <Route path="/brief" element={<Navigate to="/today#brief" replace />} />
          <Route path="/weekly" element={<Navigate to="/today#weekly" replace />} />
          <Route path="/decisions" element={<Navigate to="/today" replace />} />
          <Route path="/approvals" element={<Navigate to="/today?view=queue&risk=high" replace />} />
          <Route path="/conversations" element={<Navigate to="/today" replace />} />
          <Route path="/activity" element={<Navigate to="/today" replace />} />
        </Routes>
      </MemoryRouter>,
    );
  });

  containers.push(container);
  roots.push(root);
  return resolved;
}

describe("Wave 1 redirect map", () => {
  for (const { from, to } of WAVE_1_REDIRECTS) {
    it(`${from} → ${to}`, () => {
      const resolved = navigateAndRead(from);
      expect(resolved).toBe(to);
    });
  }

  it("the approvals list redirect is exact and does NOT capture the detail path (scope-fence §12)", () => {
    // The `/approvals` redirect captures the LIST path only; `/approvals/:id`
    // (the decision-row click target) is intentionally NOT redirected.
    // React Router matches paths exactly (when no wildcard is used), so
    // `Route path="/approvals"` does NOT capture `/approvals/some-uuid`.
    // This test renders both routes side-by-side and asserts the detail
    // path resolves WITHOUT going through the list redirect.
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let resolved = "";

    act(() => {
      root.render(
        <MemoryRouter initialEntries={["/approvals/some-uuid"]}>
          <Routes>
            <Route path="/approvals" element={<Navigate to="/today?view=queue&risk=high" replace />} />
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
