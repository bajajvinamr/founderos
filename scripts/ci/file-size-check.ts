#!/usr/bin/env tsx
/**
 * File-size gate.
 *
 * Per the 2026-04-23 forward plan, no new file may be authored >2500 lines;
 * warn at 1500. Existing offenders are grandfathered via an allowlist so
 * this job can land without requiring a full refactor sprint.
 *
 * Config (env):
 *   FILE_SIZE_WARN_LINES    warning threshold (default 1500)
 *   FILE_SIZE_FAIL_LINES    failure threshold (default 2500)
 *   FILE_SIZE_BASE_REF      base ref for changed-files diff (default "origin/main")
 *   FILE_SIZE_MODE          "changed" (default, CI) or "all" (repo-wide audit)
 *   GITHUB_STEP_SUMMARY     if set, appends a markdown table
 *   GITHUB_OUTPUT           if set, emits `warn_count=` and `fail_count=`
 *
 * Exits 0 on pass, 1 if any file is at/over FAIL threshold.
 * Warnings do not fail the job.
 *
 * Allowlist: .github/file-size-allowlist.txt (one glob or path per line,
 * lines starting with `#` are comments).
 */
import {
  readFileSync,
  existsSync,
  appendFileSync,
  statSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);

const warnLines = Number.parseInt(process.env.FILE_SIZE_WARN_LINES ?? "1500", 10);
const failLines = Number.parseInt(process.env.FILE_SIZE_FAIL_LINES ?? "2500", 10);
const baseRef = process.env.FILE_SIZE_BASE_REF ?? "origin/main";
const mode = (process.env.FILE_SIZE_MODE ?? "changed") as "changed" | "all";

if (!Number.isFinite(warnLines) || warnLines <= 0) {
  console.error(`[file-size] invalid FILE_SIZE_WARN_LINES=${process.env.FILE_SIZE_WARN_LINES}`);
  process.exit(2);
}
if (!Number.isFinite(failLines) || failLines <= warnLines) {
  console.error(`[file-size] FILE_SIZE_FAIL_LINES must be > FILE_SIZE_WARN_LINES`);
  process.exit(2);
}

// Extensions we audit. Generated / binary / vendor files stay out.
const AUDIT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

// Built-in exemptions. Allowlist file extends these.
const BUILTIN_EXEMPTIONS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/*.d.ts",
  "**/__snapshots__/**",
  // Generated routes + migration SQL are tracked elsewhere.
  "**/migrations/**",
];

function loadAllowlist(): string[] {
  const path = resolve(repoRoot, ".github/file-size-allowlist.txt");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

/**
 * Minimal glob matcher — supports `**` as "any path segments" and `*` as
 * "any chars except /". Written zero-dep because CI script tree shouldn't
 * drag picomatch transitively for a 20-line task.
 */
function globToRegex(glob: string): RegExp {
  // Escape regex specials except those we translate.
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const translated = escaped
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${translated}$`);
}

function isExempt(relPath: string, allowlist: string[]): boolean {
  const patterns = [...BUILTIN_EXEMPTIONS, ...allowlist];
  for (const p of patterns) {
    if (p === relPath) return true;
    if (globToRegex(p).test(relPath)) return true;
  }
  return false;
}

function hasAuditExtension(path: string): boolean {
  return AUDIT_EXTENSIONS.some((ext) => path.endsWith(ext));
}

function listChangedFiles(): string[] {
  try {
    const merge = execSync(`git merge-base HEAD ${baseRef}`, {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const diff = execSync(
      `git diff --name-only --diff-filter=AM ${merge}...HEAD`,
      { cwd: repoRoot, encoding: "utf8" },
    );
    return diff.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    console.warn(
      `[file-size] could not compute changed files against ${baseRef}: ${(err as Error).message}`,
    );
    console.warn(`[file-size] falling back to whole-repo audit`);
    return listAllFiles();
  }
}

function listAllFiles(): string[] {
  const tracked = execSync(`git ls-files`, { cwd: repoRoot, encoding: "utf8" });
  return tracked.split("\n").map((l) => l.trim()).filter(Boolean);
}

function countLines(absPath: string): number {
  const content = readFileSync(absPath, "utf8");
  // Count via splits; don't count a trailing newline as an extra line.
  if (content.length === 0) return 0;
  return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

function main(): void {
  const allowlist = loadAllowlist();
  const candidates = mode === "all" ? listAllFiles() : listChangedFiles();

  const warnings: Array<{ path: string; lines: number }> = [];
  const failures: Array<{ path: string; lines: number }> = [];

  for (const rel of candidates) {
    if (!hasAuditExtension(rel)) continue;
    const abs = resolve(repoRoot, rel);
    if (!existsSync(abs)) continue; // deleted or moved
    try {
      if (!statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    if (isExempt(rel, allowlist)) continue;

    const lines = countLines(abs);
    if (lines >= failLines) {
      failures.push({ path: rel, lines });
    } else if (lines >= warnLines) {
      warnings.push({ path: rel, lines });
    }
  }

  warnings.sort((a, b) => b.lines - a.lines);
  failures.sort((a, b) => b.lines - a.lines);

  // Stdout report.
  if (warnings.length === 0 && failures.length === 0) {
    console.log(
      `[file-size] ✓ no files over warn threshold (${warnLines}) out of ${candidates.length} candidate(s)`,
    );
  } else {
    if (warnings.length > 0) {
      console.log(
        `[file-size] ⚠ ${warnings.length} file(s) between ${warnLines} and ${failLines - 1} lines:`,
      );
      for (const w of warnings) console.log(`  ${w.lines} lines  ${w.path}`);
    }
    if (failures.length > 0) {
      console.log(
        `[file-size] ✗ ${failures.length} file(s) at or over ${failLines} lines:`,
      );
      for (const f of failures) console.log(`  ${f.lines} lines  ${f.path}`);
    }
  }

  // GitHub Actions integrations.
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const lines = [
      `## File size gate`,
      ``,
      `Mode: \`${mode}\` · Warn ≥ ${warnLines} · Fail ≥ ${failLines} lines`,
      ``,
    ];
    if (failures.length > 0) {
      lines.push(`### ❌ Failures`, ``, `| Lines | File |`, `|---:|---|`);
      for (const f of failures) lines.push(`| ${f.lines} | \`${f.path}\` |`);
      lines.push(``);
    }
    if (warnings.length > 0) {
      lines.push(`### ⚠️ Warnings`, ``, `| Lines | File |`, `|---:|---|`);
      for (const w of warnings) lines.push(`| ${w.lines} | \`${w.path}\` |`);
      lines.push(``);
    }
    if (failures.length === 0 && warnings.length === 0) {
      lines.push(`All files within limits ✓`, ``);
    }
    appendFileSync(summary, lines.join("\n"));
  }

  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    appendFileSync(
      ghOutput,
      `warn_count=${warnings.length}\nfail_count=${failures.length}\n`,
    );
  }

  // PR annotations (one per failure/warning).
  for (const f of failures) {
    console.log(
      `::error file=${f.path}::File has ${f.lines} lines, exceeds fail threshold of ${failLines}. See docs/tickets/003-ci-file-size-gate.md.`,
    );
  }
  for (const w of warnings) {
    console.log(
      `::warning file=${w.path}::File has ${w.lines} lines, approaching fail threshold (${failLines}). Consider extracting.`,
    );
  }

  if (failures.length > 0) process.exit(1);
  process.exit(0);
}

main();
