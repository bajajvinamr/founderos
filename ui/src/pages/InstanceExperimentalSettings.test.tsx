// @vitest-environment node
//
// BL-012 (P4.a) — InstanceExperimentalSettings exposes the Advanced
// (engineer) view toggle. Source-level test (Dashboard.test.tsx pattern):
// a full render requires QueryClient + BreadcrumbContext + the experimental
// settings API stub, out of proportion to the assertion. Source-level
// catches the structural regression that matters — someone deleting the
// Advanced view section.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(__dirname, "InstanceExperimentalSettings.tsx"), "utf8");

describe("InstanceExperimentalSettings (BL-012 / P4.a — Advanced view toggle)", () => {
  it("imports useDisplayMode from the read-side hook", () => {
    expect(SOURCE).toMatch(/import\s+\{\s*useDisplayMode\s*\}\s+from\s+["']\.\.\/lib\/use-display["']/);
  });

  it("renders the Advanced (engineer) view section", () => {
    expect(SOURCE).toContain('data-testid="advanced-view-mode-section"');
    expect(SOURCE).toMatch(/Advanced \(engineer\) view/);
  });

  it("wires the ToggleSwitch to setViewMode with founder/engineer values", () => {
    expect(SOURCE).toMatch(/setViewMode\(\s*next\s*\?\s*["']engineer["']\s*:\s*["']founder["']\s*\)/);
  });

  it("uses an a11y label on the toggle", () => {
    expect(SOURCE).toMatch(/aria-label=["']Toggle Advanced engineer view["']/);
  });
});
