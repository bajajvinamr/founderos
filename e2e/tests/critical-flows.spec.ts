/**
 * Wave 23A — Critical-flow E2E suite.
 *
 * Each `test.describe` groups a regression class. Tests are grouped by
 * category (landing / routing / api / admin) so failures point at a zone.
 *
 * Rule: every assertion includes a descriptive message with the
 * request/response context so a failing CI run is actionable without
 * spelunking through HTML reports.
 *
 * Idempotency: tests NEVER mutate prod data — POST/PATCH calls are either
 * test-skipped on prod (via `profile === "public-only"`) or executed against
 * the local demo's handoff surface which is append-only and harmless.
 */
import { describeResponse, expect, test, waitForAppReady, type Profile } from "../fixtures";

/** The unauthed / public-only subset exported for the synthetic monitor. */
export const PUBLIC_ONLY_TEST_IDS = new Set([
  "landing",
  "auth-page",
  "unauth-redirect",
  "health",
  "company-prefix-routing",
  "composio-status",
  "static-assets",
]);

function requireAuthed(profile: Profile, testId: string) {
  if (profile === "public-only") {
    test.skip(
      true,
      `[${testId}] skipped on public-only profile — needs local demo data`,
    );
  }
}

// ────────────────────────────────────────────────────────────────────────
// 1–3, 15 — Landing & UI surfaces
// ────────────────────────────────────────────────────────────────────────
test.describe("landing", () => {
  // Re-enabled 2026-05-02 after Wave 23B static-build E2E hardening.
  // Originally quarantined (#16) when CI ran under static-build mode but
  // local vite-dev passed; the route-load smoke spec confirmed Landing.tsx
  // mounts cleanly under static-build, so the previous failure was likely
  // the upstream ECONNREFUSED harness bug rather than a real regression.
  test("[landing] hero + sign-up CTA render", async ({ page }) => {
    const response = await page.goto("/");
    expect(
      response,
      "GET / returned nothing (network error?)",
    ).not.toBeNull();
    expect(
      response!.status(),
      `GET / returned ${response!.status()} (expected 200)`,
    ).toBeLessThan(400);
    await waitForAppReady(page);

    // Hero must have rendered some meaningful copy. We don't hard-code exact
    // wording (marketing copy drifts) — we just require one of a family of
    // plausible signals is visible.
    const heroCandidates = page.locator(
      "h1, h2, [role=heading], [data-testid=landing-hero]",
    );
    await expect(heroCandidates.first()).toBeVisible({ timeout: 15_000 });

    // A primary CTA link to /auth must be visible. Match case-insensitively
    // on the family of phrases used across landing copy revisions.
    const cta = page
      .getByRole("link", { name: /sign\s*up|get\s*started|build\s*your\s*company|design\s*partner|start\s*your/i })
      .or(page.getByRole("button", { name: /sign\s*up|get\s*started|build\s*your\s*company|design\s*partner|start\s*your/i }));
    await expect(
      cta.first(),
      "Landing page has no visible primary CTA link — " +
        "check ui/src/pages/Landing.tsx",
    ).toBeVisible({ timeout: 10_000 });
  });

  test("[auth-page] /auth renders auth form", async ({ page }) => {
    const response = await page.goto("/auth");
    expect(response, "GET /auth returned nothing").not.toBeNull();
    expect(
      response!.status(),
      `GET /auth returned ${response!.status()}`,
    ).toBeLessThan(400);
    await waitForAppReady(page);

    // Email input must accept text. Locator is intentionally broad — we
    // support both better-auth's default form and the Supabase auth layout.
    const emailInput = page
      .locator('input[type="email"], input[name="email"], input[autocomplete="email"]')
      .first();
    await expect(
      emailInput,
      "/auth page has no email input — check ui/src/pages/Auth.tsx",
    ).toBeVisible({ timeout: 10_000 });
    await emailInput.fill("probe@founderos.test");
    await expect(emailInput).toHaveValue("probe@founderos.test");

    // Google SSO button is optional (not all builds ship it) but when it
    // exists, it must be clickable. Use `count()` to branch without failing.
    const googleBtn = page.getByRole("button", { name: /google/i });
    if ((await googleBtn.count()) > 0) {
      await expect(googleBtn.first()).toBeEnabled();
    }
  });
});

test.describe("routing", () => {
  test("[unauth-redirect] /dashboard redirects signed-out users off the CLI bootstrap page", async ({
    page,
    profile,
  }) => {
    // Only meaningful against `authenticated` mode; local_trusted has no
    // login. If we're pointed at prod we want this test to actually run —
    // it's one of our public-safe regressions.
    const response = await page.goto("/dashboard");
    expect(response, "GET /dashboard returned nothing").not.toBeNull();
    await waitForAppReady(page);

    // Whatever URL we land on must NOT be the CLI-invite BootstrapPendingPage.
    // That page is legacy and should only appear for signed-in users on
    // bootstrap_pending instances — never for unauth users.
    const bodyText = await page.locator("body").innerText();
    expect(
      bodyText,
      `/dashboard when signed out rendered the BootstrapPendingPage instead of ` +
        `redirecting to /auth or /landing. Current URL: ${page.url()}`,
    ).not.toMatch(/bootstrap-ceo|Instance setup required/i);

    const finalUrl = new URL(page.url());
    // Acceptable landing spots: /auth (with next=) OR /landing OR / (when
    // the instance is local_trusted and everyone is implicit admin).
    const okPaths = ["/auth", "/landing", "/"];
    const onExpected = okPaths.some((p) =>
      finalUrl.pathname === p || finalUrl.pathname.startsWith(`${p}?`) || finalUrl.pathname.startsWith(p),
    );
    // In local_trusted mode the app will let you through to a company
    // dashboard — so if we're there, that's also fine. Just make sure we
    // aren't showing the legacy bootstrap page.
    const dashedIn = /\/[A-Z]{2,}\/dashboard$/.test(finalUrl.pathname);
    expect(
      onExpected || dashedIn,
      `Unexpected post-redirect URL: ${page.url()} (profile=${profile})`,
    ).toBe(true);
  });

  test("[company-prefix-routing] top-level routes do NOT throw 'No company matches prefix'", async ({
    page,
  }) => {
    // Regression guard for the exact bug from wave 22 where navigating to
    // /departments/chief-of-staff treated "departments" as a company prefix.
    const paths = [
      "/departments/chief-of-staff",
      "/weekly",
      "/decisions",
      "/conversations",
      "/hire",
    ];

    for (const path of paths) {
      const response = await page.goto(path, { waitUntil: "domcontentloaded" });
      // We don't care about 401/200 — we care that the app doesn't render
      // the specific error banner "No company matches prefix X".
      const body = await page.locator("body").innerText();
      expect(
        body,
        `Route ${path} rendered 'No company matches prefix' — this means the ` +
          `path is being mis-routed as a :companyPrefix param. See ui/src/App.tsx ` +
          `and the pre-prefix route list.`,
      ).not.toMatch(/No company matches prefix/i);
      // Also guard against unhandled 500s that would indicate a route blew up.
      const status = response?.status() ?? 0;
      expect(
        status < 500,
        `Route ${path} returned HTTP ${status} (expected <500)`,
      ).toBe(true);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// 4, 6 — Always-public API health + integration status
// ────────────────────────────────────────────────────────────────────────
test.describe("api-public", () => {
  test("[health] /api/health returns 200 with {status, version} (task #139 strip)", async ({ api }) => {
    const r = await api.get("/api/health");
    expect(
      r.status,
      describeResponse("GET /api/health did not return 200", r),
    ).toBe(200);
    const body = r.json as Record<string, unknown> | null;
    expect(body, "GET /api/health returned non-JSON body").not.toBeNull();
    expect(
      body && body.status === "ok",
      "GET /api/health response missing status:ok",
    ).toBe(true);
    // Task #139 — these fields moved to /api/health/bootstrap-state and
    // /api/health/diagnostics. Liveness probe must NOT leak them.
    expect(
      body && !("authReady" in body),
      "GET /api/health leaked authReady — task #139 strip regressed",
    ).toBe(true);
    expect(
      body && !("bootstrapStatus" in body),
      "GET /api/health leaked bootstrapStatus — task #139 strip regressed",
    ).toBe(true);
    expect(
      body && !("deploymentMode" in body),
      "GET /api/health leaked deploymentMode — task #139 strip regressed",
    ).toBe(true);
  });

  test("[bootstrap-state] /api/health/bootstrap-state returns the UI's pre-signin fields", async ({ api }) => {
    const r = await api.get("/api/health/bootstrap-state");
    expect(
      r.status,
      describeResponse("GET /api/health/bootstrap-state did not return 200", r),
    ).toBe(200);
    const body = r.json as Record<string, unknown> | null;
    expect(body, "bootstrap-state was non-JSON").not.toBeNull();
    expect(body && "deploymentMode" in body, "missing deploymentMode").toBe(true);
    expect(body && "authReady" in body, "missing authReady").toBe(true);
    expect(body && "bootstrapStatus" in body, "missing bootstrapStatus").toBe(true);
    expect(body && "bootstrapInviteActive" in body, "missing bootstrapInviteActive").toBe(true);
    // Defense in depth: must NOT leak deploymentExposure or features here either
    expect(body && !("deploymentExposure" in body), "leaked deploymentExposure").toBe(true);
    expect(body && !("features" in body), "leaked features").toBe(true);
  });

  test("[composio-status] /api/composio/status returns {enabled, configuredApps[]}", async ({
    api,
  }) => {
    const r = await api.get("/api/composio/status");
    expect(
      r.status,
      describeResponse("GET /api/composio/status did not return 200", r),
    ).toBe(200);
    const body = r.json as { enabled?: unknown; configuredApps?: unknown } | null;
    expect(body, "composio status was non-JSON").not.toBeNull();
    expect(
      typeof body?.enabled,
      "composio status.enabled is not boolean",
    ).toBe("boolean");
    expect(
      Array.isArray(body?.configuredApps),
      "composio status.configuredApps is not an array",
    ).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 7 — Onboarding v2 feature flag renders 6-step wizard
// ────────────────────────────────────────────────────────────────────────
test.describe("onboarding", () => {
  test("[onboarding-v2-flag] /onboarding renders the multi-step V2 wizard (not legacy)", async ({
    page,
    profile,
  }) => {
    requireAuthed(profile, "onboarding-v2-flag");

    await page.goto("/onboarding");
    await waitForAppReady(page);

    // V2 = `FounderOnboardingWizard` (renders "Step N of M" text — currently
    // M = 8 after S1.9 added departments and S-TC1 added telemetry consent).
    // Legacy = `OnboardingWizard` (4 steps, no "Step N of M" copy).
    // We detect V2 by the step-counter pattern, NOT by literal step count —
    // M has grown 6→7→8 over time and will keep growing. Coupling the spec
    // to a specific count means every wizard scope-add silently breaks E2E.
    //
    // NOTE: The wizard opens via the DialogContext when the user clicks
    // "Start onboarding", not always on page load — so we click the button
    // first if we see it.
    const startBtn = page.getByRole("button", { name: /start onboarding|new company|hire teammate/i });
    if ((await startBtn.count()) > 0) {
      await startBtn.first().click();
    }

    const wizard = page
      .locator("[role=dialog], [data-testid*=onboarding], [data-testid*=wizard]")
      .first();
    await expect(
      wizard,
      "/onboarding did not open a wizard dialog after clicking Start onboarding — " +
        "check FOUNDEROS_ONBOARDING_V2 flag and ui/src/components/onboarding/FounderOnboardingWizard.tsx",
    ).toBeVisible({ timeout: 10_000 });

    // V2 signal: the "Step {N} of {TOTAL_STEPS}" copy at
    // FounderOnboardingWizard.tsx:277. Legacy wizard does not render this
    // pattern. Decoupled from the literal value of TOTAL_STEPS so future
    // scope-adds don't silently break this gate.
    const dialogText = await wizard.innerText();
    const hasStepCounter = /Step\s+\d+\s+of\s+\d+/i.test(dialogText);
    expect(
      hasStepCounter,
      "Onboarding wizard is not the V2 flow (no 'Step N of M' counter). " +
        "Either FOUNDEROS_ONBOARDING_V2 is off and the legacy wizard is rendering, " +
        "or FounderOnboardingWizard.tsx step-counter copy was removed — " +
        "see ui/src/App.tsx and ui/src/components/onboarding/FounderOnboardingWizard.tsx:277.",
    ).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 8–11 — Scoped list APIs return the expected shape
// ────────────────────────────────────────────────────────────────────────
test.describe("api-scoped", () => {
  test("[memory-list-api] /api/companies/:id/memory returns an array", async ({
    api,
    companyCtx,
    profile,
  }) => {
    requireAuthed(profile, "memory-list-api");
    test.skip(!companyCtx, "no local demo company available");

    const r = await api.get(`/api/companies/${companyCtx!.company.id}/memory`);
    expect(
      r.status,
      describeResponse("GET memory list did not return 200", r),
    ).toBe(200);
    expect(
      Array.isArray(r.json),
      describeResponse("GET memory list response is not an array", r),
    ).toBe(true);
  });

  test("[weekly-wrap-api] /api/companies/:id/weekly-wraps returns an array", async ({
    api,
    companyCtx,
    profile,
  }) => {
    requireAuthed(profile, "weekly-wrap-api");
    test.skip(!companyCtx, "no local demo company available");

    const r = await api.get(`/api/companies/${companyCtx!.company.id}/weekly-wraps`);
    expect(
      r.status,
      describeResponse("GET weekly-wraps list did not return 200", r),
    ).toBe(200);
    expect(
      Array.isArray(r.json),
      describeResponse("GET weekly-wraps is not an array", r),
    ).toBe(true);
  });

  test("[agents-list-api] /api/companies/:id/agents returns an array", async ({
    api,
    companyCtx,
    profile,
  }) => {
    requireAuthed(profile, "agents-list-api");
    test.skip(!companyCtx, "no local demo company available");

    const r = await api.get(`/api/companies/${companyCtx!.company.id}/agents`);
    expect(
      r.status,
      describeResponse("GET agents list did not return 200", r),
    ).toBe(200);
    expect(
      Array.isArray(r.json),
      describeResponse("GET agents list is not an array", r),
    ).toBe(true);
  });

  test("[decisions-list-api-shape] /api/companies/:id/decisions/pending-outcomes returns the expected envelope", async ({
    api,
    companyCtx,
    profile,
  }) => {
    requireAuthed(profile, "decisions-list-api-shape");
    test.skip(!companyCtx, "no local demo company available");

    // `/decisions` itself is a UI-only route (DecisionsInbox is sourced from
    // approvals + decision-outcomes). The API spine for the page is the
    // pending-outcomes endpoint — which returns `{ count, outcomes: [] }`.
    const r = await api.get(
      `/api/companies/${companyCtx!.company.id}/decisions/pending-outcomes`,
    );
    expect(
      r.status,
      describeResponse("GET pending-outcomes did not return 200", r),
    ).toBe(200);
    const body = r.json as { count?: unknown; outcomes?: unknown } | null;
    expect(body, "pending-outcomes body was not JSON").not.toBeNull();
    expect(
      Array.isArray(body?.outcomes),
      describeResponse("pending-outcomes.outcomes is not an array", r),
    ).toBe(true);
    expect(
      typeof body?.count,
      "pending-outcomes.count is not a number",
    ).toBe("number");
  });
});

// ────────────────────────────────────────────────────────────────────────
// 12 — Handoff create against local demo
// ────────────────────────────────────────────────────────────────────────
test.describe("api-mutations", () => {
  test("[handoff-create] POST handoff returns the created handoff", async ({
    api,
    companyCtx,
    profile,
  }) => {
    requireAuthed(profile, "handoff-create");
    test.skip(!companyCtx, "no local demo company available");
    test.skip(
      (companyCtx?.agents.length ?? 0) < 2,
      `handoff needs 2+ agents but demo company '${companyCtx?.company.name}' has ${companyCtx?.agents.length ?? 0}`,
    );

    const [from, to] = companyCtx!.agents;
    const r = await api.post(
      `/api/companies/${companyCtx!.company.id}/handoffs`,
      {
        fromAgentId: from.id,
        toAgentId: to.id,
        request: `[e2e-23A] Probe handoff at ${new Date().toISOString()}`,
        context: { source: "e2e-23A" },
      },
    );
    expect(
      r.status,
      describeResponse("POST handoff did not return 201", r),
    ).toBe(201);
    const body = r.json as { id?: unknown; fromAgentId?: unknown; toAgentId?: unknown } | null;
    expect(
      typeof body?.id,
      describeResponse("handoff response missing id", r),
    ).toBe("string");
    expect(
      body?.fromAgentId,
      describeResponse("handoff response fromAgentId mismatch", r),
    ).toBe(from.id);
    expect(
      body?.toAgentId,
      describeResponse("handoff response toAgentId mismatch", r),
    ).toBe(to.id);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 13 — Admin gate on debug/sentry-canary
// ────────────────────────────────────────────────────────────────────────
test.describe("admin", () => {
  test("[sentry-canary-gated] /api/debug/sentry-canary is 403 for non-admin", async ({
    api,
    profile,
  }) => {
    // In local_trusted mode the implicit actor IS an admin, so this test
    // would see the canary fire (500). We run it against prod / authenticated
    // surfaces where we expect a 403 for an unauth request.
    if (profile === "default") {
      // Task #139 — deploymentMode moved off /api/health to /api/health/bootstrap-state
      const h = await api.get("/api/health/bootstrap-state");
      const mode = (h.json as { deploymentMode?: string } | null)?.deploymentMode;
      test.skip(
        mode === "local_trusted",
        "skipping canary-gated check in local_trusted (every actor is implicit admin)",
      );
    }
    const r = await api.get("/api/debug/sentry-canary");
    expect(
      r.status,
      describeResponse(
        "debug/sentry-canary is not gated — expected 401/403 for unauth",
        r,
      ),
    ).toBeGreaterThanOrEqual(401);
    expect(
      r.status,
      describeResponse(
        "debug/sentry-canary returned 500 to an unauth request — the admin gate is broken",
        r,
      ),
    ).toBeLessThan(500);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 14 — Rate limit on invite creation
// ────────────────────────────────────────────────────────────────────────
test.describe("rate-limits", () => {
  test("[rate-limit-invite] POST /api/instance/invites eventually 429s", async ({
    api,
    profile,
  }) => {
    requireAuthed(profile, "rate-limit-invite");

    // Fire 25 requests in series (the limiter window is 1hr / 20 req). Even
    // if the first few return 400 (bad actor / validation) we'll still trip
    // the limiter since express-rate-limit counts every request to the path.
    let lastStatus = 0;
    let observed429 = false;
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      const r = await api.post("/api/instance/invites", {
        email: `e2e-23a-${i}-${Date.now()}@founderos.test`,
        role: "instance_member",
      });
      statuses.push(r.status);
      lastStatus = r.status;
      if (r.status === 429) {
        observed429 = true;
        break;
      }
    }
    expect(
      observed429,
      `Hit /api/instance/invites 25x and never got 429. ` +
        `Last status=${lastStatus}, all statuses=[${statuses.join(", ")}]. ` +
        `Either the rate limiter regressed or authn blocks the request before ` +
        `the limiter increments its counter (check middleware order in server/src/app.ts).`,
    ).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 15 — Static UI assets: MIME + cache-control
// ────────────────────────────────────────────────────────────────────────
test.describe("static-assets", () => {
  test("[static-assets] main HTML + JS bundle headers are sane", async ({ api, page }) => {
    // Hit the root once to let the server emit the HTML and embed bundle
    // references we can inspect.
    const root = await api.get("/");
    expect(
      root.status,
      describeResponse("GET / did not return 200 for HTML", root),
    ).toBe(200);
    const ct = root.headers["content-type"] || "";
    expect(
      ct.includes("text/html"),
      `GET / content-type is '${ct}' — expected text/html`,
    ).toBe(true);

    // Find the first script src in the HTML. Vite emits /assets/*.js in
    // prod builds and /@vite/client in dev. Both are acceptable.
    const scriptMatch = root.text.match(
      /<script[^>]+src=["']([^"']+\.(?:js|mjs|tsx|ts))["']/i,
    );
    if (!scriptMatch) {
      // Dev server with ESM imports may not embed a src — skip rather than
      // false-fail in that environment.
      test.skip(true, "no <script src=...> found in HTML — likely ESM dev server");
      return;
    }
    const scriptPath = scriptMatch[1];
    const asset = await api.get(scriptPath);
    expect(
      asset.status,
      describeResponse(`GET ${scriptPath} did not return 200`, asset),
    ).toBe(200);
    const assetCt = asset.headers["content-type"] || "";
    expect(
      /javascript|ecmascript|text\/jsx/i.test(assetCt),
      `Asset ${scriptPath} has MIME '${assetCt}' — expected a JS-ish MIME`,
    ).toBe(true);

    // Cache-control: prod builds use content-hashed filenames and should set
    // a long immutable max-age. Dev builds typically set no-cache. We only
    // assert the HEADER EXISTS — specific values vary across Vercel / Fly
    // / local.
    const cc = asset.headers["cache-control"];
    expect(
      typeof cc === "string" && cc.length > 0,
      `Asset ${scriptPath} missing Cache-Control header (got: ${cc ?? "undefined"})`,
    ).toBe(true);
  });
});
