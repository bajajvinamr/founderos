/**
 * Provider credentials service.
 *
 * Single source of truth for "what provider keys does this instance have
 * access to?" Combines:
 *
 *   1. Environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
 *   2. Detected local CLIs on PATH (claude, codex, gemini)
 *   3. Future: user-entered keys stored in the instance secrets store
 *
 * The adapter resolver consumes the normalized ProviderAvailability
 * this service returns.
 */

import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { ProviderAvailability } from "./adapter-resolver.js";

export type ProviderCredentialSource =
  | "env"
  | "cli_installed"
  | "cli_authed"
  | "instance_secret"
  | "none";

export type ProviderCredentialReport = {
  family: "anthropic" | "openai" | "google";
  api: { configured: boolean; source: ProviderCredentialSource };
  cli: { installed: boolean; authed: boolean; path: string | null; source: ProviderCredentialSource };
};

const CLI_PATHS_TO_CHECK = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  process.env.HOME ? `${process.env.HOME}/.local/bin` : null,
  process.env.HOME ? `${process.env.HOME}/.claude/local` : null,
].filter((p): p is string => typeof p === "string");

function findCli(binary: string): string | null {
  // First: try `which` (respects real PATH)
  try {
    const out = execSync(`command -v ${binary}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (out && existsSync(out)) return out;
  } catch {
    // Not on PATH — fall through to manual search.
  }
  for (const dir of CLI_PATHS_TO_CHECK) {
    const full = `${dir}/${binary}`;
    try {
      if (existsSync(full) && statSync(full).isFile()) return full;
    } catch {
      // ignore
    }
  }
  return null;
}

function claudeCliAuthed(cliPath: string): boolean {
  // Claude Code stores OAuth token at ~/.claude/.credentials.json (or
  // similar). A cheap check: presence of that file.
  // We deliberately do NOT shell out to `claude whoami` here because it
  // can be slow (>2s). Trust the credentials file's existence.
  const home = process.env.HOME;
  if (!home) return false;
  const candidatePaths = [
    `${home}/.claude/.credentials.json`,
    `${home}/.claude/credentials.json`,
    `${home}/.claude/auth.json`,
  ];
  void cliPath; // reserved for future richer checks
  return candidatePaths.some((p) => existsSync(p));
}

function codexCliAuthed(cliPath: string): boolean {
  const home = process.env.HOME;
  if (!home) return false;
  void cliPath;
  return existsSync(`${home}/.codex/auth.json`) || existsSync(`${home}/.codex/credentials.json`);
}

function geminiCliAuthed(cliPath: string): boolean {
  const home = process.env.HOME;
  if (!home) return false;
  void cliPath;
  return existsSync(`${home}/.gemini/credentials.json`) || existsSync(`${home}/.config/gcloud/application_default_credentials.json`);
}

export function getProviderCredentialReport(
  storedApiKeys: Set<"anthropic" | "openai" | "google"> = new Set(),
): ProviderCredentialReport[] {
  const env = process.env;

  const claudeCli = findCli("claude");
  const codexCli = findCli("codex");
  const geminiCli = findCli("gemini");

  const anthropicEnv = Boolean(env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim().length > 0);
  const openaiEnv = Boolean(env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim().length > 0);
  const googleEnv = Boolean(
    (env.GEMINI_API_KEY && env.GEMINI_API_KEY.trim().length > 0) ||
      (env.GOOGLE_API_KEY && env.GOOGLE_API_KEY.trim().length > 0),
  );

  return [
    {
      family: "anthropic",
      api: {
        configured: anthropicEnv || storedApiKeys.has("anthropic"),
        source: anthropicEnv ? "env" : storedApiKeys.has("anthropic") ? "instance_secret" : "none",
      },
      cli: {
        installed: claudeCli !== null,
        authed: claudeCli ? claudeCliAuthed(claudeCli) : false,
        path: claudeCli,
        source: claudeCli ? "cli_installed" : "none",
      },
    },
    {
      family: "openai",
      api: {
        configured: openaiEnv || storedApiKeys.has("openai"),
        source: openaiEnv ? "env" : storedApiKeys.has("openai") ? "instance_secret" : "none",
      },
      cli: {
        installed: codexCli !== null,
        authed: codexCli ? codexCliAuthed(codexCli) : false,
        path: codexCli,
        source: codexCli ? "cli_installed" : "none",
      },
    },
    {
      family: "google",
      api: {
        configured: googleEnv || storedApiKeys.has("google"),
        source: googleEnv ? "env" : storedApiKeys.has("google") ? "instance_secret" : "none",
      },
      cli: {
        installed: geminiCli !== null,
        authed: geminiCli ? geminiCliAuthed(geminiCli) : false,
        path: geminiCli,
        source: geminiCli ? "cli_installed" : "none",
      },
    },
  ];
}

/**
 * Compute provider availability combining:
 *   - Env vars (ANTHROPIC_API_KEY etc.)
 *   - Locally installed CLIs (claude, codex, gemini on PATH)
 *   - Optional `storedApiKeys` set from the DB (instance_api_keys table).
 *
 * The DB read happens in the caller (route handler or service) so this
 * function stays pure + testable.
 */
export function getProviderAvailability(
  storedApiKeys?: Set<"anthropic" | "openai" | "google">,
): ProviderAvailability {
  const report = getProviderCredentialReport(storedApiKeys);
  const byFamily = Object.fromEntries(report.map((r) => [r.family, r])) as Record<
    "anthropic" | "openai" | "google",
    ProviderCredentialReport
  >;

  const availability: ProviderAvailability = {
    anthropic: {
      api: byFamily.anthropic.api.configured,
      cli: byFamily.anthropic.cli.installed,
    },
    openai: {
      api: byFamily.openai.api.configured,
      cli: byFamily.openai.cli.installed,
    },
    google: {
      api: byFamily.google.api.configured,
      cli: byFamily.google.cli.installed,
    },
    anyConfigured: false,
  };

  availability.anyConfigured =
    availability.anthropic.api || availability.anthropic.cli ||
    availability.openai.api || availability.openai.cli ||
    availability.google.api || availability.google.cli;

  return availability;
}
