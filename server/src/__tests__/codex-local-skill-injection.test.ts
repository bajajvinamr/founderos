import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCodexSkillsInjected } from "@founderos/adapter-codex-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createFounderOSRepoSkill(root: string, skillName: string) {
  await fs.mkdir(path.join(root, "server"), { recursive: true });
  await fs.mkdir(path.join(root, "packages", "adapter-utils"), { recursive: true });
  await fs.mkdir(path.join(root, "skills", skillName), { recursive: true });
  await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"founderos"}\n', "utf8");
  await fs.writeFile(
    path.join(root, "skills", skillName, "SKILL.md"),
    `---\nname: ${skillName}\n---\n`,
    "utf8",
  );
}

async function createCustomSkill(root: string, skillName: string) {
  await fs.mkdir(path.join(root, "custom", skillName), { recursive: true });
  await fs.writeFile(
    path.join(root, "custom", skillName, "SKILL.md"),
    `---\nname: ${skillName}\n---\n`,
    "utf8",
  );
}

describe("codex local adapter skill injection", () => {
  const founderosKey = "founderos-ai/founderos/founderos";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("repairs a Codex FounderOS skill symlink that still points at another live checkout", async () => {
    const currentRepo = await makeTempDir("founderos-codex-current-");
    const oldRepo = await makeTempDir("founderos-codex-old-");
    const skillsHome = await makeTempDir("founderos-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(oldRepo);
    cleanupDirs.add(skillsHome);

    await createFounderOSRepoSkill(currentRepo, "founderos");
    await createFounderOSRepoSkill(oldRepo, "founderos");
    await fs.symlink(path.join(oldRepo, "skills", "founderos"), path.join(skillsHome, "founderos"));

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await ensureCodexSkillsInjected(
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      {
        skillsHome,
        skillsEntries: [{
          key: founderosKey,
          runtimeName: "founderos",
          source: path.join(currentRepo, "skills", "founderos"),
        }],
      },
    );

    expect(await fs.realpath(path.join(skillsHome, "founderos"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "founderos")),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Repaired Codex skill "founderos"'),
      }),
    );
  });

  it("preserves a custom Codex skill symlink outside FounderOS repo checkouts", async () => {
    const currentRepo = await makeTempDir("founderos-codex-current-");
    const customRoot = await makeTempDir("founderos-codex-custom-");
    const skillsHome = await makeTempDir("founderos-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(customRoot);
    cleanupDirs.add(skillsHome);

    await createFounderOSRepoSkill(currentRepo, "founderos");
    await createCustomSkill(customRoot, "founderos");
    await fs.symlink(path.join(customRoot, "custom", "founderos"), path.join(skillsHome, "founderos"));

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{
        key: founderosKey,
        runtimeName: "founderos",
        source: path.join(currentRepo, "skills", "founderos"),
      }],
    });

    expect(await fs.realpath(path.join(skillsHome, "founderos"))).toBe(
      await fs.realpath(path.join(customRoot, "custom", "founderos")),
    );
  });

  it("prunes broken symlinks for unavailable FounderOS repo skills before Codex starts", async () => {
    const currentRepo = await makeTempDir("founderos-codex-current-");
    const oldRepo = await makeTempDir("founderos-codex-old-");
    const skillsHome = await makeTempDir("founderos-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(oldRepo);
    cleanupDirs.add(skillsHome);

    await createFounderOSRepoSkill(currentRepo, "founderos");
    await createFounderOSRepoSkill(oldRepo, "agent-browser");
    const staleTarget = path.join(oldRepo, "skills", "agent-browser");
    await fs.symlink(staleTarget, path.join(skillsHome, "agent-browser"));
    await fs.rm(staleTarget, { recursive: true, force: true });

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await ensureCodexSkillsInjected(
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      {
        skillsHome,
        skillsEntries: [{
          key: founderosKey,
          runtimeName: "founderos",
          source: path.join(currentRepo, "skills", "founderos"),
        }],
      },
    );

    await expect(fs.lstat(path.join(skillsHome, "agent-browser"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Removed stale Codex skill "agent-browser"'),
      }),
    );
  });

  it("preserves other live FounderOS skill symlinks in the shared workspace skill directory", async () => {
    const currentRepo = await makeTempDir("founderos-codex-current-");
    const skillsHome = await makeTempDir("founderos-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(skillsHome);

    await createFounderOSRepoSkill(currentRepo, "founderos");
    await createFounderOSRepoSkill(currentRepo, "agent-browser");
    await fs.symlink(
      path.join(currentRepo, "skills", "agent-browser"),
      path.join(skillsHome, "agent-browser"),
    );

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{
        key: founderosKey,
        runtimeName: "founderos",
        source: path.join(currentRepo, "skills", "founderos"),
      }],
    });

    expect((await fs.lstat(path.join(skillsHome, "founderos"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(skillsHome, "agent-browser"))).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(path.join(skillsHome, "agent-browser"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "agent-browser")),
    );
  });
});
