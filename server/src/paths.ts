import fs from "node:fs";
import path from "node:path";
import { resolveDefaultConfigPath } from "./home-paths.js";

const FOUNDEROS_CONFIG_BASENAME = "config.json";
const FOUNDEROS_ENV_FILENAME = ".env";

function findConfigFileFromAncestors(startDir: string): string | null {
  const absoluteStartDir = path.resolve(startDir);
  let currentDir = absoluteStartDir;

  while (true) {
    const candidate = path.resolve(currentDir, ".founderos", FOUNDEROS_CONFIG_BASENAME);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const nextDir = path.resolve(currentDir, "..");
    if (nextDir === currentDir) break;
    currentDir = nextDir;
  }

  return null;
}

export function resolveFounderOSConfigPath(overridePath?: string): string {
  if (overridePath) return path.resolve(overridePath);
  if (process.env.FOUNDEROS_CONFIG) return path.resolve(process.env.FOUNDEROS_CONFIG);
  return findConfigFileFromAncestors(process.cwd()) ?? resolveDefaultConfigPath();
}

export function resolveFounderOSEnvPath(overrideConfigPath?: string): string {
  return path.resolve(path.dirname(resolveFounderOSConfigPath(overrideConfigPath)), FOUNDEROS_ENV_FILENAME);
}
