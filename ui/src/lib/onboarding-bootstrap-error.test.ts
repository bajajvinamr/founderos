/**
 * Tests for `formatBootstrapError` — pure formatter that maps an
 * onboarding /bootstrap submit error to a single human-friendly string
 * with a Reference: <requestId> footer when available.
 *
 * Synthesis P1-E2: the wizard previously did `err instanceof Error ? err.message : "..."`
 * which discarded both the HTTP status (so 401 / 402 / 403 / 409 / 5xx all
 * looked the same to the founder) and the requestId (so support couldn't
 * grep logs without first interrogating the user). CLAUDE.md guarantees
 * every JSON error since 2026-05-03 carries a requestId; the formatter
 * must surface it whenever it exists.
 *
 * Pure function — no React, no jsdom, no embedded server. The wizard
 * just calls this and assigns the result to its existing string state.
 */

import { describe, it, expect } from "vitest";
import { ApiError } from "../api/client";
import { formatBootstrapError } from "./onboarding-bootstrap-error";

const REQUEST_ID = "req-abc123";

describe("formatBootstrapError", () => {
  // -- ApiError status branches --------------------------------------

  it("401 → tells the founder their session expired", () => {
    const err = new ApiError("unauthorized", 401, { error: "unauthorized" }, REQUEST_ID);
    const out = formatBootstrapError(err);
    expect(out).toMatch(/sign(.*)in|session/i);
    expect(out).toContain(REQUEST_ID);
  });

  it("402 → tells the founder a subscription is required and points at billing", () => {
    const err = new ApiError(
      "subscription_inactive",
      402,
      { error: "subscription_inactive" },
      REQUEST_ID,
    );
    const out = formatBootstrapError(err);
    expect(out).toMatch(/subscription|billing/i);
    expect(out).toContain(REQUEST_ID);
  });

  it("403 → tells the founder they lack permission", () => {
    const err = new ApiError("forbidden", 403, { error: "forbidden" }, REQUEST_ID);
    const out = formatBootstrapError(err);
    expect(out).toMatch(/permission|admin|access/i);
    expect(out).toContain(REQUEST_ID);
  });

  it("409 → tells the founder the company already exists", () => {
    const err = new ApiError(
      "company_exists",
      409,
      { error: "company_exists" },
      REQUEST_ID,
    );
    const out = formatBootstrapError(err);
    expect(out).toMatch(/already exists|conflict/i);
    expect(out).toContain(REQUEST_ID);
  });

  it("5xx → tells the founder it's a service issue and to retry", () => {
    const err = new ApiError("server_error", 503, { error: "service_unavailable" }, REQUEST_ID);
    const out = formatBootstrapError(err);
    expect(out).toMatch(/service|retry|temporar|server/i);
    expect(out).toContain(REQUEST_ID);
  });

  it("unknown ApiError status (4xx not specifically mapped) → falls back to err.message but still surfaces requestId", () => {
    // Synthesis intent: every error must have a status-aware branch OR
    // a fallback that preserves the original message. Critical: the
    // requestId is always rendered when present — that's the
    // load-bearing forensic anchor for support.
    const err = new ApiError(
      "Some unusual error",
      418,
      { error: "i_am_a_teapot" },
      REQUEST_ID,
    );
    const out = formatBootstrapError(err);
    expect(out).toContain("Some unusual error");
    expect(out).toContain(REQUEST_ID);
  });

  // -- requestId presentation ---------------------------------------

  it("renders 'Reference: <requestId>' footer separator", () => {
    const err = new ApiError(
      "anything",
      500,
      { error: "boom" },
      "req-fingerprint",
    );
    const out = formatBootstrapError(err);
    // Reference: <id> is the canonical support-quote phrase. Founder
    // copy-pastes the whole error text into Slack/email; the prefix
    // makes the ID grep-able in incident channels.
    expect(out).toMatch(/Reference:\s*req-fingerprint/);
  });

  it("omits the Reference footer when requestId is null", () => {
    const err = new ApiError("anything", 500, { error: "boom" }, null);
    const out = formatBootstrapError(err);
    expect(out).not.toMatch(/Reference:/);
  });

  // -- non-ApiError paths -------------------------------------------

  it("plain Error (network failure / TypeError / etc) → returns err.message", () => {
    const err = new Error("Failed to fetch");
    const out = formatBootstrapError(err);
    expect(out).toContain("Failed to fetch");
    // No requestId available — and that's fine, no footer.
    expect(out).not.toMatch(/Reference:/);
  });

  it("non-Error throw value (string / object / undefined) → generic fallback", () => {
    expect(formatBootstrapError("oops")).toMatch(/bootstrap|company|fail/i);
    expect(formatBootstrapError({ random: "object" })).toMatch(/bootstrap|company|fail/i);
    expect(formatBootstrapError(undefined)).toMatch(/bootstrap|company|fail/i);
  });

  it("ApiError with empty requestId string is treated like missing (no Reference: '')", () => {
    // ApiError constructor accepts requestId as `string | null` — but
    // an empty string is not a useful reference and would render as
    // "Reference: " which is worse than no footer.
    const err = new ApiError("anything", 500, { error: "boom" }, "");
    const out = formatBootstrapError(err);
    expect(out).not.toMatch(/Reference:\s*$/);
    expect(out).not.toMatch(/Reference:\s+\n/);
  });
});
