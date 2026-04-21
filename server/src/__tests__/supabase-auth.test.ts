import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { createHmac } from "node:crypto";
import type { Request } from "express";
import {
  createSupabaseAuth,
  extractSupabaseUserFromClaims,
  extractSupabaseUserFromWebhook,
  isSupabaseConfigured,
  resolveSupabaseSession,
  verifySupabaseJwt,
  verifySupabaseWebhookSignature,
} from "../auth/supabase.js";

const TEST_SECRET = "super-secret-supabase-jwt-signing-key-that-is-long-enough";
const TEST_PROJECT_URL = "https://abcd1234.supabase.co";
const TEST_ISSUER = `${TEST_PROJECT_URL}/auth/v1`;
const TEST_USER_ID = "3b3c4f4e-aaaa-bbbb-cccc-000000000001";

async function signTestToken(opts: {
  sub?: string;
  email?: string;
  userMetadata?: Record<string, unknown>;
  appMetadata?: Record<string, unknown>;
  issuer?: string | null;
  audience?: string | null;
  expiresInSeconds?: number;
  secret?: string;
}): Promise<string> {
  const secret = new TextEncoder().encode(opts.secret ?? TEST_SECRET);
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = opts.expiresInSeconds ?? 3600;

  const payload: Record<string, unknown> = {
    sub: opts.sub ?? TEST_USER_ID,
    email: opts.email ?? "alice@example.com",
    user_metadata: opts.userMetadata ?? { full_name: "Alice Example" },
    app_metadata: opts.appMetadata ?? { provider: "email" },
  };

  const builder = new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn);

  const audience = opts.audience === null ? undefined : (opts.audience ?? "authenticated");
  if (audience) builder.setAudience(audience);

  const issuer = opts.issuer === null ? undefined : (opts.issuer ?? TEST_ISSUER);
  if (issuer) builder.setIssuer(issuer);

  return builder.sign(secret);
}

describe("supabase auth - JWT verification", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a valid JWT and extracts user shape", async () => {
    const auth = createSupabaseAuth({ jwtSecret: TEST_SECRET, url: TEST_PROJECT_URL });
    const token = await signTestToken({});

    const result = await verifySupabaseJwt(auth, token);

    expect(result).not.toBeNull();
    expect(result?.session).toEqual({
      id: `supabase:${TEST_USER_ID}`,
      userId: TEST_USER_ID,
    });
    expect(result?.user).toEqual({
      id: TEST_USER_ID,
      email: "alice@example.com",
      name: "Alice Example",
    });
  });

  it("prefers user_metadata.name over full_name when both are present", async () => {
    const auth = createSupabaseAuth({ jwtSecret: TEST_SECRET, url: TEST_PROJECT_URL });
    const token = await signTestToken({
      userMetadata: { name: "Primary Name", full_name: "Full Name Ignored" },
    });

    const result = await verifySupabaseJwt(auth, token);
    expect(result?.user?.name).toBe("Primary Name");
  });

  it("rejects an expired JWT", async () => {
    const auth = createSupabaseAuth({ jwtSecret: TEST_SECRET, url: TEST_PROJECT_URL });
    const token = await signTestToken({ expiresInSeconds: 60 });

    // Fast-forward past the expiration.
    vi.setSystemTime(new Date("2026-04-21T13:00:00.000Z"));

    const result = await verifySupabaseJwt(auth, token);
    expect(result).toBeNull();
  });

  it("rejects a malformed JWT", async () => {
    const auth = createSupabaseAuth({ jwtSecret: TEST_SECRET });
    expect(await verifySupabaseJwt(auth, "not-a-jwt")).toBeNull();
    expect(await verifySupabaseJwt(auth, "aa.bb.cc")).toBeNull();
    expect(await verifySupabaseJwt(auth, "")).toBeNull();
  });

  it("rejects a JWT signed with a different secret", async () => {
    const auth = createSupabaseAuth({ jwtSecret: TEST_SECRET });
    const badToken = await signTestToken({ secret: "a-different-but-also-long-enough-secret-value" });

    const result = await verifySupabaseJwt(auth, badToken);
    expect(result).toBeNull();
  });

  it("rejects a JWT with the wrong issuer when issuer is configured", async () => {
    const auth = createSupabaseAuth({ jwtSecret: TEST_SECRET, url: TEST_PROJECT_URL });
    const token = await signTestToken({ issuer: "https://other-project.supabase.co/auth/v1" });

    const result = await verifySupabaseJwt(auth, token);
    expect(result).toBeNull();
  });

  it("rejects a JWT with the wrong audience", async () => {
    const auth = createSupabaseAuth({ jwtSecret: TEST_SECRET });
    const token = await signTestToken({ audience: "service_role" });

    const result = await verifySupabaseJwt(auth, token);
    expect(result).toBeNull();
  });

  it("returns null when the JWT secret is not configured", async () => {
    const auth = createSupabaseAuth({});
    const token = await signTestToken({});

    const result = await verifySupabaseJwt(auth, token);
    expect(result).toBeNull();
  });

  it("isSupabaseConfigured requires SUPABASE_URL (JWKS endpoint)", () => {
    expect(isSupabaseConfigured({})).toBe(false);
    expect(isSupabaseConfigured({ url: "" })).toBe(false);
    expect(isSupabaseConfigured({ url: "https://test.supabase.co" })).toBe(true);
    // Legacy HS256 alone (without url) is insufficient for modern projects.
    expect(isSupabaseConfigured({ jwtSecret: TEST_SECRET })).toBe(false);
  });
});

describe("supabase auth - session resolver (req extraction)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeReq(headers: Record<string, string>): Request {
    return {
      header(name: string) {
        const key = name.toLowerCase();
        for (const [headerKey, headerValue] of Object.entries(headers)) {
          if (headerKey.toLowerCase() === key) return headerValue;
        }
        return undefined;
      },
    } as unknown as Request;
  }

  it("reads token from Authorization: Bearer header", async () => {
    const auth = createSupabaseAuth({ jwtSecret: TEST_SECRET, url: TEST_PROJECT_URL });
    const token = await signTestToken({});

    const result = await resolveSupabaseSession(auth, fakeReq({ authorization: `Bearer ${token}` }));
    expect(result?.user?.id).toBe(TEST_USER_ID);
  });

  it("reads token from sb-access-token cookie", async () => {
    const auth = createSupabaseAuth({ jwtSecret: TEST_SECRET, url: TEST_PROJECT_URL });
    const token = await signTestToken({});

    const result = await resolveSupabaseSession(
      auth,
      fakeReq({ cookie: `other=x; sb-access-token=${token}; more=y` }),
    );
    expect(result?.user?.id).toBe(TEST_USER_ID);
  });

  it("returns null when no token is present", async () => {
    const auth = createSupabaseAuth({ jwtSecret: TEST_SECRET });
    const result = await resolveSupabaseSession(auth, fakeReq({}));
    expect(result).toBeNull();
  });
});

describe("supabase auth - claims extraction (pure)", () => {
  it("returns null when sub is missing", () => {
    expect(extractSupabaseUserFromClaims({ email: "x@y.com" })).toBeNull();
  });

  it("treats empty-string name as null", () => {
    const user = extractSupabaseUserFromClaims({
      sub: "u1",
      email: "x@y.com",
      user_metadata: { name: "   " },
    });
    expect(user?.name).toBeNull();
  });

  it("surfaces app_metadata.provider", () => {
    const user = extractSupabaseUserFromClaims({
      sub: "u1",
      email: "x@y.com",
      app_metadata: { provider: "google" },
    });
    expect(user?.provider).toBe("google");
  });
});

describe("supabase auth - webhook signature verification", () => {
  const SECRET = "shared-webhook-secret";

  function sign(body: string, secret = SECRET): string {
    return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  }

  it("accepts a correctly-signed payload", () => {
    const body = JSON.stringify({ type: "user.created", record: { id: "u1", email: "a@b.com" } });
    const ok = verifySupabaseWebhookSignature({
      rawBody: Buffer.from(body),
      signatureHeader: sign(body),
      secret: SECRET,
    });
    expect(ok).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const body = JSON.stringify({ type: "user.created", record: { id: "u1" } });
    const signature = sign(body);
    const tampered = body.replace("u1", "u2");
    const ok = verifySupabaseWebhookSignature({
      rawBody: Buffer.from(tampered),
      signatureHeader: signature,
      secret: SECRET,
    });
    expect(ok).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const body = "payload";
    const ok = verifySupabaseWebhookSignature({
      rawBody: Buffer.from(body),
      signatureHeader: sign(body, "different-secret"),
      secret: SECRET,
    });
    expect(ok).toBe(false);
  });

  it("accepts bare hex (no sha256= prefix) for tolerance", () => {
    const body = "payload";
    const hex = createHmac("sha256", SECRET).update(body).digest("hex");
    const ok = verifySupabaseWebhookSignature({
      rawBody: Buffer.from(body),
      signatureHeader: hex,
      secret: SECRET,
    });
    expect(ok).toBe(true);
  });

  it("rejects missing signature header", () => {
    expect(
      verifySupabaseWebhookSignature({ rawBody: Buffer.from("x"), signatureHeader: null, secret: SECRET }),
    ).toBe(false);
    expect(
      verifySupabaseWebhookSignature({ rawBody: Buffer.from("x"), signatureHeader: undefined, secret: SECRET }),
    ).toBe(false);
  });

  it("rejects non-hex signature values", () => {
    expect(
      verifySupabaseWebhookSignature({
        rawBody: Buffer.from("x"),
        signatureHeader: "sha256=not-hex!!",
        secret: SECRET,
      }),
    ).toBe(false);
  });
});

describe("supabase auth - webhook user extraction", () => {
  it("extracts user from a user.created payload", () => {
    const user = extractSupabaseUserFromWebhook({
      type: "user.created",
      record: {
        id: "uuid-1",
        email: "bob@example.com",
        user_metadata: { full_name: "Bob" },
        app_metadata: { provider: "google" },
      },
    });
    expect(user).toEqual({
      id: "uuid-1",
      email: "bob@example.com",
      name: "Bob",
      provider: "google",
    });
  });

  it("returns null when required fields are missing", () => {
    expect(extractSupabaseUserFromWebhook(null)).toBeNull();
    expect(extractSupabaseUserFromWebhook({})).toBeNull();
    expect(extractSupabaseUserFromWebhook({ record: {} })).toBeNull();
    expect(extractSupabaseUserFromWebhook({ record: { id: "x" } })).toBeNull();
    expect(extractSupabaseUserFromWebhook({ record: { email: "x@y.com" } })).toBeNull();
  });
});
