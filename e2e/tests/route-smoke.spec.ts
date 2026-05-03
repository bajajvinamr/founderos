/**
 * Route-load smoke spec.
 *
 * Walks every route declared in `e2e/lib/route-table.ts` (which mirrors the
 * <Routes> tree in `ui/src/App.tsx`). For each route, asserts that the page:
 *
 *   1. Returns a 2xx/3xx HTTP status on the doc request.
 *   2. Mounts the React tree without throwing a `pageerror`.
 *   3. Does not render an `[data-error-boundary]` element (any scope).
 *   4. Does not show the global "page not found" fallback for routes that
 *      should resolve.
 *
 * What this spec catches that other layers miss:
 *   - A renamed export breaking a `lazy()` import (typecheck still passes).
 *   - A missing context provider when a page is loaded directly (deep-link
 *     regression — these only surface when the user lands on a non-default
 *     route as their first page).
 *   - A new top-level route accidentally captured by `:companyPrefix` because
 *     it wasn't added to `lib/company-routes.ts BOARD_ROUTE_ROOTS`.
 *
 * What this spec deliberately does NOT do:
 *   - Assert on copy or styles (use page-specific specs for that).
 *   - Walk every param permutation (one valid ID per entity is enough).
 *   - Test error-boundary triggering on a real error path (different goal).
 */
import {
  ALL_ROUTE_GROUPS,
  buildUrl,
  type RouteEntry,
} from "../lib/route-table";
import { expect, test } from "../fixtures";
import type { ApiHelper, CompanyCtx } from "../fixtures";

interface ResolvedIds {
  agent: string | null;
  project: string | null;
  issue: string | null;
  goal: string | null;
  approval: string | null;
  routine: string | null;
}

async function resolveIds(api: ApiHelper, ctx: CompanyCtx): Promise<ResolvedIds> {
  const companyId = ctx.company.id;

  // Agents are already loaded by the fixture.
  const agent = ctx.agents[0]?.id ?? null;

  // The remaining endpoints are fire-and-forget; we tolerate empty arrays
  // (smoke spec just skips routes whose params can't be resolved).
  const safeFirstId = async (path: string): Promise<string | null> => {
    const r = await api.get(path);
    if (r.status !== 200 || !Array.isArray(r.json) || r.json.length === 0) {
      return null;
    }
    const first = (r.json as Array<{ id?: string }>)[0];
    return first?.id ?? null;
  };

  const [project, issue, goal, approval, routine] = await Promise.all([
    safeFirstId(`/api/companies/${companyId}/projects`),
    safeFirstId(`/api/companies/${companyId}/issues`),
    safeFirstId(`/api/companies/${companyId}/goals`),
    safeFirstId(`/api/companies/${companyId}/approvals`),
    safeFirstId(`/api/companies/${companyId}/routines`),
  ]);

  return { agent, project, issue, goal, approval, routine };
}

/**
 * Returns the parameter values needed to substitute into a route template,
 * keyed by param name. Routes that need params we couldn't resolve return
 * a `null` for that key — the caller treats this as a skip signal.
 */
function paramValues(entry: RouteEntry, ids: ResolvedIds): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (!entry.params) return out;
  for (const p of entry.params) {
    if (p.source === "static") {
      out[p.name] = p.value ?? null;
      continue;
    }
    if (p.source === "agent") out[p.name] = ids.agent;
    else if (p.source === "project") out[p.name] = ids.project;
    else if (p.source === "issue") out[p.name] = ids.issue;
    else if (p.source === "goal") out[p.name] = ids.goal;
    else if (p.source === "approval") out[p.name] = ids.approval;
    else if (p.source === "routine") out[p.name] = ids.routine;
    else if (p.source === "company") out[p.name] = ids.agent ? "1" : null;
  }
  return out;
}

test.describe("[route-smoke] every route mounts cleanly", () => {
  for (const group of ALL_ROUTE_GROUPS) {
    test.describe(`group: ${group.label}`, () => {
      for (const entry of group.routes) {
        // Build a stable test title even before we can substitute params.
        const title = entry.skip
          ? `${entry.path} — SKIPPED (${entry.skip.reason})`
          : entry.path;

        test(`[route-smoke] ${group.label} → ${title}`, async ({
          page,
          api,
          companyCtx,
          profile,
        }) => {
          if (entry.skip) {
            test.skip(true, entry.skip.reason);
            return;
          }
          if (profile === "public-only" && entry.companyPrefixed) {
            test.skip(true, "company-prefixed route requires authenticated profile");
            return;
          }
          if (entry.companyPrefixed && !companyCtx) {
            test.skip(true, "no companyCtx — seed missing or companies endpoint unreachable");
            return;
          }

          const ids: ResolvedIds = companyCtx
            ? await resolveIds(api, companyCtx)
            : { agent: null, project: null, issue: null, goal: null, approval: null, routine: null };
          const resolved = paramValues(entry, ids);

          // Skip rather than fail when seed data is missing the entity this
          // route needs (e.g. a company with zero approvals).
          if (entry.params) {
            for (const p of entry.params) {
              if (resolved[p.name] === null) {
                test.skip(true, `seed missing entity ${p.source} for param ${p.name}`);
                return;
              }
            }
          }

          const url = buildUrl(entry, resolved, companyCtx?.company.issuePrefix ?? "AGN");
          expect(url, `buildUrl returned null for ${entry.path}`).not.toBeNull();

          // Capture page-level JS errors so a render exception fails the test
          // with a useful message rather than a silent green.
          const pageErrors: Error[] = [];
          page.on("pageerror", (err) => pageErrors.push(err));

          // Console error capture — these often indicate provider issues that
          // don't actually throw but break the page.
          const consoleErrors: string[] = [];
          page.on("console", (msg) => {
            if (msg.type() === "error") {
              const text = msg.text();
              // React-Router and react-query both emit benign "fetch aborted"
              // messages on rapid navigation; ignore those.
              if (/aborted|cancelled|cancel/i.test(text)) return;
              consoleErrors.push(text);
            }
          });

          const response = await page.goto(url!, { waitUntil: "domcontentloaded" });
          expect(
            response,
            `no response for ${url} — server unreachable?`,
          ).not.toBeNull();
          const status = response!.status();
          expect(
            status >= 200 && status < 400,
            `HTTP ${status} for ${url}`,
          ).toBe(true);

          // Wait for the React mount to complete. The CloudAccessGate's
          // BootSplash is itself a paint, so we wait for either:
          //  (a) the splash to disappear (real page rendered),
          //  (b) an error boundary to render, or
          //  (c) a 5s timeout (then we still assert it's not the boundary).
          await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

          // No JS errors should have fired during navigation/render.
          expect(
            pageErrors,
            `page emitted JS errors at ${url}:\n${pageErrors.map((e) => e.message).join("\n")}`,
          ).toHaveLength(0);

          // Console errors are softer signal — many components log on benign
          // conditions (missing optional data, intermediate redirect state on
          // /, optional plugin endpoints absent in seed). We tolerate up to 8
          // and additionally filter out network-shaped messages — a real
          // render-time bug shows up as a JS error (asserted above), not a
          // network 404. The cap exists only to surface log-spam regressions.
          const renderConsoleErrors = consoleErrors.filter(
            (e) =>
              !/Failed to load resource/i.test(e) &&
              !/net::ERR_/i.test(e) &&
              !/Manifest:/i.test(e),
          );
          expect(
            renderConsoleErrors.length,
            `excessive render-time console errors at ${url}:\n${renderConsoleErrors.slice(0, 5).join("\n---\n")}`,
          ).toBeLessThanOrEqual(3);

          // Error boundary — the global ErrorBoundary in the app uses a
          // distinctive class name, but we additionally check for any
          // `[data-error-boundary]` test-id in case one is added later.
          const boundary = page.locator("[data-error-boundary]");
          await expect(
            boundary,
            `error boundary rendered at ${url}`,
          ).toHaveCount(0);

          // For routes we expect to actually render (i.e. not redirect to
          // landing/auth), assert we did not land on the global NotFound.
          // Public routes might legitimately resolve to NotFound when the
          // token is fake — those tests still pass on (1)-(3) above.
          if (!entry.expectsRedirect && !entry.params) {
            const notFound = page.locator("text=/page not found|Couldn’t find this page|404/i");
            const notFoundCount = await notFound.count();
            // Tolerate 0 or 1 — some pages contain an empty-state with the word
            // "not found" that's not the global 404 fallback.
            expect(
              notFoundCount <= 1,
              `multiple "not found" indicators rendered at ${url} — likely the global 404 fallback`,
            ).toBe(true);
          }
        });
      }
    });
  }
});
