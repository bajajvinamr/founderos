/**
 * Tests for server/src/lib/ssrf-guard.ts
 *
 * Covers:
 *   isPrivateIpAddress — all RFC-1918, loopback, link-local, IPv6 ULA/link-local,
 *                        any-address, and IPv4-mapped IPv6 variants.
 *   assertSafeOutboundUrl — protocol gate, DNS-resolution rejection, happy path.
 *
 * Verifies CodeQL alert #18 (js/request-forgery) mitigation on the
 * GET /invites/:token/test-resolution route.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mock for dns/promises so tests don't make real DNS calls
// ---------------------------------------------------------------------------

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import { lookup as dnsLookup } from "node:dns/promises";
import { isPrivateIpAddress, assertSafeOutboundUrl } from "../lib/ssrf-guard.js";

const mockLookup = dnsLookup as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// isPrivateIpAddress — synchronous, no DNS
// ---------------------------------------------------------------------------

describe("isPrivateIpAddress", () => {
  it.each([
    // Loopback
    ["127.0.0.1", true],
    ["127.0.0.2", true],
    ["127.255.255.255", true],
    // RFC 1918 — 10/8
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    // RFC 1918 — 172.16/12
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.15.0.1", false],  // just outside range
    ["172.32.0.1", false],  // just outside range
    // RFC 1918 — 192.168/16
    ["192.168.0.1", true],
    ["192.168.255.255", true],
    // Link-local
    ["169.254.0.1", true],
    ["169.254.169.254", true], // AWS metadata service
    // Any-address
    ["0.0.0.0", true],
    // IPv6 loopback
    ["::1", true],
    ["::1".toUpperCase(), true],
    // IPv6 any-address
    ["::", true],
    // IPv6 ULA (fc00::/7)
    ["fc00::1", true],
    ["fd12:3456:789a:1::1", true],
    // IPv6 link-local
    ["fe80::1", true],
    ["fe80::1%eth0", true],
    // IPv4-mapped IPv6
    ["::ffff:127.0.0.1", true],
    ["::ffff:10.0.0.1", true],
    ["::ffff:169.254.169.254", true],
    ["::ffff:192.168.1.1", true],
    // Public IPs — must NOT be blocked
    ["1.1.1.1", false],
    ["8.8.8.8", false],
    ["93.184.216.34", false],
    ["2606:4700:4700::1111", false], // Cloudflare public IPv6
  ])("isPrivateIpAddress(%j) === %s", (ip, expected) => {
    expect(isPrivateIpAddress(ip)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// assertSafeOutboundUrl — async, mocks DNS
// ---------------------------------------------------------------------------

describe("assertSafeOutboundUrl", () => {
  it("passes a valid public URL through unchanged", async () => {
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const result = await assertSafeOutboundUrl("https://example.com/webhook");
    expect(result).toBeInstanceOf(URL);
    expect(result.hostname).toBe("example.com");
  });

  it("rejects http://169.254.169.254/ (AWS IMDS)", async () => {
    mockLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(assertSafeOutboundUrl("http://169.254.169.254/")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects http://localhost/", async () => {
    mockLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(assertSafeOutboundUrl("http://localhost/")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects http://10.0.0.1/", async () => {
    mockLookup.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    await expect(assertSafeOutboundUrl("http://10.0.0.1/")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects gopher:// (invalid protocol)", async () => {
    await expect(assertSafeOutboundUrl("gopher://example.com/")).rejects.toMatchObject({
      status: 400,
    });
    // DNS must not be called for a bad protocol
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects file:// (invalid protocol)", async () => {
    await expect(assertSafeOutboundUrl("file:///etc/passwd")).rejects.toMatchObject({
      status: 400,
    });
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects an unparseable URL string", async () => {
    await expect(assertSafeOutboundUrl("not-a-url")).rejects.toMatchObject({
      status: 400,
    });
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects a URL that fails DNS resolution", async () => {
    mockLookup.mockRejectedValue(new Error("ENOTFOUND nonexistent.invalid"));
    await expect(
      assertSafeOutboundUrl("https://nonexistent.invalid/")
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects if ANY resolved IP is private (multi-homed host)", async () => {
    // host resolves to one public + one private address
    mockLookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    await expect(
      assertSafeOutboundUrl("https://multi-homed.example.com/")
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", async () => {
    mockLookup.mockResolvedValue([{ address: "::ffff:127.0.0.1", family: 6 }]);
    await expect(assertSafeOutboundUrl("http://example.com/")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects IPv6 ULA address (fc00::1)", async () => {
    mockLookup.mockResolvedValue([{ address: "fc00::1", family: 6 }]);
    await expect(assertSafeOutboundUrl("http://internal.example/")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects http://192.168.1.100/ (RFC-1918 private)", async () => {
    mockLookup.mockResolvedValue([{ address: "192.168.1.100", family: 4 }]);
    await expect(assertSafeOutboundUrl("http://192.168.1.100/")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("allows http:// (non-TLS) to a public address", async () => {
    mockLookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
    const result = await assertSafeOutboundUrl("http://public.example.com/");
    expect(result.protocol).toBe("http:");
  });
});
