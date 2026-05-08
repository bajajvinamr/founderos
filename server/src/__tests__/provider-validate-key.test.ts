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
import {
  __resetConsumedNoncesForTests,
  issueNonce,
} from "../lib/validate-nonce.js";

/**
 * Issue a fresh single-use nonce for an endpoint test. Each call MUST be
 * used at most once — `consumeNonce` enforces this in the route handler,
 * so test loops that hit the route N times must call this N times.
 */
function freshNonce(): string {
  return issueNonce().nonce;
}

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
    it("returns valid:true on 200 and passes key in x-goog-api-key header (NOT querystring — P2 fix)", async () => {
      // S7.A.6 council 2026-05-08 P2 (URL-leak footgun): the key MUST be
      // in the x-goog-api-key header, not the URL querystring. This test
      // is the regression lock against any future revert that puts the
      // key back in the URL.
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
      const result = await validateProviderKey("google", "google-valid-key");
      expect(result.valid).toBe(true);
      const [url, init] = fetchSpy.mock.calls[0];
      const u = new URL(String(url));
      expect(u.origin + u.pathname).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models",
      );
      // Querystring must NOT contain the key.
      expect(u.searchParams.get("key")).toBeNull();
      expect(u.search).toBe("");
      // Header must carry the raw key.
      const headers = (init as RequestInit | undefined)?.headers as
        | Record<string, string>
        | undefined;
      expect(headers).toBeDefined();
      expect(headers!["x-goog-api-key"]).toBe("google-valid-key");
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
    __resetConsumedNoncesForTests();
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
      .send({ provider: "anthropic", apiKey: "sk-ant-valid-12345", nonce: freshNonce() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true });
  });

  it("returns 200 { valid: true } on a valid OpenAI key", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const app = buildApp();
    const res = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", freshIp())
      .send({ provider: "openai", apiKey: "sk-openai-valid", nonce: freshNonce() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true });
  });

  it("returns 200 { valid: true } on a valid Google key", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const app = buildApp();
    const res = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", freshIp())
      .send({ provider: "google", apiKey: "google-valid-key", nonce: freshNonce() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true });
  });

  it("returns 401 invalid_key with requestId for Anthropic 401 (no distinguishing reason)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const app = buildApp();
    const res = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", freshIp())
      .send({ provider: "anthropic", apiKey: "sk-ant-invalid", nonce: freshNonce() });
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
      .send({ provider: "anthropic", apiKey: "sk-ant-no-perm", nonce: freshNonce() });
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
      .send({ provider: "anthropic", apiKey: "sk-ant-throttle", nonce: freshNonce() });
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
      .send({ provider: "openai", apiKey: "sk-openai-bad", nonce: freshNonce() });
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
      .send({ provider: "google", apiKey: "google-bad", nonce: freshNonce() });
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
      .send({ provider: "openai", apiKey: "sk-openai-throttle", nonce: freshNonce() });
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
      .send({ provider: "anthropic", apiKey: "sk-ant-slow", nonce: freshNonce() });
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
      .send({ provider: "openai", apiKey: "sk-openai-net", nonce: freshNonce() });
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
      .send({ provider: "cohere", apiKey: "x", nonce: freshNonce() });
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
      .send({ provider: "anthropic", apiKey: huge, nonce: freshNonce() });
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
      .send({ provider: "anthropic", apiKey, nonce: freshNonce() });
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
    __resetConsumedNoncesForTests();
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
        .send({ provider: "anthropic", apiKey: `sk-ant-${i}`, nonce: freshNonce() });
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
        .send({ provider: "anthropic", apiKey: `sk-ant-${i}`, nonce: freshNonce() });
    }
    const blocked = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", ip)
      .send({ provider: "anthropic", apiKey: "sk-ant-11", nonce: freshNonce() });
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
        .send({ provider: "anthropic", apiKey: `sk-ant-A-${i}`, nonce: freshNonce() });
    }
    // ipA is now exhausted; ipB should still be allowed.
    const res = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", ipB)
      .send({ provider: "anthropic", apiKey: "sk-ant-B", nonce: freshNonce() });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Nonce primitive (S7.A.6 council 2026-05-08 P1: IP-rotation defense)
// ---------------------------------------------------------------------------

describe("GET /api/providers/issue-nonce + single-use semantics", () => {
  beforeEach(() => {
    __resetConsumedNoncesForTests();
  });

  it("issues a wire-format nonce with expiresAt ~60s ahead", async () => {
    const app = buildApp();
    const before = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .get("/providers/issue-nonce")
      .set("X-Forwarded-For", freshIp());
    expect(res.status).toBe(200);
    expect(typeof res.body.nonce).toBe("string");
    const parts = res.body.nonce.split(".");
    expect(parts).toHaveLength(3);
    const [exp, random, hmac] = parts;
    expect(Number(exp)).toBeGreaterThanOrEqual(before + 50);
    expect(Number(exp)).toBeLessThanOrEqual(before + 70);
    expect(random).toMatch(/^[0-9a-f]{32}$/);
    expect(hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.expiresAt).toBe(Number(exp));
  });

  it("validate-key REJECTS a request with no nonce field (400 invalid_payload)", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", freshIp())
      .send({ provider: "anthropic", apiKey: "sk-ant-no-nonce" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_payload");
  });

  it("validate-key REJECTS a malformed nonce (400 invalid_payload, reason: invalid_nonce)", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));
    const app = buildApp();
    const res = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", freshIp())
      .send({ provider: "anthropic", apiKey: "sk-ant-x", nonce: "not-a-valid-nonce" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_payload");
    expect(res.body.reason).toBe("invalid_nonce");
    // Critical: the upstream fetch MUST NOT have been called — nonce
    // verification fires before any provider request.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("validate-key REJECTS a tampered-HMAC nonce", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));
    const app = buildApp();
    const goodNonce = freshNonce();
    const parts = goodNonce.split(".");
    // Flip one hex char in the HMAC.
    const tamperedHmac =
      parts[2].slice(0, -1) + (parts[2].slice(-1) === "0" ? "1" : "0");
    const tampered = `${parts[0]}.${parts[1]}.${tamperedHmac}`;
    const res = await request(app)
      .post("/providers/validate-key")
      .set("X-Forwarded-For", freshIp())
      .send({ provider: "anthropic", apiKey: "sk-ant-x", nonce: tampered });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_payload");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("validate-key consumes a nonce single-use (second call with same nonce fails 400)", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const app = buildApp();
    const nonce = freshNonce();
    const send = (ip: string) =>
      request(app)
        .post("/providers/validate-key")
        .set("X-Forwarded-For", ip)
        .send({ provider: "anthropic", apiKey: "sk-ant-x", nonce });
    const first = await send(freshIp());
    expect(first.status).toBe(200);
    const second = await send(freshIp());
    expect(second.status).toBe(400);
    expect(second.body.error).toBe("invalid_payload");
    expect(second.body.reason).toBe("invalid_nonce");
    fetchSpy.mockRestore();
  });

  it("issue-nonce is rate-limited at 5/min/IP (6th call returns 429 with requestId)", async () => {
    const app = buildApp();
    const ip = freshIp();
    for (let i = 0; i < 5; i += 1) {
      const r = await request(app).get("/providers/issue-nonce").set("X-Forwarded-For", ip);
      expect(r.status, `nonce req ${i + 1}`).toBe(200);
    }
    const blocked = await request(app)
      .get("/providers/issue-nonce")
      .set("X-Forwarded-For", ip);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("rate_limit_exceeded");
    expect(blocked.body.requestId).toEqual(expect.any(String));
  });
});
