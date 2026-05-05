import { describe, it, expect } from "vitest";
import { formatLastSync } from "./IntegrationCard";

describe("formatLastSync", () => {
  it("formats 'Just now' for recent syncs (< 60s)", () => {
    const now = new Date();
    const fiveSecondsAgo = new Date(now.getTime() - 5000).toISOString();
    expect(formatLastSync(fiveSecondsAgo)).toBe("Just now");
  });

  it("formats minutes ago", () => {
    const now = new Date();
    const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60000).toISOString();
    expect(formatLastSync(thirtyMinutesAgo)).toBe("30m ago");
  });

  it("formats hours ago", () => {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 3600000).toISOString();
    expect(formatLastSync(twoHoursAgo)).toBe("2h ago");
  });

  it("formats days ago", () => {
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 86400000).toISOString();
    expect(formatLastSync(threeDaysAgo)).toBe("3d ago");
  });

  it("returns 'Never synced' for null", () => {
    expect(formatLastSync(null)).toBe("Never synced");
  });

  it("returns 'Never synced' for undefined", () => {
    expect(formatLastSync(undefined)).toBe("Never synced");
  });

  it("returns 'Never synced' for 'never' string", () => {
    expect(formatLastSync("never")).toBe("Never synced");
  });

  it("returns 'Never synced' for invalid dates", () => {
    expect(formatLastSync("not-a-date")).toBe("Never synced");
  });

  it("returns 'Never synced' for empty string", () => {
    expect(formatLastSync("")).toBe("Never synced");
  });

  it("handles valid ISO date strings", () => {
    const validDate = new Date("2026-05-05T12:00:00Z").toISOString();
    const result = formatLastSync(validDate);
    expect(result).toMatch(/^(Just now|\d+[mhd] ago)$/);
  });

  it("is safe with NaN values", () => {
    const result = formatLastSync("invalid-date-string");
    expect(result).toBe("Never synced");
    expect(result).not.toContain("NaN");
  });
});
