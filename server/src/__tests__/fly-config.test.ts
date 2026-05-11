import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// S8 P0.1 Phase 1A regression guard. The hosted claude execution path
// (Council R1 conditions C3 + C4) requires specific Fly machine sizing,
// graceful-shutdown timeout, and a default-OFF feature flag. A future
// edit that silently reverts any of these values would re-open the
// failure window the council closed. Plain string assertions on
// fly.toml are sufficient — adding a TOML parser dependency for one
// test isn't justified, and the regex form is robust enough for the
// flat top-level keys we're checking.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// server/src/__tests__/fly-config.test.ts → repo root
const FLY_TOML_PATH = path.resolve(__dirname, "../../../fly.toml");
const DOCKERFILE_PATH = path.resolve(__dirname, "../../../Dockerfile");

function readFly(): string {
  return fs.readFileSync(FLY_TOML_PATH, "utf8");
}

function readDockerfile(): string {
  return fs.readFileSync(DOCKERFILE_PATH, "utf8");
}

/**
 * Match a top-level `key = "value"` or `key = value` assignment, anchored
 * to start-of-line so we don't match commented-out copies or sub-table keys.
 * The regex tolerates surrounding whitespace and an optional trailing comment.
 */
function findScalarAssignment(
  source: string,
  key: string,
): string | null {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\n#]+?)"?\\s*(?:#.*)?$`, "m");
  const m = source.match(re);
  return m ? m[1].trim() : null;
}

describe("fly.toml — S8 P0.1 Phase 1A invariants", () => {
  it("kill_timeout is 30s (graceful claude subprocess shutdown window)", () => {
    const v = findScalarAssignment(readFly(), "kill_timeout");
    expect(v).toBe("30s");
  });

  it("min_machines_running is 1 (warm machine for hosted execution)", () => {
    const v = findScalarAssignment(readFly(), "min_machines_running");
    expect(v).toBe("1");
  });

  it('auto_stop_machines is "suspend" (warm snapshot, not cold stop)', () => {
    const v = findScalarAssignment(readFly(), "auto_stop_machines");
    expect(v).toBe("suspend");
  });

  it("[[vm]] memory is 2gb (headroom for concurrent claude jobs)", () => {
    const v = findScalarAssignment(readFly(), "memory");
    expect(v).toBe("2gb");
  });

  it('[[vm]] size is shared-cpu-2x', () => {
    const v = findScalarAssignment(readFly(), "size");
    expect(v).toBe("shared-cpu-2x");
  });

  it("[[vm]] cpus is 2", () => {
    const v = findScalarAssignment(readFly(), "cpus");
    expect(v).toBe("2");
  });

  it('FOUNDEROS_HOSTED_AGENTS_ENABLED defaults to "0" (keystone flag, OFF until founder flips)', () => {
    const fly = readFly();
    // Match the [env] table assignment with the surrounding double-quotes preserved
    const m = fly.match(/^\s*FOUNDEROS_HOSTED_AGENTS_ENABLED\s*=\s*"([^"]+)"/m);
    expect(m, "FOUNDEROS_HOSTED_AGENTS_ENABLED must be present in [env]").not.toBeNull();
    expect(m?.[1]).toBe("0");
  });
});

describe("Dockerfile — S8 P0.1 Phase 1A invariants", () => {
  it("creates /founderos/agents with correct ownership for hosted runs", () => {
    const df = readDockerfile();
    expect(df).toMatch(/mkdir\s+-p[^\n]*\/founderos\/agents/);
    // Recursive chown so the agents subdir is owned by node, not just /founderos.
    expect(df).toMatch(/chown\s+-R\s+node:node\s+\/founderos/);
  });

  it("installs @anthropic-ai/claude-code globally (hosted execution dependency)", () => {
    const df = readDockerfile();
    expect(df).toMatch(/npm\s+install[^\n]*--global[^\n]*@anthropic-ai\/claude-code/);
  });
});
