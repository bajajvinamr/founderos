/**
 * ssrf-guard.ts — SSRF prevention utilities for server-side outbound fetches.
 *
 * Provides:
 *   - isPrivateIpAddress(ip): rejects RFC-1918, loopback, link-local,
 *     IPv6 ULA/link-local, any-address, and IPv4-mapped IPv6 addresses.
 *   - assertSafeOutboundUrl(urlString): full SSRF guard — parse, protocol
 *     whitelist, DNS resolution, private-IP rejection. Awaitable.
 *
 * Throws HttpErrors (400) from "../errors.js" so callers can let Express
 * error middleware surface them without any extra wrapping.
 *
 * Used by:
 *   - server/src/routes/access.ts (invite test-resolution probe, CodeQL #18)
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { badRequest } from "../errors.js";

/**
 * Returns true if `ip` falls within a private/reserved range that must never
 * be reachable from an outbound server-side request:
 *
 *   IPv4: RFC 1918 (10/8, 172.16/12, 192.168/16), loopback (127/8),
 *         link-local (169.254/16), any-address (0.0.0.0)
 *   IPv6: loopback (::1), any-address (::), ULA (fc00::/7 — fc, fd prefixes),
 *         link-local (fe80::/10)
 *   IPv4-mapped IPv6 (::ffff:x.x.x.x): unwrapped and re-checked as plain IPv4
 */
export function isPrivateIpAddress(ip: string): boolean {
  const lower = ip.toLowerCase();

  // Unwrap IPv4-mapped IPv6 (::ffff:x.x.x.x) and re-check as plain IPv4
  const v4Mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Mapped && v4Mapped[1]) return isPrivateIpAddress(v4Mapped[1]);

  // IPv4 ranges
  if (lower.startsWith("127.")) return true;          // loopback 127.0.0.0/8
  if (lower.startsWith("10.")) return true;           // RFC 1918 10/8
  if (lower.startsWith("192.168.")) return true;      // RFC 1918 192.168/16
  if (lower.startsWith("169.254.")) return true;      // link-local 169.254/16
  if (lower === "0.0.0.0") return true;               // any-address
  if (lower.startsWith("172.")) {
    const second = parseInt(lower.split(".")[1]!, 10);
    if (second >= 16 && second <= 31) return true;    // RFC 1918 172.16/12
  }

  // IPv6 addresses
  if (lower === "::1") return true;                   // loopback
  if (lower === "::") return true;                    // any-address
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
  if (lower.startsWith("fe80")) return true;          // link-local fe80::/10

  return false;
}

/**
 * Validates a URL string is safe for server-side outbound fetch:
 *   1. URL must parse without error.
 *   2. Protocol must be http: or https:.
 *   3. Hostname must resolve to at least one IP via DNS.
 *   4. ALL resolved IPs must be outside private/reserved ranges.
 *
 * Returns the parsed URL so callers can pass it directly to fetch().
 * Throws a 400 BadRequest error on any violation.
 *
 * DNS rebinding note: callers should use the returned URL (not re-resolve)
 * to avoid a TOCTOU window between this check and fetch()'s own resolution.
 */
export async function assertSafeOutboundUrl(urlString: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw badRequest("url must be a valid absolute URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw badRequest("url must use http or https");
  }

  // Strip IPv6 brackets that Node's URL parser adds around bare IPv6 hosts
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  let addresses: { address: string }[];
  try {
    addresses = await dnsLookup(hostname, { all: true });
  } catch {
    throw badRequest(`Could not resolve host: ${hostname}`);
  }

  if (addresses.length === 0) {
    throw badRequest(`DNS returned no records for host: ${hostname}`);
  }

  // Reject if ANY resolved IP is in a private/reserved range.
  // We check ALL records, not just the first, to defend against multi-homed
  // hosts that might include a private address alongside a public one.
  const privateHit = addresses.find((a) => isPrivateIpAddress(a.address));
  if (privateHit) {
    throw badRequest(
      `URL resolves to a private/reserved address (${privateHit.address}) and cannot be probed`
    );
  }

  return parsed;
}
