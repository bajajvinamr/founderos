import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { readConfig } from "../config/store.js";

export type GitWorkspaceInfo = {
  root: string;
  commonDir: string;
  gitDir: string;
  hooksPath: string;
};

export type CopiedGitHooksResult = {
  sourceHooksPath: string;
  targetHooksPath: string;
  copied: boolean;
};

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function readPidFilePort(postmasterPidFile: string): number | null {
  if (!existsSync(postmasterPidFile)) return null;
  try {
    const lines = readFileSync(postmasterPidFile, "utf8").split("\n");
    const port = Number(lines[3]?.trim());
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export function readRunningPostmasterPid(postmasterPidFile: string): number | null {
  if (!existsSync(postmasterPidFile)) return null;
  try {
    const pid = Number(readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

export async function findAvailablePort(preferredPort: number, reserved = new Set<number>()): Promise<number> {
  let port = Math.max(1, Math.trunc(preferredPort));
  while (reserved.has(port) || !(await isPortAvailable(port))) {
    port += 1;
  }
  return port;
}

export function resolveRepoManagedWorktreesRoot(cwd: string): string | null {
  const normalized = path.resolve(cwd);
  const marker = `${path.sep}.founderos${path.sep}worktrees${path.sep}`;
  const index = normalized.indexOf(marker);
  if (index === -1) return null;
  const repoRoot = normalized.slice(0, index);
  return path.resolve(repoRoot, ".founderos", "worktrees");
}

export function collectClaimedWorktreePorts(homeDir: string, currentInstanceId: string, cwd: string): {
  serverPorts: Set<number>;
  databasePorts: Set<number>;
} {
  const serverPorts = new Set<number>();
  const databasePorts = new Set<number>();
  const configPaths = new Set<string>();
  const instancesDir = path.resolve(homeDir, "instances");
  if (existsSync(instancesDir)) {
    for (const entry of readdirSync(instancesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === currentInstanceId) continue;

      const configPath = path.resolve(instancesDir, entry.name, "config.json");
      if (existsSync(configPath)) {
        configPaths.add(configPath);
      }
    }
  }

  const repoManagedWorktreesRoot = resolveRepoManagedWorktreesRoot(cwd);
  if (repoManagedWorktreesRoot && existsSync(repoManagedWorktreesRoot)) {
    for (const entry of readdirSync(repoManagedWorktreesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const configPath = path.resolve(repoManagedWorktreesRoot, entry.name, ".founderos", "config.json");
      if (existsSync(configPath)) {
        configPaths.add(configPath);
      }
    }
  }

  for (const configPath of configPaths) {
    try {
      const config = readConfig(configPath);
      if (config?.server.port) {
        serverPorts.add(config.server.port);
      }
      if (config?.database.mode === "embedded-postgres") {
        databasePorts.add(config.database.embeddedPostgresPort);
      }
    } catch {
      // Ignore malformed sibling configs.
    }
  }

  return { serverPorts, databasePorts };
}

export function detectGitBranchName(cwd: string): string | null {
  try {
    const value = execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return nonEmpty(value);
  } catch {
    return null;
  }
}

export function detectGitWorkspaceInfo(cwd: string): GitWorkspaceInfo | null {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const commonDirRaw = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const gitDirRaw = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const hooksPathRaw = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return {
      root: path.resolve(root),
      commonDir: path.resolve(root, commonDirRaw),
      gitDir: path.resolve(root, gitDirRaw),
      hooksPath: path.resolve(root, hooksPathRaw),
    };
  } catch {
    return null;
  }
}

function copyDirectoryContents(sourceDir: string, targetDir: string): boolean {
  if (!existsSync(sourceDir)) return false;

  const entries = readdirSync(sourceDir, { withFileTypes: true });
  if (entries.length === 0) return false;

  mkdirSync(targetDir, { recursive: true });

  let copied = false;
  for (const entry of entries) {
    const sourcePath = path.resolve(sourceDir, entry.name);
    const targetPath = path.resolve(targetDir, entry.name);

    if (entry.isDirectory()) {
      mkdirSync(targetPath, { recursive: true });
      copyDirectoryContents(sourcePath, targetPath);
      copied = true;
      continue;
    }

    if (entry.isSymbolicLink()) {
      rmSync(targetPath, { recursive: true, force: true });
      symlinkSync(readlinkSync(sourcePath), targetPath);
      copied = true;
      continue;
    }

    copyFileSync(sourcePath, targetPath);
    try {
      chmodSync(targetPath, statSync(sourcePath).mode & 0o777);
    } catch {
      // best effort
    }
    copied = true;
  }

  return copied;
}

export function copyGitHooksToWorktreeGitDir(cwd: string): CopiedGitHooksResult | null {
  const workspace = detectGitWorkspaceInfo(cwd);
  if (!workspace) return null;

  const sourceHooksPath = workspace.hooksPath;
  const targetHooksPath = path.resolve(workspace.gitDir, "hooks");

  if (sourceHooksPath === targetHooksPath) {
    return {
      sourceHooksPath,
      targetHooksPath,
      copied: false,
    };
  }

  return {
    sourceHooksPath,
    targetHooksPath,
    copied: copyDirectoryContents(sourceHooksPath, targetHooksPath),
  };
}

export function rebindWorkspaceCwd(input: {
  sourceRepoRoot: string;
  targetRepoRoot: string;
  workspaceCwd: string;
}): string | null {
  const sourceRepoRoot = path.resolve(input.sourceRepoRoot);
  const targetRepoRoot = path.resolve(input.targetRepoRoot);
  const workspaceCwd = path.resolve(input.workspaceCwd);
  const relative = path.relative(sourceRepoRoot, workspaceCwd);
  if (!relative || relative === "") {
    return targetRepoRoot;
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return path.resolve(targetRepoRoot, relative);
}
