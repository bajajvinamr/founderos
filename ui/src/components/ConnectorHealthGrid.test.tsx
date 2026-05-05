// @vitest-environment node

/**
 * ConnectorHealthGrid.test.tsx — pure logic tests for connector health UI helpers.
 *
 * Covers exported pure functions (no DOM needed):
 *   - statusPillClass: maps ConnectorHealthStatus → Tailwind pill class
 *   - statusLabel: maps ConnectorHealthStatus → human-readable label
 *   - dotClass: maps ConnectorHealthStatus → dot colour class
 *
 * Also covers freshnessColor from CompanyPulseWidget (timestamp → colour class).
 *
 * Grid component rendering is integration territory (tanstack-query provider);
 * kept out of scope here per the @vitest-environment node annotation.
 */

import { describe, expect, it } from "vitest";
import {
  statusPillClass,
  statusLabel,
  dotClass,
  type ConnectorHealthStatus,
} from "./ConnectorHealthGrid";
import { freshnessColor } from "./CompanyPulseWidget";

// ── statusPillClass ───────────────────────────────────────────────────────────

describe("statusPillClass", () => {
  it("returns emerald classes for connected", () => {
    const cls = statusPillClass("connected");
    expect(cls).toContain("emerald");
  });

  it("returns amber classes for syncing", () => {
    const cls = statusPillClass("syncing");
    expect(cls).toContain("amber");
  });

  it("returns red classes for failed", () => {
    const cls = statusPillClass("failed");
    expect(cls).toContain("red");
  });

  it("returns muted classes for never_connected", () => {
    const cls = statusPillClass("never_connected");
    expect(cls).toContain("muted");
  });

  it("covers all 4 statuses without throwing", () => {
    const statuses: ConnectorHealthStatus[] = ["connected", "syncing", "failed", "never_connected"];
    for (const s of statuses) {
      expect(() => statusPillClass(s)).not.toThrow();
    }
  });
});

// ── statusLabel ───────────────────────────────────────────────────────────────

describe("statusLabel", () => {
  it("returns 'Connected' for connected", () => {
    expect(statusLabel("connected")).toBe("Connected");
  });

  it("returns 'Syncing' for syncing", () => {
    expect(statusLabel("syncing")).toBe("Syncing");
  });

  it("returns 'Failed' for failed", () => {
    expect(statusLabel("failed")).toBe("Failed");
  });

  it("returns 'Not connected' for never_connected", () => {
    expect(statusLabel("never_connected")).toBe("Not connected");
  });
});

// ── dotClass ──────────────────────────────────────────────────────────────────

describe("dotClass", () => {
  it("returns emerald for connected", () => {
    expect(dotClass("connected")).toContain("emerald");
  });

  it("returns amber + animate-pulse for syncing", () => {
    const cls = dotClass("syncing");
    expect(cls).toContain("amber");
    expect(cls).toContain("animate-pulse");
  });

  it("returns red for failed", () => {
    expect(dotClass("failed")).toContain("red");
  });

  it("returns muted for never_connected", () => {
    expect(dotClass("never_connected")).toContain("muted");
  });
});

// ── freshnessColor (from CompanyPulseWidget) ──────────────────────────────────

describe("freshnessColor", () => {
  it("returns muted colour for null input", () => {
    const cls = freshnessColor(null);
    expect(cls).toContain("muted");
  });

  it("returns green for a very recent timestamp (<15m ago)", () => {
    const recentIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const cls = freshnessColor(recentIso);
    expect(cls).toContain("emerald");
  });

  it("returns amber for a timestamp between 15m and 1h ago", () => {
    const staleIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const cls = freshnessColor(staleIso);
    expect(cls).toContain("amber");
  });

  it("returns red for a timestamp older than 1h", () => {
    const oldIso = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    const cls = freshnessColor(oldIso);
    expect(cls).toContain("red");
  });

  it("boundary: exactly 15m ago is amber (>15m threshold is red, >15m is amber bucket)", () => {
    // 16 minutes ago → amber bucket (>15m, <60m)
    const sixteenMinAgo = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    expect(freshnessColor(sixteenMinAgo)).toContain("amber");

    // 14 minutes ago → green bucket (<15m)
    const fourteenMinAgo = new Date(Date.now() - 14 * 60 * 1000).toISOString();
    expect(freshnessColor(fourteenMinAgo)).toContain("emerald");
  });
});
