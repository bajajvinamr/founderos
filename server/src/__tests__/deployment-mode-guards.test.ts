import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertDeploymentModeSafety, isLoopbackHost } from "../lib/deployment-mode-guards.js";

// Trust-boundary invariant tests (Tier 1):
// - local_trusted mode must run on loopback + private exposure (already enforced).
// - non-local_trusted mode must require FOUNDEROS_STRICT_COMPANY_ISOLATION=true so
//   the local_implicit company-access bypass cannot reach a network-exposed
//   surface even via future refactor. These guards run at startup so the
//   misconfiguration cannot silently ship.

describe("isLoopbackHost", () => {
  it.each([
    ["127.0.0.1", true],
    ["localhost", true],
    ["::1", true],
    ["LOCALHOST", true],
    ["  127.0.0.1  ", true],
    ["0.0.0.0", false],
    ["10.0.0.1", false],
    ["example.com", false],
    ["", false],
  ])("isLoopbackHost(%j) = %s", (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});

describe("assertDeploymentModeSafety — local_trusted", () => {
  it("accepts local_trusted on loopback + private exposure", () => {
    expect(() =>
      assertDeploymentModeSafety({
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        host: "127.0.0.1",
      }),
    ).not.toThrow();
  });

  it("rejects local_trusted on non-loopback host", () => {
    expect(() =>
      assertDeploymentModeSafety({
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        host: "0.0.0.0",
      }),
    ).toThrow(/local_trusted mode requires loopback host binding/);
  });

  it("rejects local_trusted with public exposure even on loopback", () => {
    expect(() =>
      assertDeploymentModeSafety({
        deploymentMode: "local_trusted",
        deploymentExposure: "public",
        host: "127.0.0.1",
      }),
    ).toThrow(/local_trusted mode only supports private exposure/);
  });

  it("does NOT require strictCompanyIsolation in local_trusted mode (local_implicit is the trust model)", () => {
    expect(() =>
      assertDeploymentModeSafety({
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        host: "127.0.0.1",
        strictCompanyIsolation: undefined,
      }),
    ).not.toThrow();
  });
});

describe("assertDeploymentModeSafety — authenticated requires STRICT_COMPANY_ISOLATION=true", () => {
  it("rejects authenticated mode when strictCompanyIsolation is undefined", () => {
    expect(() =>
      assertDeploymentModeSafety({
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        host: "0.0.0.0",
        strictCompanyIsolation: undefined,
      }),
    ).toThrow(/FOUNDEROS_STRICT_COMPANY_ISOLATION=true/);
  });

  it("rejects authenticated mode when strictCompanyIsolation is the string 'false'", () => {
    expect(() =>
      assertDeploymentModeSafety({
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        host: "0.0.0.0",
        strictCompanyIsolation: "false",
      }),
    ).toThrow(/FOUNDEROS_STRICT_COMPANY_ISOLATION=true/);
  });

  it("rejects authenticated mode with empty-string strictCompanyIsolation", () => {
    expect(() =>
      assertDeploymentModeSafety({
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        host: "0.0.0.0",
        strictCompanyIsolation: "",
      }),
    ).toThrow(/FOUNDEROS_STRICT_COMPANY_ISOLATION=true/);
  });

  it("only the literal string 'true' satisfies strictCompanyIsolation", () => {
    expect(() =>
      assertDeploymentModeSafety({
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        host: "0.0.0.0",
        strictCompanyIsolation: "TRUE",
      }),
    ).toThrow(/FOUNDEROS_STRICT_COMPANY_ISOLATION=true/);

    expect(() =>
      assertDeploymentModeSafety({
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        host: "0.0.0.0",
        strictCompanyIsolation: "1",
      }),
    ).toThrow(/FOUNDEROS_STRICT_COMPANY_ISOLATION=true/);
  });

  it("accepts authenticated mode when strictCompanyIsolation is 'true'", () => {
    expect(() =>
      assertDeploymentModeSafety({
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        host: "0.0.0.0",
        strictCompanyIsolation: "true",
      }),
    ).not.toThrow();
  });
});
