/**
 * Per-job workdir helper for hosted multi-tenant claude execution.
 *
 * Council R1 condition C1 — the legacy server execute path used a single
 * shared `HOME=/founderos` for every spawned claude subprocess, which means
 * tenant A's session state, prompt cache, and login tokens were visible to
 * tenant B. This builds an isolated workdir per (companyId, runId) so the
 * claude CLI's on-disk state cannot cross tenant boundaries.
 *
 * Layout:
 *   <root>/<companyId>/<runId>/
 *     home/    -> HOME for the spawned process (claude session state lives here)
 *     cache/   -> CLAUDE_PROMPT_CACHE_DIR
 *     cwd/    -> spawn cwd if no workspace cwd is configured
 *
 * Mode 0700 on every directory so other tenants cannot read each other's
 * session state even when the underlying UID is shared. Defense in depth
 * against future container-shared-UID scenarios.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface JobWorkdir {
  /** Absolute path used as the spawned subprocess `HOME` env var. */
  home: string;
  /** Absolute path used as the spawned subprocess `CLAUDE_PROMPT_CACHE_DIR` env var. */
  cache: string;
  /** Absolute path used as the spawn `cwd` when no workspace cwd is configured. */
  cwd: string;
  /** Workdir root (parent of `home`, `cache`, `cwd`); cleanup target. */
  root: string;
}

export interface BuildJobWorkdirInput {
  companyId: string;
  runId: string;
  /**
   * Override the default `/founderos/agents` parent. Tests pass a tmpdir-rooted
   * path so they don't need privileged write access.
   */
  rootDir?: string;
}

/**
 * Build a per-job workdir at `<rootDir>/<companyId>/<runId>/` with `home`,
 * `cache`, and `cwd` subdirectories. Each directory is created with mode
 * `0700` so other tenants cannot read across the boundary.
 *
 * Returns absolute paths. Caller is responsible for cleanup (best-effort
 * `fs.rm(root, { recursive: true, force: true })`).
 */
export async function buildJobWorkdir(input: BuildJobWorkdirInput): Promise<JobWorkdir> {
  const { companyId, runId, rootDir = "/founderos/agents" } = input;
  const root = path.resolve(rootDir, companyId, runId);
  const home = path.join(root, "home");
  const cache = path.join(root, "cache");
  const cwd = path.join(root, "cwd");

  // mode 0o700 so other tenants can't read the dir even if they share UID
  // (defense in depth). mkdir-recursive may inherit a permissive umask on
  // some systems, so we explicitly chmod after creation.
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.mkdir(cache, { recursive: true, mode: 0o700 });
  await fs.mkdir(cwd, { recursive: true, mode: 0o700 });
  await fs.chmod(home, 0o700);
  await fs.chmod(cache, 0o700);
  await fs.chmod(cwd, 0o700);

  return { home, cache, cwd, root };
}
