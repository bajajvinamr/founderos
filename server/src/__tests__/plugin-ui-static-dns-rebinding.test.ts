import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:dns/promises BEFORE the module under test imports it.
// `vi.hoisted` lifts the mock control object above the import so the mock is
// installed before the route module is evaluated.
const mockLookup = vi.hoisted(() => vi.fn());

vi.mock("node:dns/promises", () => ({
  default: { lookup: mockLookup },
  lookup: mockLookup,
}));

describe("plugin-ui-static — assertLoopbackResolution (DNS rebinding guard)", () => {
  beforeEach(() => {
    vi.resetModules();
    mockLookup.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts the IPv4 loopback literal without DNS lookup", async () => {
    const { assertLoopbackResolution } = await import(
      "../routes/plugin-ui-static.js"
    );
    await expect(assertLoopbackResolution("127.0.0.1")).resolves.toBeUndefined();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("accepts the IPv6 loopback literal without DNS lookup", async () => {
    const { assertLoopbackResolution } = await import(
      "../routes/plugin-ui-static.js"
    );
    await expect(assertLoopbackResolution("::1")).resolves.toBeUndefined();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback IPv4 literal without DNS lookup", async () => {
    const { assertLoopbackResolution } = await import(
      "../routes/plugin-ui-static.js"
    );
    await expect(
      assertLoopbackResolution("10.0.0.1"),
    ).rejects.toThrow(/non-loopback IP 10\.0\.0\.1 blocked/);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback IPv6 literal without DNS lookup", async () => {
    const { assertLoopbackResolution } = await import(
      "../routes/plugin-ui-static.js"
    );
    await expect(
      assertLoopbackResolution("fe80::1"),
    ).rejects.toThrow(/non-loopback IP fe80::1 blocked/);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects a hostname that resolves to a non-loopback address (DNS rebinding)", async () => {
    mockLookup.mockResolvedValueOnce({ address: "10.0.0.1", family: 4 });
    const { assertLoopbackResolution } = await import(
      "../routes/plugin-ui-static.js"
    );
    await expect(
      assertLoopbackResolution("evil.example.com"),
    ).rejects.toThrow(/hostname evil\.example\.com resolved to non-loopback 10\.0\.0\.1/);
    expect(mockLookup).toHaveBeenCalledWith("evil.example.com", { family: 0 });
  });

  it("rejects 'localhost' if the system resolver returns a non-loopback address", async () => {
    // Simulates a hijacked /etc/hosts or compromised resolver where
    // localhost has been rebound. (In production code 'localhost' is also
    // rejected by the upstream hostname guard; this DNS check is the
    // belt-and-braces second layer.)
    mockLookup.mockResolvedValueOnce({ address: "10.0.0.1", family: 4 });
    const { assertLoopbackResolution } = await import(
      "../routes/plugin-ui-static.js"
    );
    await expect(
      assertLoopbackResolution("localhost"),
    ).rejects.toThrow(/hostname localhost resolved to non-loopback 10\.0\.0\.1/);
    expect(mockLookup).toHaveBeenCalledWith("localhost", { family: 0 });
  });

  it("accepts a hostname that resolves to 127.0.0.1", async () => {
    mockLookup.mockResolvedValueOnce({ address: "127.0.0.1", family: 4 });
    const { assertLoopbackResolution } = await import(
      "../routes/plugin-ui-static.js"
    );
    await expect(
      assertLoopbackResolution("dev.local"),
    ).resolves.toBeUndefined();
    expect(mockLookup).toHaveBeenCalledWith("dev.local", { family: 0 });
  });

  it("accepts a hostname that resolves to ::1", async () => {
    mockLookup.mockResolvedValueOnce({ address: "::1", family: 6 });
    const { assertLoopbackResolution } = await import(
      "../routes/plugin-ui-static.js"
    );
    await expect(
      assertLoopbackResolution("dev.local"),
    ).resolves.toBeUndefined();
    expect(mockLookup).toHaveBeenCalledWith("dev.local", { family: 0 });
  });
});
