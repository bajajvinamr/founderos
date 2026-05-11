// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The page uses CompanyContext for fallback dashboard URL and BreadcrumbContext
// for the page header crumb. Both are tangential to the 404 copy assertion —
// stub them out so the test renders without a full provider tree.
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ companies: [], selectedCompany: null }),
}));

// @/lib/router re-exports react-router-dom plus a Link wrapper that consults
// useCompany. The mock above keeps that wrapper functional.
import { NotFoundPage } from "./NotFound";

describe("NotFoundPage", () => {
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

  it("renders the 404 copy and recovery CTAs for an unknown route", () => {
    act(() => {
      root.render(
        <MemoryRouter initialEntries={["/some-bogus-path"]}>
          <NotFoundPage />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("Page not found");
    expect(container.textContent).toContain("This route does not exist.");
    expect(container.textContent).toContain("/some-bogus-path");
    expect(container.textContent).toContain("Open dashboard");
    expect(container.textContent).toContain("Go home");
  });
});
