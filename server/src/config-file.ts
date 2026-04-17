import fs from "node:fs";
import { founderosConfigSchema, type FounderOSConfig } from "@founderos/shared";
import { resolveFounderOSConfigPath } from "./paths.js";

export function readConfigFile(): FounderOSConfig | null {
  const configPath = resolveFounderOSConfigPath();

  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return founderosConfigSchema.parse(raw);
  } catch {
    return null;
  }
}
