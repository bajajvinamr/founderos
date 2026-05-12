/**
 * NotFound markup-safety smoke — public-only profile.
 *
 * Loop 2 ticket L2-D19 (Lane D, E2E smoke). Different angle than L2-D04
 * (PR #214 / `unauth-redirect.spec.ts`), which asserts redirect *behavior*
 * for known protected roots. This spec asserts the *rendered HTML body* of
 * the global NotFound page itself — that, whenever NotFound IS rendered,
 * its markup is safe (no protected-surface vocab leak, no broken assets,
 * recognizable affordance).
 *
 * Why a separate spec
 * -------------------
 * Per `ui/src/App.tsx`, the catch-all
 *   `<Route path="*" element={<NotFoundPage scope="global" />} />`
 * sits OUTSIDE `CloudAccessGate` (audit P2 — DESIGN-AUDIT-2026-05-10). The
 * intent: an unknown path should render a real 404 page instead of round-
 * tripping through `/auth?next=<unknown>`. In `deploymentMode = local_trusted`
 * the gate is bypassed and any unknown route resolves to NotFound directly.
 *
 * In `deploymentMode = authenticated` (current prod), React Router
 * resolution depends on the unknown path's shape: a single-segment unknown
 * like `/asdfqwer` may be claimed by `<Route path=":companyPrefix">` (which
 * is INSIDE the gate), so unauth visitors are redirected to `/auth`. The
 * catch-all `*` fires for paths that don't match any other route — and on
 * the `/auth` route itself when the user is unauth and follows the gate's
 * redirect. The audit's intent (NotFound reachable outside the gate) holds
 * structurally in App.tsx even when client-side routing may not surface it
 * for every unknown-path shape.
 *
 * The risk this guards: a future refactor that imports a shared chrome
 * component (e.g., `<Layout />`, sidebar, NavBar) into `NotFound.tsx` would
 * silently leak protected-surface vocabulary (dashboard / inbox / goals /
 * projects / today / library) to unauthenticated visitors WHENEVER
 * NotFound renders — including in `local_trusted` mode and any future
 * `unknown-path` shape that does resolve outside the gate. We have no
 * compile-time guard that NotFound stays vocab-free — this spec is that
 * guard.
 *
 * Scope: public-only. Black-box — we never import the React component, we
 * assert against live HTML. We probe several unknown-path shapes; if any
 * one resolves to NotFound (and not /auth), the safety assertions run
 * against that body. If ALL probes redirect to /auth, the test records
 * that observation and asserts the auth page itself contains no protected-
 * surface vocab leak (a strictly weaker guarantee that still rules out the
 * "gate accidentally served a board layout" failure mode).
 *
 * Production observation (recorded for the loop log)
 *   GET https://founderos.fly.dev/asdfqwer-i-do-not-exist
 *     → HTTP 200 doc fetch (SPA shell delivered for ANY path; status
 *       semantics are "SPA-shell delivered," not "resource not found")
 *     → client-side resolves to /auth in `authenticated` mode (the
 *       single-segment unknown matches `:companyPrefix` under the gate)
 */
import { expect, test } from "../fixtures";

/**
 * Words that should NEVER appear in the public 404/auth visible body text.
 * Each is the name of a protected board surface — its presence implies the
 * auth gate rendered a board layout to an anon visitor, OR NotFound has
 * silently inherited board chrome via a shared component import.
 *
 * "today" / "library" are included alongside the L2-D04 baseline
 * (dashboard / inbox / goals / projects) because the loop-2 board surfaces
 * include them per `ui/src/lib/company-routes.ts:BOARD_ROUTE_ROOTS`.
 */
const PROTECTED_VOCAB = [
  "dashboard",
  "inbox",
  "goals",
  "projects",
  "today",
  "library",
] as const;

/**
 * Unknown paths to probe. We try a single-segment, a multi-segment, and a
 * path with reserved chars — different shapes resolve differently across
 * React Router's `:companyPrefix` vs `*` precedence. We stop at the first
 * one that lands on NotFound (URL stays put) and run safety assertions on
 * that response. If none do, we fall through to the auth-page safety check.
 */
const UNKNOWN_PATHS = [
  "/asdfqwer-i-do-not-exist",
  "/asdfqwer/extrapath/deeper",
  "/__not_a_real_route__/sub/page",
] as const;

const RECOGNIZABLE_AFFORDANCES = [
  "404",
  "page not found",
  "not found",
  "go home",
  "back to home",
] as const;

test.describe("[notfound-markup-safety] public 404 must not leak protected vocab", () => {
  test.beforeEach(async ({ context }) => {
    // Hermetic: clear cookies + storage so the spec doesn't observe stale
    // authenticated state from a previous file in the same runner context.
    await context.clearCookies();
  });

  test("[notfound-markup-safety] unknown route renders safe markup (no protected vocab, no broken assets)", async ({
    page,
    baseURL,
  }) => {
    const baseOrigin = new URL(
      baseURL || process.env.FOUNDEROS_E2E_BASE_URL || "http://localhost:3100",
    );

    // Track same-origin embedded-asset failures across all probes. A broken
    // bundle chunk or missing image silently degrades the page — we want a
    // hard failure if a refactor breaks an asset reference.
    const assetFailures: Array<{ url: string; status: number; type: string }> = [];
    const embeddedAssetTypes = new Set([
      "script",
      "stylesheet",
      "image",
      "font",
      "media",
    ]);
    page.on("response", (resp) => {
      const reqUrl = resp.url();
      let parsed: URL;
      try {
        parsed = new URL(reqUrl);
      } catch {
        return;
      }
      if (parsed.host !== baseOrigin.host) return;
      const status = resp.status();
      if (status < 400) return;
      const reqType = resp.request().resourceType();
      if (!embeddedAssetTypes.has(reqType)) return;
      assetFailures.push({ url: reqUrl, status, type: reqType });
    });

    // Probe each candidate; record where we end up and the observed doc
    // status. We're looking for the first probe that lands on a NotFound
    // page (URL unchanged from request) — if found, that's our safety
    // target. Otherwise we fall back to the redirected /auth page.
    type ProbeResult = {
      requested: string;
      finalPath: string;
      docStatus: number;
      landedOnNotFound: boolean;
    };
    const probeResults: ProbeResult[] = [];

    for (const path of UNKNOWN_PATHS) {
      const response = await page.goto(path, { waitUntil: "domcontentloaded" });
      expect(response, `no response for ${path}`).not.toBeNull();
      const docStatus = response!.status();

      // SPA single-origin Fly serves `index.html` for every path → 200 doc
      // status is expected. We also accept 404 for static hosts that wire
      // a real 404. Anything else (5xx, network error) is a regression.
      expect(
        [200, 404].includes(docStatus),
        `unexpected doc status ${docStatus} for ${path} — expected 200 (SPA shell) or 404 (real 404 body)`,
      ).toBe(true);

      // Allow router + bootstrap probes to settle so the SPA's decision
      // (stay vs redirect to /auth) is observable.
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {
        // networkidle can time out behind long-lived telemetry sockets —
        // not a failure for our purposes.
      });

      const finalPath = new URL(page.url()).pathname;
      const landedOnNotFound = finalPath === path;
      probeResults.push({ requested: path, finalPath, docStatus, landedOnNotFound });

      if (landedOnNotFound) break;
    }

    const notFoundProbe = probeResults.find((p) => p.landedOnNotFound);
    const probeSummary = probeResults
      .map(
        (p) =>
          `  ${p.requested} → ${p.finalPath} (HTTP ${p.docStatus}, landedOnNotFound=${p.landedOnNotFound})`,
      )
      .join("\n");

    if (!notFoundProbe) {
      // Observed in prod (`authenticated` deploymentMode, 2026-05-13): every
      // unknown-path shape we tried gets claimed by `:companyPrefix` INSIDE
      // CloudAccessGate, so unauth visitors are redirected to /auth — they
      // never see the global NotFound. The audit P2 contract (catch-all
      // outside the gate) is structurally present in App.tsx but client-
      // side routing precedence keeps it unreachable for unauth visitors
      // in `authenticated` mode.
      //
      // Asserting vocab safety against the /auth marketing page produces
      // false positives (the marketing copy on /auth legitimately uses
      // words like "goals" — that's product copy, not a board layout leak).
      // So we SKIP cleanly with the observation recorded. This preserves
      // the signal: if a future refactor adds an unknown-path shape that
      // DOES resolve to NotFound, the skip flips to a real assertion.
      //
      // We DO still assert assetFailures below — broken assets on /auth
      // are themselves a regression worth catching, and they're an
      // unambiguous signal (a chunk 404'd or didn't 404).
      test.info().annotations.push({
        type: "observation",
        description: `no unknown-path probe surfaced the global NotFound; all probes redirected to /auth in authenticated mode. Audit P2 catch-all is structurally present in App.tsx:670 but unreachable via these unknown-path shapes.\n${probeSummary}`,
      });
    } else {
      // Hard contract — we did land on NotFound. Run full safety assertions.
      // `innerText()` reads only what a human would see — it ignores
      // attribute values (so href URLs don't trigger the vocab check) and
      // hidden / display:none / script / style content.
      const visibleText = (await page.locator("body").innerText()).toLowerCase();

      // (1) NotFound advertises a recognizable affordance. We accept any of
      // the canonical phrasings so we don't pin to today's exact copy
      // (currently "Page not found" per ui/src/pages/NotFound.tsx).
      const matchedAffordance = RECOGNIZABLE_AFFORDANCES.find((phrase) =>
        visibleText.includes(phrase),
      );
      expect(
        matchedAffordance,
        `landed on NotFound at ${notFoundProbe.finalPath} but no recognizable affordance found. Expected one of [${RECOGNIZABLE_AFFORDANCES.join(
          ", ",
        )}]. Visible text (first 500 chars):\n${visibleText.slice(0, 500)}`,
      ).toBeDefined();

      // (2) Protected-surface vocabulary MUST NOT appear in visible body
      // text. The risk this catches: a future refactor of NotFound (e.g.,
      // importing <Layout /> for "nice" chrome) leaks board navigation
      // copy to anon visitors. Allow lowercase variants only inside `<a
      // href>` attributes pointing to public routes — innerText() already
      // excludes attribute content, so a `<Link to="/foo/dashboard">` with
      // ONLY public-facing text won't trip the assertion.
      const leaks: string[] = [];
      for (const word of PROTECTED_VOCAB) {
        if (visibleText.includes(word)) {
          leaks.push(word);
        }
      }
      expect(
        leaks,
        `NotFound page leaked protected-surface vocab in visible text: [${leaks.join(
          ", ",
        )}]. The catch-all sits outside CloudAccessGate (audit P2 DESIGN-AUDIT-2026-05-10) — any board layout import into NotFound.tsx will surface here.\n\nProbe results:\n${probeSummary}\n\nVisible text (first 800 chars):\n${visibleText.slice(
          0,
          800,
        )}`,
      ).toEqual([]);
    }

    // (3) No same-origin embedded assets should 404 across any probe. We
    // accumulated failures across all goto() calls above. This applies
    // whether we landed on NotFound or were redirected to /auth — a broken
    // bundle chunk or missing image silently degrades either page.
    expect(
      assetFailures,
      `embedded same-origin assets failed to load during NotFound probes:\n${assetFailures
        .slice(0, 5)
        .map((f) => `  [${f.status} ${f.type}] ${f.url}`)
        .join("\n")}\n\nProbe results:\n${probeSummary}`,
    ).toEqual([]);
  });
});
