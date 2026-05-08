/**
 * provider-validate-key.test.ts — coverage for the
 * /api/providers/validate-key endpoint (S7.A.6) and its underlying
 * multi-provider validator.
 *
 * Six base cases × 3 providers (anthropic, openai, google) × {valid,
 * invalid} + timeout + provider-rate-limit + invalid payload + endpoint
 * rate-limit + key-reference hash invariants.
 *
 * NO real network calls — `global.fetch` is mocked per case. The route
 * is mounted onto a minimal Express app with the request-id middleware
 * so the `requestId` invariant on every JSON error body can be asserted.
 */

import express from "express";
import request from "supertest";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { providerRoutes } from "../routes/providers.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import { errorHandler } from "../middleware/error-handler.js";
import {
  keyReferenceHash,
  validateProviderKey,
} from "../lib/provider-key-validator.js";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function buildApp() {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use(providerRoutes({} as never));
  app.use(errorHandler);
  return app;
}

// Generate a unique IP per test so the IP-based rate limiter (which has
// module-scoped state) doesn't poison sibling tests.
let nextIp = 0;
function freshIp(): string {
  nextIp += 1;
  // 198.51.100.0/24 is the TEST-NET-2 range — guaranteed non-routable.
  return `198.51.100.${nextIp % 250}`;
}

// ---------------------------------------------------------------------------
// Validator unit tests (mock global.fetch)
// ---------------------------------------------------------------------------

describe("validateProviderKey — unit", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("anthropic", () => {
    it("returns valid:true on 200", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
      const result = await validateProviderKey("anthropic", "sk-ant-valid");
      expect(result.valid).toBe(true);
    });

    it("returns invalid_key on 401", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 401 }));
      const result = await validateProviderKey("anthropic", "sk-ant-bad");
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("invalid_key");
    });
  });

  describe("openai", () => {
    it("returns valid:true on 200 and uses Bearer auth", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
      const result = await validateProviderKey("openai", "sk-openai-valid");
      expect(result.valid).toBe(true);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(String(url)).toBe("https://api.openai.com/v1/models");
      const headers = (init as { headers: Record<string, string> }).headers;
      expect(headers.Authorization).toBe("Bearer sk-openai-valid");
    });

    it("returns invalid_key on 401", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 401 }));
      const result = await validateProviderKey("openai", "sk-openai-bad");
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("invalid_key");
      expect(result.upstreamStatus).toBe(401);
    });

    it("returns rate_limited with retryAfter on 429", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: { "retry-after": "30" },
        }),
      );
      const result = await validateProviderKey("openai", "sk-openai-throttle");
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("rate_limited");
      expect(result.retryAfter).toBe(30);
    });

    it("returns timeout on AbortError", async () => {
      const abortError = new Error("Aborted");
      abortError.name = "AbortError";
      fetchSpy.mockRejectedValueOnce(abortError);
      const result = await validateProviderKey("openai", "sk-openai-slow");
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("timeout");
    });

    it("returns network_error on fetch rejection", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("ECONNRESET"));
      const result = await validateProviderKey("openai", "sk-openai-net");
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("network_error");
    });

    it("returns empty_key on whitespace-only input", async () => {
      const result = await validateProviderKey("openai", "   ");
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("empty_key");
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("google", () => {
    it("returns valid:true on 200 and passes key in querystring", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
      const result = await validateProviderKey("google", "google-valid-key");
      expect(result.valid).toBe(true);
      const [url] = fetchSpy.mock.calls[0];
      const u = new URL(String(url));
      expect(u.origin + u.pathname).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models",
      );
      expect(u.searchParams.get("key")).toBe("google-valid-key");
    });

    it("returns invalid_key on 400 (Google's bad-key signal)", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 400 }));
      const result = await validateProviderKey("google", "google-bad");
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("invalid_key");
      expect(result.upstreamStatus).toBe(400);
    });

    it("returns permission_denied on 403", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 403 }));
      const result = await validateProviderKey("google", "google-revoked");
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("permission_denied");
    });
  });

  it("does NOT log the raw key — keyReferenceHash is the only reference", () => {
    const ref = keyReferenceHash("sk-ant-secretvalue");
    expect(ref).toHaveLength(12);
    expect(ref).not.toContain("secretvalue");
    // Stable across calls.
    expect(keyReferenceHash("sk-ant-secretvalue")).toBe(ref);
    // Differs across keys.
    expect(keyReferenceHash("sk-ant-other")).not.toBe(ref);
    // Empty key has a stable sentinel — never the empty string (would
    // otherwise look like a missing log field).
    expect(keyReferenceHash("")).toBe("empty");
    expect(keyReferenceHash("   ")).toBe("empty");
  });
});

// ---------------------------------------------------------------------------
// Endpoint integration tests
// ---------------------------------------------------------------------------

describe("POST /api/providers/validate-key — endpoint contract", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 { valid: true } on a valid Anthropic key", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const app = buildApp();
    const res = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", freshIp())
      .send({ provider: "anthropic", apiKey: "sk-ant-valid-12345" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true });
  });

  it("returns 200 { valid: true } on a valid OpenAI key", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const app = buildApp();
    const res = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", freshIp())
      .send({ provider: "openai", apiKey: "sk-openai-valid" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true });
  });

  it("returns 200 { valid: true } on a valid Google key", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const app = buildApp();
    const res = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", freshIp())
      .send({ provider: "google", apiKey: "google-valid-key" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true });
  });

  it("returns 401 invalid_key with requestId for Anthropic 401 (no distinguishing reason)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const app = buildApp();
    const res = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", freshIp())
      .send({ provider: "anthropic", apiKey: "sk-ant-invalid" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_key");
    // S7.A.6 council 2026-05-08 P3: 401 body MUST NOT include `reason` —
    // distinguishing "invalid_key" from "permission_denied" triages stolen
    // keys for an attacker. Both upstream signals collapse to a single
    // public 401 invalid_key.
    expect(res.body.reason).toBeUndefined();
    expect(res.body.requestId).toEqual(expect.any(String));
    expect(res.body.requestId.length).toBeGreaterThan(0);
  });

  it("returns 401 invalid_key (no reason) for Anthropic 403 permission_denied — must NOT distinguish from 401", async () => {
    // S7.A.6 council 2026-05-08 P3: prove the collapse — same public 401
    // invalid_key shape regardless of whether upstream returned 401 or 403.
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 403 }));
    const app = buildApp();
    const res = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", freshIp())
      .send({ provider: "anthropic", apiKey: "sk-ant-no-perm" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_key");
    expect(res.body.reason).toBeUndefined();
    expect(res.body.requestId).toEqual(expect.any(String));
  });

  it("returns 429 provider_rate_limit when Anthropic upstream 429s (was falling to 500 before P2 fix)", async () => {
    // S7.A.6 council 2026-05-08 P2: pre-fix, Anthropic returned reason
    // "http_error_429" which fell through to the 500 validation_failed
    // branch instead of the 429 provider_rate_limit branch.
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 429,
        headers: { "retry-after": "17" },
      }),
    );
    const app = buildApp();
    const res = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", freshIp())
      .send({ provider: "anthropic", apiKey: "sk-ant-throttle" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("provider_rate_limit");
    expect(res.body.retryAfter).toBe(17);
    expect(res.body.requestId).toEqual(expect.any(String));
  });

  it("returns 401 invalid_key with requestId for OpenAI 401", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const app = buildApp();
    const res = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", freshIp())
      .send({ provider: "openai", apiKey: "sk-openai-bad" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_key");
    expect(res.body.requestId).toEqual(expect.any(String));
  });

  it("returns 401 invalid_key with requestId for Google 400 (bad-key signal)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 400 }));
    const app = buildApp();
    const res = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", freshIp())
      .send({ provider: "google", apiKey: "google-bad" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_key");
    expect(res.body.requestId).toEqual(expect.any(String));
  });

  it("returns 429 provider_rate_limit with retryAfter when upstream 429s", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 429,
        headers: { "retry-after": "42" },
      }),
    );
    const app = buildApp();
    const res = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", freshIp())
      .send({ provider: "openai", apiKey: "sk-openai-throttle" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("provider_rate_limit");
    expect(res.body.retryAfter).toBe(42);
    expect(res.body.requestId).toEqual(expect.any(String));
  });

  it("returns 500 validation_failed with reason=timeout on upstream timeout", async () => {
    const abortError = new Error("Aborted");
    abortError.name = "AbortError";
    fetchSpy.mockRejectedValueOnce(abortError);
    const app = buildApp();
    const res = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", freshIp())
      .send({ provider: "anthropic", apiKey: "sk-ant-slow" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("validation_failed");
    expect(res.body.reason).toBe("timeout");
    expect(res.body.requestId).toEqual(expect.any(String));
  });

  it("returns 500 validation_failed with reason=network_error on fetch rejection", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNRESET"));
    const app = buildApp();
    const res = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", freshIp())
      .send({ provider: "openai", apiKey: "sk-openai-net" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("validation_failed");
    expect(res.body.reason).toBe("network_error");
    expect(res.body.requestId).toEqual(expect.any(String));
  });

  it("returns 400 invalid_payload with requestId for malformed body (missing provider)", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", freshIp())
      .send({ apiKey: "sk-anything" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_payload");
    expect(res.body.requestId).toEqual(expect.any(String));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_payload for unknown provider", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", freshIp())
      .send({ provider: "cohere", apiKey: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_payload");
    expect(res.body.requestId).toEqual(expect.any(String));
  });

  it("returns 400 invalid_payload for over-sized apiKey (form-paste defense)", async () => {
    const app = buildApp();
    const huge = "x".repeat(501);
    const res = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", freshIp())
      .send({ provider: "anthropic", apiKey: huge });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_payload");
  });

  it("does NOT include the raw apiKey in any response field", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const app = buildApp();
    const apiKey = "sk-ant-leak-canary-XYZ";
    const res = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", freshIp())
      .send({ provider: "anthropic", apiKey });
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain(apiKey);
    expect(serialised).not.toContain("leak-canary");
  });
});

// ---------------------------------------------------------------------------
// Endpoint rate-limit (10 / 5min / IP)
// ---------------------------------------------------------------------------

describe("POST /api/providers/validate-key — endpoint rate limit (10/5min/IP)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows up to 10 attempts from one IP within 5 minutes", async () => {
    const app = buildApp();
    const ip = freshIp();
    for (let i = 0; i < 10; i += 1) {
      const res = await request(app)
        .post("/providers/validate-key")
        .set("X-Forwarded-For", ip)
        .send({ provider: "anthropic", apiKey: `sk-ant-${i}` });
      expect(res.status, `req ${i + 1}`).toBe(200);
    }
  });

  it("returns 429 rate_limit_exceeded on the 11th attempt from the same IP", async () => {
    const app = buildApp();
    const ip = freshIp();
    for (let i = 0; i < 10; i += 1) {
      await request(app)
        .post("/providers/validate-key")
        .set("X-Forwarded-For", ip)
        .send({ provider: "anthropic", apiKey: `sk-ant-${i}` });
    }
    const blocked = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", ip)
      .send({ provider: "anthropic", apiKey: "sk-ant-11" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("rate_limit_exceeded");
    // S7.A.6 council 2026-05-08 P3: rate-limit-exceeded body MUST include
    // requestId so support can correlate user-reported 429s with fly logs.
    expect(blocked.body.requestId).toEqual(expect.any(String));
    expect(blocked.body.requestId.length).toBeGreaterThan(0);
  });

  it("does NOT bleed between distinct IPs", async () => {
    const app = buildApp();
    const ipA = freshIp();
    const ipB = freshIp();
    for (let i = 0; i < 10; i += 1) {
      await request(app)
        .post("/providers/validate-key")
        .set("X-Forwarded-For", ipA)
        .send({ provider: "anthropic", apiKey: `sk-ant-A-${i}` });
    }
    // ipA is now exhausted; ipB should still be allowed.
    const res = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", ipB)
      .send({ provider: "anthropic", apiKey: "sk-ant-B" });
    expect(res.status).toBe(200);
  });
});
