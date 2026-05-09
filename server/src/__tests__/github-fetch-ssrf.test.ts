/**
 * Unit tests for assertSafeGitHubHostname — CodeQL #20 SSRF fix.
 *
 * These tests exercise the IP-range checks without making real network calls.
 * dns.lookup is mocked via vi.mock so CI runs offline.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock dns/promises ────────────────────────────────────────────────────────

vi.mock("dns/promises", () => ({
  default: {
    lookup: vi.fn(),
  },
}));

import dns from "dns/promises";
import { assertSafeGitHubHostname } from "../services/github-fetch.js";

const mockLookup = vi.mocked(dns.lookup);

type LookupAddress = { address: string; family: number };

function resolvesWith(addresses: LookupAddress[]) {
  // dns.lookup with { all: true } returns LookupAddress[]
  mockLookup.mockResolvedValueOnce(addresses as never);
}

function rejectsWith(err: Error) {
  mockLookup.mockRejectedValueOnce(err);
}

// ─── Helper ───────────────────────────────────────────────────────────────────

async function expectPass(hostname: string) {
  await expect(assertSafeGitHubHostname(hostname)).resolves.toBeUndefined();
}

async function expectFail(hostname: string, msgFragment: string) {
  await expect(assertSafeGitHubHostname(hostname)).rejects.toThrow(msgFragment);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("assertSafeGitHubHostname — allowlist (no DNS needed)", () => {
  beforeEach(() => {
    mockLookup.mockClear();
  });

  it("passes github.com without DNS lookup", async () => {
    await expectPass("github.com");
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("passes www.github.com without DNS lookup", async () => {
    await expectPass("www.github.com");
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("passes api.github.com without DNS lookup", async () => {
    await expectPass("api.github.com");
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("passes raw.githubusercontent.com without DNS lookup", async () => {
    await expectPass("raw.githubusercontent.com");
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("passes *.github.com subdomain without DNS lookup", async () => {
    await expectPass("myorg.github.com");
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("passes *.githubusercontent.com without DNS lookup", async () => {
    await expectPass("avatars.githubusercontent.com");
    expect(mockLookup).not.toHaveBeenCalled();
  });
});

describe("assertSafeGitHubHostname — GHE hostname with public IP (safe)", () => {
  beforeEach(() => {
    mockLookup.mockClear();
  });

  it("passes GHE hostname resolved to public IPv4", async () => {
    resolvesWith([{ address: "203.0.113.42", family: 4 }]);
    await expectPass("git.mycompany.com");
    expect(mockLookup).toHaveBeenCalledWith("git.mycompany.com", { all: true });
  });

  it("passes GHE hostname resolved to public IPv6", async () => {
    resolvesWith([{ address: "2001:db8::1", family: 6 }]);
    await expectPass("git.mycompany.com");
  });

  it("passes GHE hostname with multiple public IPs", async () => {
    resolvesWith([
      { address: "203.0.113.1", family: 4 },
      { address: "203.0.113.2", family: 4 },
    ]);
    await expectPass("git.mycompany.com");
  });
});

describe("assertSafeGitHubHostname — blocked: private IPv4", () => {
  beforeEach(() => {
    mockLookup.mockClear();
  });

  it("rejects GHE hostname resolved to 10.x.x.x (RFC-1918)", async () => {
    resolvesWith([{ address: "10.0.0.1", family: 4 }]);
    await expectFail("git.internal.corp", "private or reserved IP");
  });

  it("rejects GHE hostname resolved to 172.16.x.x (RFC-1918)", async () => {
    resolvesWith([{ address: "172.16.0.1", family: 4 }]);
    await expectFail("git.internal.corp", "private or reserved IP");
  });

  it("rejects GHE hostname resolved to 172.31.x.x (RFC-1918 boundary)", async () => {
    resolvesWith([{ address: "172.31.255.254", family: 4 }]);
    await expectFail("git.internal.corp", "private or reserved IP");
  });

  it("rejects GHE hostname resolved to 192.168.x.x (RFC-1918)", async () => {
    resolvesWith([{ address: "192.168.1.100", family: 4 }]);
    await expectFail("git.internal.corp", "private or reserved IP");
  });

  it("rejects 127.x.x.x loopback", async () => {
    resolvesWith([{ address: "127.0.0.1", family: 4 }]);
    await expectFail("loopback.local", "private or reserved IP");
  });

  it("rejects 169.254.x.x link-local (IMDS / metadata endpoint)", async () => {
    resolvesWith([{ address: "169.254.169.254", family: 4 }]);
    await expectFail("169.254.169.254.nip.io", "private or reserved IP");
  });

  it("rejects if ANY resolved address is private (mixed public+private)", async () => {
    resolvesWith([
      { address: "203.0.113.1", family: 4 }, // public
      { address: "10.0.0.1", family: 4 },    // private — must block
    ]);
    await expectFail("git.sneaky.com", "private or reserved IP");
  });
});

describe("assertSafeGitHubHostname — blocked: plain hostname keywords", () => {
  beforeEach(() => {
    mockLookup.mockClear();
  });

  it("rejects 'localhost' after DNS resolution to 127.0.0.1", async () => {
    resolvesWith([{ address: "127.0.0.1", family: 4 }]);
    await expectFail("localhost", "private or reserved IP");
  });
});

describe("assertSafeGitHubHostname — blocked: private IPv6", () => {
  beforeEach(() => {
    mockLookup.mockClear();
  });

  it("rejects ::1 (IPv6 loopback)", async () => {
    resolvesWith([{ address: "::1", family: 6 }]);
    await expectFail("ipv6-loopback.local", "private or reserved IP");
  });

  it("rejects fc00:: ULA prefix", async () => {
    resolvesWith([{ address: "fc00::1", family: 6 }]);
    await expectFail("ula.local", "private or reserved IP");
  });

  it("rejects fd00:: ULA prefix", async () => {
    resolvesWith([{ address: "fd12:3456:789a::1", family: 6 }]);
    await expectFail("ula2.local", "private or reserved IP");
  });

  it("rejects fe80:: link-local", async () => {
    resolvesWith([{ address: "fe80::1", family: 6 }]);
    await expectFail("link-local.local", "private or reserved IP");
  });

  it("rejects ::ffff:10.0.0.1 (IPv6-mapped private IPv4)", async () => {
    resolvesWith([{ address: "::ffff:10.0.0.1", family: 6 }]);
    await expectFail("mapped-private.local", "private or reserved IP");
  });

  it("rejects ::ffff:192.168.1.1 (IPv6-mapped private IPv4)", async () => {
    resolvesWith([{ address: "::ffff:192.168.1.1", family: 6 }]);
    await expectFail("mapped-private2.local", "private or reserved IP");
  });

  it("rejects ::ffff:169.254.169.254 (IPv6-mapped IMDS)", async () => {
    resolvesWith([{ address: "::ffff:169.254.169.254", family: 6 }]);
    await expectFail("mapped-imds.local", "private or reserved IP");
  });
});

describe("assertSafeGitHubHostname — DNS failures", () => {
  beforeEach(() => {
    mockLookup.mockClear();
  });

  it("rejects when DNS lookup fails", async () => {
    rejectsWith(new Error("ENOTFOUND git.nxdomain.invalid"));
    await expectFail("git.nxdomain.invalid", "Could not resolve hostname");
  });
});

describe("assertSafeGitHubHostname — input validation", () => {
  beforeEach(() => {
    mockLookup.mockClear();
  });

  it("rejects empty string", async () => {
    await expectFail("", "must not be empty");
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only string", async () => {
    await expectFail("   ", "must not be empty");
    expect(mockLookup).not.toHaveBeenCalled();
  });
});
