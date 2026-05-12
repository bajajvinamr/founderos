import dns from "dns/promises";
import type { LookupAddress } from "dns";
import { unprocessable } from "../errors.js";

// ─── Allowlist ────────────────────────────────────────────────────────────────
// These hostnames are always safe — skip expensive DNS resolution for them.

const GITHUB_HOSTNAME_ALLOWLIST = new Set([
  "github.com",
  "www.github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "avatars.githubusercontent.com",
]);

function isAllowlistedGitHubHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    GITHUB_HOSTNAME_ALLOWLIST.has(h) ||
    h.endsWith(".github.com") ||
    h.endsWith(".githubusercontent.com")
  );
}

// ─── IP range helpers ─────────────────────────────────────────────────────────

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // Unparseable — reject by default
  }
  const [a, b] = parts;
  return (
    a === 127 || // 127.0.0.0/8 loopback
    a === 10 || // 10.0.0.0/8 RFC-1918
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 RFC-1918
    (a === 192 && b === 168) || // 192.168.0.0/16 RFC-1918
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local (IMDS)
    (a === 0) || // 0.0.0.0/8 "this" network
    (a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10 shared address space
  );
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === "::1" || // loopback
    lower.startsWith("fc") || // fc00::/7 ULA
    lower.startsWith("fd") || // fc00::/7 ULA
    lower.startsWith("fe80") || // fe80::/10 link-local
    lower === "::" || // unspecified
    // IPv6-mapped IPv4 (::ffff:10.x.x.x, ::ffff:192.168.x.x, etc.)
    extractIPv4FromMappedIPv6(lower) !== null
  );
}

/**
 * If `ip` is an IPv6-mapped IPv4 address (::ffff:a.b.c.d or ::ffff:0xAB0CDE),
 * returns the embedded IPv4 string so we can run isPrivateIPv4 on it.
 * Returns null if not a mapped address.
 */
function extractIPv4FromMappedIPv6(ip: string): string | null {
  // Canonical form: ::ffff:192.168.1.1  or  ::ffff:c0a8:101
  const mappedDotted = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedDotted) return mappedDotted[1];

  // Hex form: ::ffff:c0a8:101  (192.168.1.1)
  const mappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }

  return null;
}

function isPrivateIP(address: string, family: number): boolean {
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) {
    // Check for embedded private IPv4 first
    const embedded = extractIPv4FromMappedIPv6(address.toLowerCase());
    if (embedded !== null) return isPrivateIPv4(embedded);
    return isPrivateIPv6(address);
  }
  return true; // Unknown family — reject
}

// ─── Public validator ─────────────────────────────────────────────────────────

/**
 * Asserts that `hostname` is safe to use as a GitHub or GitHub Enterprise target.
 *
 * - Allowlisted GitHub hostnames (github.com, *.github.com, *.githubusercontent.com,
 *   api.github.com) pass immediately without DNS resolution.
 * - All other hostnames (GitHub Enterprise) are resolved via DNS; if ANY resolved
 *   address falls in a loopback, RFC-1918, link-local, or IPv6-mapped-private range
 *   the call is rejected with an `unprocessable` HttpError.
 *
 * Exported so other services that make outbound calls can reuse it.
 *
 * @throws {HttpError} 422 if the hostname resolves to a private/internal address.
 */
export async function assertSafeGitHubHostname(hostname: string): Promise<void> {
  if (!hostname || hostname.trim() === "") {
    throw unprocessable("GitHub hostname must not be empty");
  }

  const h = hostname.toLowerCase().trim();

  if (isAllowlistedGitHubHostname(h)) {
    return; // Fast path — no DNS needed
  }

  // GitHub Enterprise: resolve and check every returned address
  let addresses: LookupAddress[];
  try {
    addresses = await dns.lookup(h, { all: true });
  } catch {
    throw unprocessable(
      `Could not resolve hostname "${hostname}" — ensure it points to a reachable GitHub Enterprise instance`,
    );
  }

  if (addresses.length === 0) {
    throw unprocessable(
      `Hostname "${hostname}" resolved to no addresses — SSRF check cannot be completed`,
    );
  }

  for (const { address, family } of addresses) {
    if (isPrivateIP(address, family)) {
      throw unprocessable(
        `GitHub Enterprise hostname "${hostname}" resolves to a private or reserved IP address (${address}). ` +
          `Requests to internal infrastructure are not allowed.`,
      );
    }
  }
}

// ─── Original helpers (unchanged API surface) ─────────────────────────────────

function isGitHubDotCom(hostname: string) {
  const h = hostname.toLowerCase();
  return h === "github.com" || h === "www.github.com";
}

export function gitHubApiBase(hostname: string) {
  return isGitHubDotCom(hostname) ? "https://api.github.com" : `https://${hostname}/api/v3`;
}

export function resolveRawGitHubUrl(
  hostname: string,
  owner: string,
  repo: string,
  ref: string,
  filePath: string,
) {
  const p = filePath.replace(/^\/+/, "");
  return isGitHubDotCom(hostname)
    ? `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${p}`
    : `https://${hostname}/raw/${owner}/${repo}/${ref}/${p}`;
}

export async function ghFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw unprocessable(
      `Could not connect to ${new URL(url).hostname} — ensure the URL points to a GitHub or GitHub Enterprise instance`,
    );
  }
}
