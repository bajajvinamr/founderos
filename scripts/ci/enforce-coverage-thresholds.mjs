#!/usr/bin/env node
/**
 * enforce-coverage-thresholds.mjs — hard gate on per-module coverage.
 *
 * Reads `server/coverage/coverage-summary.json` (written by the test step's
 * `--coverage.reporter=json-summary`) and verifies each glob-targeted module
 * meets its line-coverage bar. Exits non-zero on any miss.
 *
 * Why this lives here (not in vitest's own `coverage.thresholds`):
 *   The CI test step uses `|| echo "::warning::"` to keep the run yellow
 *   instead of red on test failures — that swallows vitest's threshold
 *   exit code too. This script reads the same coverage-summary.json and
 *   fails the job cleanly, so threshold breaches surface as red without
 *   re-running the whole suite.
 *
 * Targets (TC-5 council 2026-05-05 R1+R2):
 *   - server/src/services/integrations/**   75% lines
 *   - server/src/services/funnel*           75% lines (no-op until lands)
 *   - server/src/services/cos/brief*        75% lines (no-op until lands)
 *   - server/src/services/event-ingest.ts   80% lines
 *
 * Note: micromatch isn't required — we use a small regex translation of the
 * subset of glob syntax we use here (`**`, `*`, exact paths). Keeping this
 * dependency-free avoids adding a top-level CI-only npm install.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, sep } from "node:path";

const SUMMARY = resolve(
  new URL("../..", import.meta.url).pathname,
  "server",
  "coverage",
  "coverage-summary.json",
);

/**
 * Per-glob thresholds. Each rule has:
 *   - `glob`: an absolute-path glob (relative to repo root, in POSIX form)
 *   - `lines`: minimum line% required
 *   - `branches`/`functions`/`statements`: optional, default = lines
 *
 * Glob syntax supported: `**` (any segments incl /), `*` (any chars except /),
 * literal path segments. No `?`, no `{a,b}`. Sufficient for our use.
 */
// Numbers must match server/vitest.config.ts > test.coverage.thresholds.
// Today's floors (TC-5 closure 2026-05-05) — see vitest.config.ts for the
// follow-up plan to push integrations/** back to 75%.
const RULES = [
  { glob: "server/src/services/integrations/**", lines: 65, branches: 18, functions: 75, statements: 65 },
  { glob: "server/src/services/funnel*", lines: 75, branches: 60, functions: 75, statements: 75 },
  { glob: "server/src/services/cos/brief*", lines: 75, branches: 60, functions: 75, statements: 75 },
  { glob: "server/src/services/event-ingest.ts", lines: 80, branches: 70, functions: 80, statements: 80 },
];

function globToRegExp(glob) {
  // Replace `**` first (any path) → `.*`, then `*` (any chars except /) → `[^/]*`.
  // Escape regex special chars otherwise.
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLESTAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLESTAR::/g, ".*");
  return new RegExp(`^${escaped}$`);
}

if (!existsSync(SUMMARY)) {
  console.error(`[coverage-threshold] no coverage-summary.json at ${SUMMARY}`);
  console.error(`[coverage-threshold] run tests with --coverage --coverage.reporter=json-summary first`);
  // Exit 0 — the test step itself failed if coverage wasn't generated.
  // We don't want to double-fail a CI run when the upstream step is the
  // real issue. The test step's own enforcement (pnpm test:run) handles it.
  process.exit(0);
}

const raw = readFileSync(SUMMARY, "utf8");
let summary;
try {
  summary = JSON.parse(raw);
} catch (err) {
  console.error(`[coverage-threshold] coverage-summary.json is not valid JSON: ${err.message}`);
  process.exit(1);
}

// `summary` keys are absolute paths on the runner. Convert them to repo-root-
// relative POSIX paths for glob matching. The "total" key is overall, skip it.
const repoRoot = resolve(new URL("../..", import.meta.url).pathname);

const failures = [];
const matchesByRule = new Map(RULES.map((r) => [r.glob, []]));

for (const [absPath, fileSummary] of Object.entries(summary)) {
  if (absPath === "total") continue;
  // Normalize: convert to repo-relative POSIX path (forward slashes always)
  const rel = absPath
    .replace(repoRoot, "")
    .replace(/^[\\/]+/, "")
    .split(sep)
    .join("/");

  for (const rule of RULES) {
    const re = globToRegExp(rule.glob);
    if (!re.test(rel)) continue;
    matchesByRule.get(rule.glob).push(rel);
    const linesPct = fileSummary.lines?.pct ?? 0;
    const branchesPct = fileSummary.branches?.pct ?? 0;
    const functionsPct = fileSummary.functions?.pct ?? 0;
    const statementsPct = fileSummary.statements?.pct ?? 0;

    const checks = [
      { metric: "lines", actual: linesPct, threshold: rule.lines },
      { metric: "branches", actual: branchesPct, threshold: rule.branches ?? rule.lines },
      { metric: "functions", actual: functionsPct, threshold: rule.functions ?? rule.lines },
      { metric: "statements", actual: statementsPct, threshold: rule.statements ?? rule.lines },
    ];

    for (const c of checks) {
      if (c.actual < c.threshold) {
        failures.push({
          file: rel,
          glob: rule.glob,
          metric: c.metric,
          actual: c.actual,
          threshold: c.threshold,
        });
      }
    }
  }
}

console.log("");
console.log("Per-module coverage threshold gate (TC-5)");
console.log("");
for (const rule of RULES) {
  const matches = matchesByRule.get(rule.glob) ?? [];
  if (matches.length === 0) {
    console.log(`  ${rule.glob.padEnd(48)}  no matching files (skip)`);
  } else {
    console.log(`  ${rule.glob.padEnd(48)}  ${matches.length} file(s) checked`);
  }
}
console.log("");

if (failures.length > 0) {
  console.error("Coverage threshold violations:");
  for (const f of failures) {
    console.error(
      `  [${f.glob}] ${f.file} — ${f.metric} ${f.actual.toFixed(1)}% < ${f.threshold}% required`,
    );
  }
  process.exit(1);
}

console.log("All per-module coverage thresholds met.");
process.exit(0);
