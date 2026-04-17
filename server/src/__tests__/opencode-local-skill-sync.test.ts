import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listOpenCodeSkills,
  syncOpenCodeSkills,
} from "@founderos/adapter-opencode-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("opencode local skill sync", () => {
  const founderosKey = "founderos-ai/founderos/founderos";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("reports configured FounderOS skills and installs them into the shared Claude/OpenCode skills home", async () => {
    const home = await makeTempDir("founderos-opencode-skill-sync-");
    cleanupDirs.add(home);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "opencode_local",
      config: {
        env: {
          HOME: home,
        },
        founderosSkillSync: {
          desiredSkills: [founderosKey],
        },
      },
    } as const;

    const before = await listOpenCodeSkills(ctx);
    expect(before.mode).toBe("persistent");
    expect(before.warnings).toContain("OpenCode currently uses the shared Claude skills home (~/.claude/skills).");
    expect(before.desiredSkills).toContain(founderosKey);
    expect(before.entries.find((entry) => entry.key === founderosKey)?.required).toBe(true);
    expect(before.entries.find((entry) => entry.key === founderosKey)?.state).toBe("missing");

    const after = await syncOpenCodeSkills(ctx, [founderosKey]);
    expect(after.entries.find((entry) => entry.key === founderosKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".claude", "skills", "founderos"))).isSymbolicLink()).toBe(true);
  });

  it("keeps required bundled FounderOS skills installed even when the desired set is emptied", async () => {
    const home = await makeTempDir("founderos-opencode-skill-prune-");
    cleanupDirs.add(home);

    const configuredCtx = {
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "opencode_local",
      config: {
        env: {
          HOME: home,
        },
        founderosSkillSync: {
          desiredSkills: [founderosKey],
        },
      },
    } as const;

    await syncOpenCodeSkills(configuredCtx, [founderosKey]);

    const clearedCtx = {
      ...configuredCtx,
      config: {
        env: {
          HOME: home,
        },
        founderosSkillSync: {
          desiredSkills: [],
        },
      },
    } as const;

    const after = await syncOpenCodeSkills(clearedCtx, []);
    expect(after.desiredSkills).toContain(founderosKey);
    expect(after.entries.find((entry) => entry.key === founderosKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".claude", "skills", "founderos"))).isSymbolicLink()).toBe(true);
  });
});
