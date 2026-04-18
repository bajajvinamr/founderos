import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeBind, validateConfiguredBindMode } from "@founderos/shared";
import { buildPresetServerConfig } from "../config/server-bind.js";
import * as child_process from "child_process";

vi.mock("child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof child_process>();
  return { ...orig, execFileSync: vi.fn() };
});

const mockedExecFileSync = vi.mocked(child_process.execFileSync);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("network bind helpers", () => {
  it("rejects non-loopback bind modes in local_trusted", () => {
    expect(
      validateConfiguredBindMode({
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        bind: "lan",
        host: "0.0.0.0",
      }),
    ).toContain("local_trusted requires server.bind=loopback");
  });

  it("resolves tailnet bind using the detected tailscale address", () => {
    const resolved = resolveRuntimeBind({
      bind: "tailnet",
      host: "127.0.0.1",
      tailnetBindHost: "100.64.0.8",
    });

    expect(resolved.errors).toEqual([]);
    expect(resolved.host).toBe("100.64.0.8");
  });

  it("requires a custom bind host when bind=custom", () => {
    const resolved = resolveRuntimeBind({
      bind: "custom",
      host: "127.0.0.1",
    });

    expect(resolved.errors).toContain("server.customBindHost is required when server.bind=custom");
  });

  it("stores the detected tailscale address for tailnet presets", () => {
    process.env.FOUNDEROS_TAILNET_BIND_HOST = "100.64.0.8";
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("tailscale not found");
    });

    const preset = buildPresetServerConfig("tailnet", {
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    });

    expect(preset.server.host).toBe("100.64.0.8");

    delete process.env.FOUNDEROS_TAILNET_BIND_HOST;
  });

  it("falls back to loopback when no tailscale address is available for tailnet presets", () => {
    delete process.env.FOUNDEROS_TAILNET_BIND_HOST;
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("tailscale not found");
    });

    const preset = buildPresetServerConfig("tailnet", {
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    });

    expect(preset.server.host).toBe("127.0.0.1");
  });
});
