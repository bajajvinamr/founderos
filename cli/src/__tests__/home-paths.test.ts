import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeLocalInstancePaths,
  expandHomePrefix,
  resolveFounderOSHomeDir,
  resolveFounderOSInstanceId,
} from "../config/home.js";

const ORIGINAL_ENV = { ...process.env };

describe("home path resolution", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults to ~/.founderos and default instance", () => {
    delete process.env.FOUNDEROS_HOME;
    delete process.env.FOUNDEROS_INSTANCE_ID;

    const paths = describeLocalInstancePaths();
    expect(paths.homeDir).toBe(path.resolve(os.homedir(), ".founderos"));
    expect(paths.instanceId).toBe("default");
    expect(paths.configPath).toBe(path.resolve(os.homedir(), ".founderos", "instances", "default", "config.json"));
  });

  it("supports FOUNDEROS_HOME and explicit instance ids", () => {
    process.env.FOUNDEROS_HOME = "~/founderos-home";

    const home = resolveFounderOSHomeDir();
    expect(home).toBe(path.resolve(os.homedir(), "founderos-home"));
    expect(resolveFounderOSInstanceId("dev_1")).toBe("dev_1");
  });

  it("rejects invalid instance ids", () => {
    expect(() => resolveFounderOSInstanceId("bad/id")).toThrow(/Invalid instance id/);
  });

  it("expands ~ prefixes", () => {
    expect(expandHomePrefix("~")).toBe(os.homedir());
    expect(expandHomePrefix("~/x/y")).toBe(path.resolve(os.homedir(), "x/y"));
  });
});
