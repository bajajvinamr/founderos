/**
 * Loop 2 L2-D03 — Landing + Health public smoke.
 *
 * Purpose
 * -------
 * Asserts the public surfaces a deploy probe (Fly health gate, synthetic
 * monitor, smoke runner) depends on actually return the expected shape:
 *
 *   1. GET /                         → 200 + SPA shell with the FounderOS <title>
 *   2. GET /api/health               → 200 + {status, version} ONLY (no extras)
 *   3. GET /api/health/bootstrap-state → 200 + the 4 pre-signin fields
 *   4. GET /api/readyz               → 200 + body "ready" (text/plain)
 *
 * Why
 * ---
 * Two regression risks this guards:
 *
 *   a) Task #139 (commit cc1d891, 2026-05-06) narrowed `/api/health` ROOT to
 *      `{status, version}` ONLY — moved `deploymentMode/authReady/
 *      bootstrapStatus/bootstrapInviteActive` to public
 *      `/api/health/bootstrap-state` and `deploymentExposure/features/
 *      devServer` to admin-gated `/api/health/diagnostics`. The exact-keys
 *      assertion below catches any future refactor that re-adds fields to
 *      the liveness probe (recon-surface regression).
 *
 *   b) `/api/readyz` is the Fly health-gate contract (public, 200 "ready").
 *      A change to the body shape or status code silently breaks deploys.
 *
 * Profile
 * -------
 * Public-only. Runs against any deployed origin without auth state. Defaults
 * to https://founderos.fly.dev; override via FOUNDEROS_E2E_BASE_URL.
 *
 * Relationship to critical-flows.spec.ts
 * --------------------------------------
 * critical-flows.spec.ts has [health] / [bootstrap-state] tests that assert
 * the post-#139 fields moved correctly. This spec is the STRICTER complement:
 * it asserts /api/health ROOT has EXACTLY {status, version} keys and nothing
 * else, plus adds the /api/readyz contract and the / HTML-shell smoke. Both
 * specs co-exist by design — defense in depth on the recon-surface guarantee.
 */
import { describeResponse, expect, test } from "../fixtures";

const HEALTH_ROOT_ALLOWED_KEYS = new Set(["status", "version"]);

const BOOTSTRAP_STATE_REQUIRED_KEYS = [
  "deploymentMode",
  "authReady",
  "bootstrapStatus",
  "bootstrapInviteActive",
] as const;

test.describe("[L2-D03] public landing + health smoke", () => {
  test("[landing-root] GET / serves the SPA shell with FounderOS title", async ({
    page,
  }) => {
    const response = await page.goto("/", { waitUntil: "domcontentloaded" });
    expect(
      response,
      "GET / returned nothing (network error against base URL?)",
    ).not.toBeNull();
    const status = response!.status();
    // Tolerate 200 + 3xx — Fly may 304 a cached shell, the SPA may 301-redirect
    // /landing depending on deploymentMode (authenticated-mode → / redirects
    // unauth users to /landing). 4xx/5xx is a real failure.
    expect(
      status >= 200 && status < 400,
      `GET / returned HTTP ${status} (expected 2xx/3xx)`,
    ).toBe(true);

    // The Vite-built `ui/index.html` ships a hardcoded <title> tag in the
    // document head. It is rendered server-side via static export and is
    // present BEFORE React hydrates — so we don't need to wait for React.
    const title = await page.title();
    expect(
      title,
      `GET / served an empty <title>. The Vite static build should ship a ` +
        `non-empty title from ui/index.html. Current document.title: ${JSON.stringify(title)}`,
    ).not.toBe("");
    expect(
      /founderos/i.test(title),
      `GET / served unexpected <title>: ${JSON.stringify(title)} ` +
        `(expected to contain "FounderOS"). Check ui/index.html.`,
    ).toBe(true);

    // The SPA's #root mount point must exist in the served HTML — if it's
    // missing, Vite's static build is broken or we hit a non-SPA host.
    const html = await page.content();
    expect(
      /<div\s+id=["']root["']/i.test(html),
      `GET / response is missing the #root mount node — ui/index.html should ` +
        `ship <div id="root">. Bad host or broken static build.`,
    ).toBe(true);
  });

  test("[health-root-shape] GET /api/health returns EXACTLY {status, version} (task #139)", async ({
    api,
  }) => {
    const r = await api.get("/api/health");
    expect(
      r.status,
      describeResponse("GET /api/health did not return 200", r),
    ).toBe(200);

    const body = r.json as Record<string, unknown> | null;
    expect(
      body,
      describeResponse("GET /api/health returned non-JSON body", r),
    ).not.toBeNull();
    expect(
      typeof body!.status,
      describeResponse(
        "GET /api/health response.status is not a string",
        r,
      ),
    ).toBe("string");
    expect(
      body!.status === "ok",
      describeResponse(
        `GET /api/health response.status is not "ok" (got ${JSON.stringify(body!.status)})`,
        r,
      ),
    ).toBe(true);
    expect(
      typeof body!.version,
      describeResponse(
        "GET /api/health response.version is not a string",
        r,
      ),
    ).toBe("string");
    expect(
      (body!.version as string).length > 0,
      describeResponse(
        "GET /api/health response.version is empty",
        r,
      ),
    ).toBe(true);

    // STRICT shape check — Task #139's whole point is that this endpoint
    // does NOT leak operational metadata to unauth recon. Any extra key
    // (`deploymentMode`, `authReady`, `bootstrapStatus`, `features`, etc.)
    // is a regression that needs to move to /bootstrap-state or /diagnostics.
    const actualKeys = Object.keys(body!).sort();
    const extras = actualKeys.filter(
      (k) => !HEALTH_ROOT_ALLOWED_KEYS.has(k),
    );
    expect(
      extras.length === 0,
      describeResponse(
        `GET /api/health leaked unexpected keys: [${extras.join(", ")}]. ` +
          `Task #139 (commit cc1d891) narrowed this endpoint to ` +
          `{status, version} ONLY. Any new operational field belongs in ` +
          `/api/health/bootstrap-state (public, pre-signin metadata) or ` +
          `/api/health/diagnostics (admin-gated, ops metadata).`,
        r,
      ),
    ).toBe(true);
  });

  test("[bootstrap-state-shape] GET /api/health/bootstrap-state returns the 4 pre-signin fields", async ({
    api,
  }) => {
    const r = await api.get("/api/health/bootstrap-state");
    expect(
      r.status,
      describeResponse(
        "GET /api/health/bootstrap-state did not return 200",
        r,
      ),
    ).toBe(200);

    const body = r.json as Record<string, unknown> | null;
    expect(
      body,
      describeResponse(
        "GET /api/health/bootstrap-state returned non-JSON body",
        r,
      ),
    ).not.toBeNull();

    for (const key of BOOTSTRAP_STATE_REQUIRED_KEYS) {
      expect(
        key in body!,
        describeResponse(
          `GET /api/health/bootstrap-state missing required key "${key}". ` +
            `Task #139 contract: this endpoint must expose ` +
            `${BOOTSTRAP_STATE_REQUIRED_KEYS.join(", ")} so the unauth UI can ` +
            `decide signup-vs-login-vs-bootstrap-pending.`,
          r,
        ),
      ).toBe(true);
    }

    // Type-shape sanity — these power UI routing decisions in
    // CloudAccessGate, so a silent type drift (e.g. `authReady: "true"`
    // instead of boolean) would silently break the gate.
    expect(
      typeof body!.deploymentMode === "string",
      describeResponse("bootstrap-state.deploymentMode is not a string", r),
    ).toBe(true);
    expect(
      typeof body!.authReady === "boolean",
      describeResponse("bootstrap-state.authReady is not a boolean", r),
    ).toBe(true);
    expect(
      typeof body!.bootstrapStatus === "string",
      describeResponse("bootstrap-state.bootstrapStatus is not a string", r),
    ).toBe(true);
    expect(
      typeof body!.bootstrapInviteActive === "boolean",
      describeResponse(
        "bootstrap-state.bootstrapInviteActive is not a boolean",
        r,
      ),
    ).toBe(true);
  });

  test("[readyz-contract] GET /api/readyz returns 200 with body \"ready\"", async ({
    api,
  }) => {
    const r = await api.get("/api/readyz");
    expect(
      r.status,
      describeResponse(
        "GET /api/readyz did not return 200 — this breaks the Fly health gate " +
          "(fly.toml [[services.http_checks]])",
        r,
      ),
    ).toBe(200);

    // text/plain body, exact "ready" — see server/src/app.ts:330. The Fly
    // probe doesn't check the body, but the synthetic monitor and any future
    // grpc-style smoke runner will, so we lock the contract here.
    expect(
      r.text.trim() === "ready",
      describeResponse(
        `GET /api/readyz body is not exactly "ready" — found ` +
          `${JSON.stringify(r.text.slice(0, 100))}. See server/src/app.ts:314.`,
        r,
      ),
    ).toBe(true);

    // Soft check: content-type should be text/plain. Don't hard-fail on
    // charset variation ("text/plain" vs "text/plain; charset=utf-8") —
    // both are valid.
    const ct = r.headers["content-type"] || "";
    expect(
      /text\/plain/i.test(ct),
      `GET /api/readyz content-type is not text/plain (got "${ct}"). ` +
        `Express's res.type("text/plain") at app.ts:316 should set this.`,
    ).toBe(true);
  });
});
