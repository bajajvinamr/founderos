import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listCodexSkills,
  syncCodexSkills,
} from "@founderos/adapter-codex-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("codex local skill sync", () => {
  const founderosKey = "founderos-ai/founderos/founderos";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("reports configured FounderOS skills for workspace injection on the next run", async () => {
    const codexHome = await makeTempDir("founderos-codex-skill-sync-");
    cleanupDirs.add(codexHome);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        founderosSkillSync: {
          desiredSkills: [founderosKey],
        },
      },
    } as const;

    const before = await listCodexSkills(ctx);
    expect(before.mode).toBe("ephemeral");
    expect(before.desiredSkills).toContain(founderosKey);
    expect(before.entries.find((entry) => entry.key === founderosKey)?.required).toBe(true);
    expect(before.entries.find((entry) => entry.key === founderosKey)?.state).toBe("configured");
    expect(before.entries.find((entry) => entry.key === founderosKey)?.detail).toContain("CODEX_HOME/skills/");
  });

  it("does not persist FounderOS skills into CODEX_HOME during sync", async () => {
    const codexHome = await makeTempDir("founderos-codex-skill-prune-");
    cleanupDirs.add(codexHome);

    const configuredCtx = {
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        founderosSkillSync: {
          desiredSkills: [founderosKey],
        },
      },
    } as const;

    const after = await syncCodexSkills(configuredCtx, [founderosKey]);
    expect(after.mode).toBe("ephemeral");
    expect(after.entries.find((entry) => entry.key === founderosKey)?.state).toBe("configured");
    await expect(fs.lstat(path.join(codexHome, "skills", "founderos"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps required bundled FounderOS skills configured even when the desired set is emptied", async () => {
    const codexHome = await makeTempDir("founderos-codex-skill-required-");
    cleanupDirs.add(codexHome);

    const configuredCtx = {
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        founderosSkillSync: {
          desiredSkills: [],
        },
      },
    } as const;

    const after = await syncCodexSkills(configuredCtx, []);
    expect(after.desiredSkills).toContain(founderosKey);
    expect(after.entries.find((entry) => entry.key === founderosKey)?.state).toBe("configured");
  });

  it("normalizes legacy flat FounderOS skill refs before reporting configured state", async () => {
    const codexHome = await makeTempDir("founderos-codex-legacy-skill-sync-");
    cleanupDirs.add(codexHome);

    const snapshot = await listCodexSkills({
      agentId: "agent-3",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        founderosSkillSync: {
          desiredSkills: ["founderos"],
        },
      },
    });

    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.desiredSkills).toContain(founderosKey);
    expect(snapshot.desiredSkills).not.toContain("founderos");
    expect(snapshot.entries.find((entry) => entry.key === founderosKey)?.state).toBe("configured");
    expect(snapshot.entries.find((entry) => entry.key === "founderos")).toBeUndefined();
  });
});
