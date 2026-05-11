// @vitest-environment jsdom

/**
 * P3 Wave 1 — WorktreeBanner production gate test (OQ-6).
 *
 * The orange WORKTREE banner is engineer-real information shown in dev
 * (so founders running `pnpm dev` locally can see which worktree branch
 * they're on). It MUST NOT render in production, staging, or any preview
 * deploy — gating on `import.meta.env.DEV` only.
 *
 * Test strategy:
 *   - The default vitest runtime sets `import.meta.env.DEV = false`
 *     because we set `NODE_ENV=test` in vitest.config.ts. The component
 *     should return null even with worktree meta tags present.
 *   - We mock `getWorktreeUiBranding` to confirm: even when branding data
 *     is present, the early production-gate returns null.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/dev-mode", () => ({
  isDevBuild: () => false,
}));

vi.mock("../lib/worktree-branding", () => ({
  getWorktreeUiBranding: () => ({
    enabled: true,
    name: "feat/test-branch",
    color: "#ff0000",
    textColor: "#ffffff",
  }),
}));

// eslint-disable-next-line import/first
import { WorktreeBanner } from "./WorktreeBanner";

// React 19 act() environment hint.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let containers: HTMLElement[] = [];
let roots: Root[] = [];

afterEach(() => {
  for (const r of roots) act(() => r.unmount());
  for (const c of containers) c.remove();
  containers = [];
  roots = [];
});

function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<WorktreeBanner />);
  });
  containers.push(container);
  roots.push(root);
  return container;
}

describe("WorktreeBanner — production gate (OQ-6)", () => {
  it("renders nothing when import.meta.env.DEV is false (production / staging / preview)", () => {
    // vitest runs with mode=test; import.meta.env.DEV is false.
    // The banner short-circuits BEFORE getWorktreeUiBranding is read.
    const container = render();
    expect(container.children.length).toBe(0);
    // Specifically, no element with "Worktree" copy renders.
    expect(container.textContent).toBe("");
  });
});
