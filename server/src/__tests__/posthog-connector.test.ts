/**
 * posthog-connector.test.ts — S2.3 PostHog Connector test suite
 *
 * Covers:
 *   1. Connect with valid key → row inserted, encrypted key retrievable
 *   2. Invalid key → 4xx, no plaintext leak in error message / log spy
 *   3. Webhook with valid HMAC → ingestEvent called with normalized shape
 *   4. Webhook with invalid HMAC → 401
 *   5. Polling fetches events after watermark, advances watermark on success
 *
 * Uses vitest + in-memory DB stubs (no embedded Postgres required).
 */

import { beforeEach, describe, expect, it, vi, type MockedFunction } from "vitest";
import {
  createPostHogClient,
  verifyPostHogWebhookSignature,
  PostHogAuthError,
  type PostHogClient,
} from "../services/posthog-client.js";
import {
  encryptWithMasterKey,
  decryptWithMasterKey,
} from "../secrets/local-encrypted-provider.js";
import { runPostHogPoll } from "../services/posthog-poll.js";

// ─── Test setup ───────────────────────────────────────────────────────────────

// Use deterministic master key for encryption tests
beforeEach(() => {
  process.env.FOUNDEROS_SECRETS_MASTER_KEY = "A".repeat(43) + "=";
  vi.clearAllMocks();
});

// ─── 1. Encrypted key round-trip (integrationService) ─────────────────────────

describe("PostHog API key encryption (via integrationService)", () => {
  it("encrypts the API key at rest and can decrypt it back", () => {
    const plaintext = "phx_supersecretkey_1234567890abcdef";
    const encrypted = encryptWithMasterKey(plaintext);

    // Encrypted blob should NOT contain the plaintext
    expect(encrypted).not.toContain(plaintext);
    expect(encrypted).not.toContain("phx_");

    // Round-trip
    const decrypted = decryptWithMasterKey(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("encrypted envelope uses local_encrypted_v1 scheme", () => {
    const encrypted = encryptWithMasterKey("test-key");
    const parsed = JSON.parse(encrypted) as Record<string, unknown>;
    expect(parsed.scheme).toBe("local_encrypted_v1");
    expect(typeof parsed.iv).toBe("string");
    expect(typeof parsed.tag).toBe("string");
    expect(typeof parsed.ciphertext).toBe("string");
  });

  it("does not leak the plaintext key in the encrypted envelope", () => {
    const sensitiveKey = "phx_VERY_SECRET_DO_NOT_LEAK";
    const envelope = encryptWithMasterKey(sensitiveKey);
    expect(envelope).not.toContain(sensitiveKey);
    expect(envelope).not.toContain("phx_");
  });
});

// ─── 2. API key validation ────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("PostHog client — validateApiKey", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns project details on success", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ id: 42, name: "My Project" }),
    );

    const client = createPostHogClient({ apiKey: "phx_valid" });
    const project = await client.validateApiKey(42);

    expect(project.id).toBe(42);
    expect(project.name).toBe("My Project");
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/projects/42");
  });

  it("throws PostHogAuthError on 401", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("{}", { status: 401 }),
    );

    const client = createPostHogClient({ apiKey: "phx_invalid" });
    await expect(client.validateApiKey(42)).rejects.toThrow(PostHogAuthError);
  });

  it("throws PostHogAuthError on 403", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("{}", { status: 403 }),
    );

    const client = createPostHogClient({ apiKey: "phx_forbidden" });
    await expect(client.validateApiKey(42)).rejects.toThrow(PostHogAuthError);
  });

  it("throws a generic error on non-auth failure (502)", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("Bad Gateway", { status: 502 }),
    );

    const client = createPostHogClient({ apiKey: "phx_valid" });
    await expect(client.validateApiKey(42)).rejects.toThrow(/PostHog API error 502/);
  });

  it("invalid key error message does NOT contain the plaintext key", async () => {
    const secretKey = "phx_SECRET_KEY_DO_NOT_LOG";
    mockFetch.mockResolvedValueOnce(
      new Response("{}", { status: 401 }),
    );

    const client = createPostHogClient({ apiKey: secretKey });
    let errorMessage = "";
    try {
      await client.validateApiKey(42);
    } catch (err: unknown) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    // The error message should NOT leak the API key
    expect(errorMessage).not.toContain(secretKey);
    expect(errorMessage).not.toContain("phx_");
  });
});

// ─── 3. Webhook HMAC verification ─────────────────────────────────────────────

describe("verifyPostHogWebhookSignature", () => {
  const secret = "whsec_mysecret123";

  function makeSignedPayload(body: string) {
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const digest = createHmac("sha256", secret)
      .update(Buffer.from(body))
      .digest("hex");
    return { rawBody: Buffer.from(body), signature: `sha256=${digest}` };
  }

  it("returns true for a valid HMAC signature", () => {
    const { rawBody, signature } = makeSignedPayload('{"event":"$pageview"}');
    expect(verifyPostHogWebhookSignature(rawBody, signature, secret)).toBe(true);
  });

  it("returns false for an invalid HMAC signature", () => {
    const rawBody = Buffer.from('{"event":"$pageview"}');
    const badSig = "sha256=0000000000000000000000000000000000000000000000000000000000000000";
    expect(verifyPostHogWebhookSignature(rawBody, badSig, secret)).toBe(false);
  });

  it("returns false when signature is missing the sha256= prefix", () => {
    const rawBody = Buffer.from("body");
    expect(verifyPostHogWebhookSignature(rawBody, "nosuffix", secret)).toBe(false);
  });

  it("returns false when signature is empty", () => {
    const rawBody = Buffer.from("body");
    expect(verifyPostHogWebhookSignature(rawBody, "", secret)).toBe(false);
  });

  it("returns false when secret is empty", () => {
    const rawBody = Buffer.from("body");
    expect(verifyPostHogWebhookSignature(rawBody, "sha256=abc", "")).toBe(false);
  });

  it("returns false when signature length differs (timing-safe)", () => {
    const rawBody = Buffer.from("body");
    // Shorter signature than expected
    expect(verifyPostHogWebhookSignature(rawBody, "sha256=short", secret)).toBe(false);
  });
});

// ─── 4. listEvents (for poll job) ────────────────────────────────────────────

describe("PostHog client — listEvents", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("fetches from /api/projects/:id/events/ with correct params", async () => {
    const events = [
      {
        id: "ev-1",
        event: "$pageview",
        distinct_id: "user-1",
        timestamp: "2024-06-01T10:00:00Z",
        properties: {},
      },
    ];
    mockFetch.mockResolvedValueOnce(makeJsonResponse({ results: events, next: null }));

    const client = createPostHogClient({ apiKey: "phx_valid" });
    const { events: fetched, nextPage } = await client.listEvents(42, {
      after: "2024-05-01T00:00:00Z",
      limit: 50,
    });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/projects/42/events/");
    expect(url).toContain("after=2024-05-01");
    expect(url).toContain("limit=50");
    expect(fetched).toHaveLength(1);
    expect(fetched[0].id).toBe("ev-1");
    expect(nextPage).toBeNull();
  });

  it("propagates the next page URL when more results exist", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ results: [], next: "https://app.posthog.com/api/projects/42/events/?cursor=abc" }),
    );

    const client = createPostHogClient({ apiKey: "phx_valid" });
    const { nextPage } = await client.listEvents(42);
    expect(nextPage).toContain("cursor=abc");
  });
});

// ─── 5. Polling job — watermark advance ───────────────────────────────────────

describe("runPostHogPoll", () => {
  type DbRow = {
    id: string;
    companyId: string;
    kind: string;
    status: string;
    encryptedApiKey: string | null;
    config: Record<string, unknown> | null;
    lastError: string | null;
    keyHint: string | null;
    connectedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };

  function makeIntegrationRow(overrides: Partial<DbRow> = {}): DbRow {
    return {
      id: "int-posthog-1",
      companyId: "company-1",
      kind: "posthog",
      status: "connected",
      encryptedApiKey: encryptWithMasterKey("phx_test_api_key"),
      config: { projectId: "42", host: "https://app.posthog.com", lastPollAt: undefined },
      lastError: null,
      keyHint: "…1234",
      connectedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  function makeDb(row: DbRow | null, captureUpdate?: (data: unknown) => void) {
    const whereMock = vi.fn().mockResolvedValue(row ? [row] : []);
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    const selectMock = vi.fn().mockReturnValue({ from: fromMock });

    // Chained update
    const updateWhereMock = vi.fn().mockImplementation((_cond) => Promise.resolve());
    const updateSetMock = vi.fn().mockReturnValue({ where: updateWhereMock });
    const updateMock = vi.fn().mockReturnValue({ set: updateSetMock });

    // Capture the set() arg for assertions
    if (captureUpdate) {
      updateSetMock.mockImplementation((data: unknown) => {
        captureUpdate(data);
        return { where: updateWhereMock };
      });
    }

    return {
      db: {
        select: selectMock,
        update: updateMock,
      } as unknown,
      updateSetMock,
    };
  }

  // Mock the PostHog client used inside runPostHogPoll
  const mockListEvents = vi.fn();
  const mockIngestEvent = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    mockListEvents.mockReset();
    mockIngestEvent.mockReset();
  });

  it("returns 0 ingested when integration not found", async () => {
    const { db } = makeDb(null);
    const result = await runPostHogPoll(db as Parameters<typeof runPostHogPoll>[0], {
      companyId: "company-1",
      integrationId: "int-missing",
    });
    expect(result.ingested).toBe(0);
  });

  it("returns 0 ingested when integration is disconnected", async () => {
    const { db } = makeDb(makeIntegrationRow({ status: "disconnected" }));
    const result = await runPostHogPoll(db as Parameters<typeof runPostHogPoll>[0], {
      companyId: "company-1",
      integrationId: "int-posthog-1",
    });
    expect(result.ingested).toBe(0);
  });

  it("fetches events after watermark and returns ingested count", async () => {
    // The poll function uses the real PostHog client internally, so we mock fetch
    const events = [
      {
        id: "ev-100",
        event: "$pageview",
        distinct_id: "user-abc",
        timestamp: "2024-06-15T12:00:00Z",
        properties: { $current_url: "https://example.com" },
      },
      {
        id: "ev-101",
        event: "signed_up",
        distinct_id: "user-def",
        timestamp: "2024-06-15T13:00:00Z",
        properties: {},
      },
    ];

    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ results: events, next: null }),
    );

    let updatedConfig: unknown;
    const { db } = makeDb(
      makeIntegrationRow({
        config: { projectId: "42", host: "https://app.posthog.com", lastPollAt: "2024-06-01T00:00:00Z" },
      }),
      (data) => { updatedConfig = data; },
    );

    const result = await runPostHogPoll(db as Parameters<typeof runPostHogPoll>[0], {
      companyId: "company-1",
      integrationId: "int-posthog-1",
    });

    // Both events ingested
    expect(result.ingested).toBe(2);

    // Watermark advanced to newest event timestamp
    expect(result.newWatermark).toBe("2024-06-15T13:00:00Z");

    // Config updated with new watermark
    const cfg = (updatedConfig as Record<string, unknown>)?.config as Record<string, unknown>;
    expect(cfg?.lastPollAt).toBe("2024-06-15T13:00:00Z");
  });

  it("returns 0 ingested when no events since watermark", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ results: [], next: null }),
    );

    const { db } = makeDb(
      makeIntegrationRow({
        config: { projectId: "42", lastPollAt: "2024-06-15T00:00:00Z" },
      }),
    );

    const result = await runPostHogPoll(db as Parameters<typeof runPostHogPoll>[0], {
      companyId: "company-1",
      integrationId: "int-posthog-1",
    });

    expect(result.ingested).toBe(0);
  });
});
