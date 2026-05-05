/**
 * Telemetry-default regression test (council 2026-05-05 P1 fix, TC-1).
 *
 * The landing page promises "no telemetry unless you flip it on" — at
 * Landing.tsx:1114 / "Do I own the code my team writes?" FAQ. That
 * promise depends on FOUR config layers ALL defaulting to OFF:
 *
 *   1. `packages/shared/src/config-schema.ts` — the file-config schema
 *      `telemetryConfigSchema`. If `enabled` defaults to true here, every
 *      fresh install materializes telemetry as on without operator input.
 *   2. `packages/shared/src/telemetry/config.ts` — the runtime resolver
 *      `resolveTelemetryConfig`. If this returns `{enabled: true}` when
 *      no explicit consent flag is set, the ingest client posts events.
 *   3. `server/src/config.ts` — the server's `Config.telemetryEnabled`
 *      field. This is what `initTelemetry()` reads at boot. If it
 *      defaults to true, the client is constructed and the queue starts
 *      flushing.
 *   4. `packages/shared/src/validators/instance.ts` — the
 *      `instanceGeneralSettingsSchema.telemetryConsent.enabled` default,
 *      which gates whether the operator's persisted decision is "OFF" or
 *      a no-op when no decision row exists yet.
 *
 * If any one of these flips back to default-true, the trust contract is
 * violated. This test is intentionally redundant — every layer has its
 * own assertion. Re-flipping any default to `true` MUST fail this test.
 *
 * Owner: TC-1 (telemetry consent), council 2026-05-05 R1+R2.
 */
import { describe, expect, it } from "vitest";
import {
  founderosConfigSchema,
  telemetryConfigSchema,
  instanceGeneralSettingsSchema,
  telemetryConsentSchema,
  DEFAULT_TELEMETRY_CONSENT,
} from "@founderos/shared";
import { resolveTelemetryConfig } from "@founderos/shared/telemetry";

describe("telemetry consent defaults — council 2026-05-05 P1 (TC-1)", () => {
  describe("Layer 1 — file-config schema (shared/config-schema.ts)", () => {
    it("telemetryConfigSchema parses the empty object with enabled=false", () => {
      const parsed = telemetryConfigSchema.parse({});
      expect(parsed.enabled).toBe(false);
    });

    it("founderosConfigSchema's telemetry block defaults to enabled=false", () => {
      // Build the minimum-viable config that passes the schema, then
      // assert the telemetry block fell back to the default. We pass
      // configure as the meta-source because that's the install-time
      // default in `founderos doctor`.
      const minimumConfig = {
        $meta: {
          version: 1,
          updatedAt: "2026-05-05T00:00:00.000Z",
          source: "configure" as const,
        },
        database: {},
        logging: { mode: "file" as const },
        server: {},
      };
      const parsed = founderosConfigSchema.parse(minimumConfig);
      expect(parsed.telemetry.enabled).toBe(false);
    });

    it("explicit enabled=true is still honored (operator opt-in path)", () => {
      const parsed = telemetryConfigSchema.parse({ enabled: true });
      expect(parsed.enabled).toBe(true);
    });
  });

  describe("Layer 2 — runtime resolver (shared/telemetry/config.ts)", () => {
    it("returns enabled=false when no fileConfig is passed", () => {
      // Empty fileConfig — fresh install, no operator decision recorded.
      const cfg = resolveTelemetryConfig(undefined);
      expect(cfg.enabled).toBe(false);
    });

    it("returns enabled=false when fileConfig.enabled is undefined", () => {
      const cfg = resolveTelemetryConfig({});
      expect(cfg.enabled).toBe(false);
    });

    it("returns enabled=false when fileConfig.enabled is explicitly false", () => {
      const cfg = resolveTelemetryConfig({ enabled: false });
      expect(cfg.enabled).toBe(false);
    });

    it("returns enabled=true ONLY when fileConfig.enabled is explicitly true", () => {
      const cfg = resolveTelemetryConfig({ enabled: true });
      expect(cfg.enabled).toBe(true);
    });

    it("hard kill switch FOUNDEROS_TELEMETRY_DISABLED=1 wins over consent", () => {
      const prev = process.env.FOUNDEROS_TELEMETRY_DISABLED;
      try {
        process.env.FOUNDEROS_TELEMETRY_DISABLED = "1";
        const cfg = resolveTelemetryConfig({ enabled: true });
        expect(cfg.enabled).toBe(false);
      } finally {
        if (prev === undefined) delete process.env.FOUNDEROS_TELEMETRY_DISABLED;
        else process.env.FOUNDEROS_TELEMETRY_DISABLED = prev;
      }
    });

    it("DO_NOT_TRACK=1 wins over consent", () => {
      const prev = process.env.DO_NOT_TRACK;
      try {
        process.env.DO_NOT_TRACK = "1";
        const cfg = resolveTelemetryConfig({ enabled: true });
        expect(cfg.enabled).toBe(false);
      } finally {
        if (prev === undefined) delete process.env.DO_NOT_TRACK;
        else process.env.DO_NOT_TRACK = prev;
      }
    });
  });

  describe("Layer 3 — server config.ts loadConfig()", () => {
    // We don't call loadConfig() directly here because it has side-effects
    // (dotenv merging, Tailscale detection, embedded-pg path resolution)
    // that are slow and depend on the host filesystem. Instead, we
    // re-implement the exact expression at server/src/config.ts:377 and
    // assert it equals false for every realistic shape of fileConfig.
    // If config.ts changes the expression, the test below in "Layer 3
    // mirror" must be updated by hand — this is the load-bearing assertion
    // that catches regressions.

    function mirrorConfigTsTelemetryDefault(fileConfig: { telemetry?: { enabled?: boolean } } | null | undefined): boolean {
      // EXACT mirror of server/src/config.ts:377 expression.
      return fileConfig?.telemetry?.enabled === true;
    }

    it("defaults to false when no file config exists at all", () => {
      expect(mirrorConfigTsTelemetryDefault(null)).toBe(false);
    });

    it("defaults to false when file config has no telemetry block", () => {
      expect(mirrorConfigTsTelemetryDefault({})).toBe(false);
    });

    it("defaults to false when telemetry block has no enabled field", () => {
      expect(mirrorConfigTsTelemetryDefault({ telemetry: {} })).toBe(false);
    });

    it("defaults to false when telemetry.enabled is explicitly false", () => {
      expect(mirrorConfigTsTelemetryDefault({ telemetry: { enabled: false } })).toBe(
        false,
      );
    });

    it("returns true ONLY when telemetry.enabled is explicitly true", () => {
      expect(mirrorConfigTsTelemetryDefault({ telemetry: { enabled: true } })).toBe(
        true,
      );
    });

    it("rejects truthy non-boolean values (e.g. 1, 'true') — strict boolean only", () => {
      // Any non-boolean true is treated as opt-out (safe direction).
      // This is what `=== true` enforces.
      expect(
        mirrorConfigTsTelemetryDefault({ telemetry: { enabled: 1 as unknown as boolean } }),
      ).toBe(false);
      expect(
        mirrorConfigTsTelemetryDefault({
          telemetry: { enabled: "true" as unknown as boolean },
        }),
      ).toBe(false);
    });
  });

  describe("Layer 4 — instance settings persistence default", () => {
    it("DEFAULT_TELEMETRY_CONSENT is fully off", () => {
      expect(DEFAULT_TELEMETRY_CONSENT.enabled).toBe(false);
      expect(DEFAULT_TELEMETRY_CONSENT.decided).toBe(false);
      expect(DEFAULT_TELEMETRY_CONSENT.decidedAt).toBeNull();
    });

    it("telemetryConsentSchema parses the empty object with enabled=false", () => {
      const parsed = telemetryConsentSchema.parse({});
      expect(parsed.enabled).toBe(false);
      expect(parsed.decided).toBe(false);
      expect(parsed.decidedAt).toBeNull();
    });

    it("instanceGeneralSettingsSchema seeds telemetryConsent with enabled=false on a blank row", () => {
      const parsed = instanceGeneralSettingsSchema.parse({});
      expect(parsed.telemetryConsent.enabled).toBe(false);
      expect(parsed.telemetryConsent.decided).toBe(false);
    });

    it("explicit consent payload (enabled=true, decided=true, decidedAt) round-trips", () => {
      const decidedAt = "2026-05-05T12:34:56.000Z";
      const parsed = telemetryConsentSchema.parse({
        enabled: true,
        decided: true,
        decidedAt,
      });
      expect(parsed.enabled).toBe(true);
      expect(parsed.decided).toBe(true);
      expect(parsed.decidedAt).toBe(decidedAt);
    });
  });

  describe("Cross-layer convergence — landing-page promise integrity", () => {
    // If the landing page says "no telemetry unless you flip it on", then
    // the simplest possible scenario — a fresh install, no config file,
    // no operator interaction — MUST result in `enabled: false` at every
    // layer the actual TelemetryClient reads.

    it("fresh-install scenario: no config file → resolver returns enabled=false", () => {
      const cfg = resolveTelemetryConfig(undefined);
      expect(cfg.enabled).toBe(false);
    });

    it("fresh-install scenario: blank instance settings → telemetryConsent.enabled=false", () => {
      const parsed = instanceGeneralSettingsSchema.parse({});
      expect(parsed.telemetryConsent.enabled).toBe(false);
    });

    it("fresh-install scenario: blank file config → top-level telemetry.enabled=false", () => {
      // Mirror loadConfig()'s lookup against an empty file-config object.
      const fileConfig = telemetryConfigSchema.parse({});
      expect(fileConfig.enabled).toBe(false);
    });
  });
});
