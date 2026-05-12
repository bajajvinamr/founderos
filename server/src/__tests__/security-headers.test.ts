/**
 * security-headers.test.ts — verifies the baseline security headers fire
 * on every response branch (success, 4xx, 5xx), and that CSP includes
 * the required allowlisted hosts.
 *
 * The failing-branch case is the council BLOCK signal: a CSP that only
 * appears on 200s would still let an XSS-loaded inline script into a
 * 404 page (which is just as effective as a 200 for stealing tokens).
 */

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  buildContentSecurityPolicy,
  securityHeadersMiddleware,
} from "../middleware/security-headers.js";

function makeApp(opts: { supabaseUrl?: string | null } = {}) {
  const app = express();
  app.use(securityHeadersMiddleware({ supabaseUrl: opts.supabaseUrl }));
  app.get("/ok", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/notfound", (_req, res) => res.status(404).json({ error: "nope" }));
  app.get("/throw", (_req, _res, next) => next(new Error("boom")));
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

describe("buildContentSecurityPolicy", () => {
  it("includes self + Stripe + Supabase + Sentry + Anthropic + Composio", () => {
    const csp = buildContentSecurityPolicy({
      supabaseUrl: "https://ggspsiexqppduvsqvpgy.supabase.co",
    });
    // default-src locked to self
    expect(csp).toMatch(/default-src 'self'/);
    // connect-src must reach all five external categories
    expect(csp).toMatch(/connect-src[^;]*'self'/);
    expect(csp).toMatch(/connect-src[^;]*supabase\.co/);
    expect(csp).toMatch(/connect-src[^;]*composio\.dev/);
    expect(csp).toMatch(/connect-src[^;]*ingest\.sentry\.io/);
    expect(csp).toMatch(/connect-src[^;]*api\.anthropic\.com/);
    expect(csp).toMatch(/connect-src[^;]*api\.stripe\.com/);
    // ws:/wss: present so realtime channels work without per-host pinning
    expect(csp).toMatch(/connect-src[^;]*wss:/);
    // Stripe.js loadable
    expect(csp).toMatch(/script-src[^;]*js\.stripe\.com/);
    // Stripe Checkout iframe
    expect(csp).toMatch(/frame-src[^;]*js\.stripe\.com/);
    // No clickjacking — ancestors none + frame-options DENY
    expect(csp).toMatch(/frame-ancestors 'none'/);
    // Object/embed locked off entirely
    expect(csp).toMatch(/object-src 'none'/);
  });

  it("allows Google Fonts stylesheet (style-src) + woff2 (font-src) — L2-F04", () => {
    const csp = buildContentSecurityPolicy({});
    // ui/index.html loads the Inter/Instrument Serif/Fraunces/JetBrains Mono
    // stylesheet from fonts.googleapis.com; without this entry the request
    // is CSP-blocked and the page silently degrades to system fonts.
    expect(csp).toMatch(/style-src[^;]*fonts\.googleapis\.com/);
    // Google Fonts loads woff2 files from fonts.gstatic.com (separate origin
    // from the stylesheet) — both must be allowlisted.
    expect(csp).toMatch(/font-src[^;]*fonts\.gstatic\.com/);
    // Make sure we didn't open up style-src or font-src wildcards.
    expect(csp).not.toMatch(/style-src[^;]*\bhttps:\s/);
    expect(csp).not.toMatch(/font-src[^;]*\bhttps:\s/);
  });

  it("pins the exact Supabase project host when provided", () => {
    const csp = buildContentSecurityPolicy({
      supabaseUrl: "https://ggspsiexqppduvsqvpgy.supabase.co",
    });
    expect(csp).toContain("https://ggspsiexqppduvsqvpgy.supabase.co");
    expect(csp).toContain("wss://ggspsiexqppduvsqvpgy.supabase.co");
  });

  it("drops the exact-host pin when supabaseUrl is unset", () => {
    const csp = buildContentSecurityPolicy({});
    // Wildcard still present for future projects.
    expect(csp).toContain("https://*.supabase.co");
    // No specific project host pinned.
    expect(csp).not.toMatch(/[a-z]{20}\.supabase\.co/);
  });
});

describe("securityHeadersMiddleware", () => {
  it("emits all baseline headers on a 200 response", async () => {
    const app = makeApp({ supabaseUrl: "https://test.supabase.co" });
    const res = await request(app).get("/ok");
    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toBeTruthy();
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(res.headers["strict-transport-security"]).toContain("max-age=31536000");
    expect(res.headers["permissions-policy"]).toContain("camera=()");
  });

  it("emits the same headers on a 404 — no CSP gap on missing routes", async () => {
    const app = makeApp({});
    const res = await request(app).get("/notfound");
    expect(res.status).toBe(404);
    expect(res.headers["content-security-policy"]).toBeTruthy();
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });

  it("emits the same headers on a 500 from a throwing handler", async () => {
    const app = makeApp({});
    const res = await request(app).get("/throw");
    expect(res.status).toBe(500);
    expect(res.headers["content-security-policy"]).toBeTruthy();
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });

  it("omits CSP entirely when disableCsp is true (other headers still fire)", async () => {
    const app = express();
    app.use(securityHeadersMiddleware({ disableCsp: true }));
    app.get("/ok", (_req, res) => res.status(200).json({ ok: true }));
    const res = await request(app).get("/ok");
    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toBeUndefined();
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
