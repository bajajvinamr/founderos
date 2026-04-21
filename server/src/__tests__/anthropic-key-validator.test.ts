import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { validateAnthropicKey } from "../services/anthropic-key-validator.js";

describe("anthropic-key-validator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("validates a valid key with 200 response", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 200 }),
    );

    const result = await validateAnthropicKey("sk-valid-key-12345");

    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "x-api-key": "sk-valid-key-12345",
          "anthropic-version": "2023-06-01",
        }),
      }),
    );
  });

  it("returns invalid with reason on 401 (unauthorized)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 401 }),
    );

    const result = await validateAnthropicKey("sk-invalid-key");

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("invalid_key");
  });

  it("returns invalid with reason on 403 (forbidden)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 403 }),
    );

    const result = await validateAnthropicKey("sk-forbidden-key");

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("permission_denied");
  });

  it("returns invalid with network_error on fetch rejection", async () => {
    vi.spyOn(global, "fetch").mockRejectedValueOnce(
      new Error("Network error"),
    );

    const result = await validateAnthropicKey("sk-test-key");

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("network_error");
  });

  it("returns invalid with timeout reason on abort", async () => {
    const abortError = new Error("Aborted");
    abortError.name = "AbortError";
    vi.spyOn(global, "fetch").mockRejectedValueOnce(abortError);

    const result = await validateAnthropicKey("sk-test-key");

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("timeout");
  });

  it("trims whitespace from key", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 200 }),
    );

    await validateAnthropicKey("  sk-test-key  \n");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-api-key": "sk-test-key",
        }),
      }),
    );
  });

  it("returns empty_key for empty input", async () => {
    const result = await validateAnthropicKey("");

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("empty_key");
  });

  it("returns empty_key for whitespace-only input", async () => {
    const result = await validateAnthropicKey("   \n  \t");

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("empty_key");
  });
});
