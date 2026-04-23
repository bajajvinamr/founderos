#!/usr/bin/env tsx
/**
 * Coverage summary printer.
 *
 * Reads Vitest's coverage-summary.json (v8 / istanbul compatible) and emits:
 *   - a single-screen table to stdout (overall + per-package)
 *   - a markdown summary to $GITHUB_STEP_SUMMARY when in CI
 *
 * By default, walks the repo for any `coverage/coverage-summary.json`.
 * A single root summary (e.g. coverage/coverage-summary.json) is also supported.
 *
 * Config (env):
 *   COVERAGE_DIR       override root search dir (default: repo root)
 *   COVERAGE_THRESHOLD numeric %, fails the run if overall lines% < threshold
 *                       (default: no threshold — reporting only)
 */
import { readdirSync, readFileSync, statSync, appendFileSync, existsSync } from "node:fs";
import { resolve, join, relative, dirname } from "node:path";

type Metric = { total: number; covered: number; skipped?: number; pct: number };
type FileSummary = {
  lines: Metric;
  statements: Metric;
  functions: Metric;
  branches: Metric;
};
type CoverageSummary = { total: FileSummary; [file: string]: FileSummary };

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const searchRoot = resolve(repoRoot, process.env.COVERAGE_DIR ?? ".");
const threshold = process.env.COVERAGE_THRESHOLD
  ? Number.parseFloat(process.env.COVERAGE_THRESHOLD)
  : null;

function findSummaries(dir: string, found: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      findSummaries(full, found);
    } else if (st.isFile() && entry === "coverage-summary.json" && full.includes("coverage")) {
      found.push(full);
    }
  }
  return found;
}

const summaries = findSummaries(searchRoot);

if (summaries.length === 0) {
  console.error(`[coverage] no coverage-summary.json found under ${searchRoot}`);
  console.error(`[coverage] run tests with --coverage to generate one.`);
  process.exit(0); // non-fatal: coverage is optional
}

type PackageRow = {
  label: string;
  lines: number;
  statements: number;
  functions: number;
  branches: number;
};

const rows: PackageRow[] = [];

for (const summaryPath of summaries) {
  const raw = readFileSync(summaryPath, "utf8");
  let data: CoverageSummary;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.warn(`[coverage] skip ${summaryPath} — invalid JSON: ${(err as Error).message}`);
    continue;
  }
  const total = data.total;
  if (!total) continue;
  const label = relative(repoRoot, dirname(dirname(summaryPath))) || "root";
  rows.push({
    label,
    lines: total.lines?.pct ?? 0,
    statements: total.statements?.pct ?? 0,
    functions: total.functions?.pct ?? 0,
    branches: total.branches?.pct ?? 0,
  });
}

rows.sort((a, b) => a.label.localeCompare(b.label));

function avg(field: keyof Omit<PackageRow, "label">): number {
  if (rows.length === 0) return 0;
  return rows.reduce((s, r) => s + r[field], 0) / rows.length;
}

const overall: PackageRow = {
  label: "OVERALL (avg)",
  lines: avg("lines"),
  statements: avg("statements"),
  functions: avg("functions"),
  branches: avg("branches"),
};

const fmt = (n: number) => `${n.toFixed(1)}%`.padStart(7);

console.log("");
console.log("Coverage summary");
console.log("");
console.log(
  `  ${"package".padEnd(40)}  ${"lines".padStart(7)}  ${"stmts".padStart(7)}  ${"funcs".padStart(7)}  ${"branch".padStart(7)}`,
);
console.log(`  ${"-".repeat(40)}  ${"-".repeat(7)}  ${"-".repeat(7)}  ${"-".repeat(7)}  ${"-".repeat(7)}`);
for (const r of rows) {
  console.log(
    `  ${r.label.padEnd(40)}  ${fmt(r.lines)}  ${fmt(r.statements)}  ${fmt(r.functions)}  ${fmt(r.branches)}`,
  );
}
console.log(`  ${"-".repeat(40)}  ${"-".repeat(7)}  ${"-".repeat(7)}  ${"-".repeat(7)}  ${"-".repeat(7)}`);
console.log(
  `  ${overall.label.padEnd(40)}  ${fmt(overall.lines)}  ${fmt(overall.statements)}  ${fmt(overall.functions)}  ${fmt(overall.branches)}`,
);
console.log("");

const stepSummary = process.env.GITHUB_STEP_SUMMARY;
if (stepSummary) {
  const body =
    `### Coverage\n\n` +
    `| Package | Lines | Stmts | Funcs | Branch |\n| --- | ---: | ---: | ---: | ---: |\n` +
    rows
      .map(
        (r) =>
          `| \`${r.label}\` | ${r.lines.toFixed(1)}% | ${r.statements.toFixed(1)}% | ${r.functions.toFixed(1)}% | ${r.branches.toFixed(1)}% |`,
      )
      .join("\n") +
    `\n| **${overall.label}** | **${overall.lines.toFixed(1)}%** | **${overall.statements.toFixed(1)}%** | **${overall.functions.toFixed(1)}%** | **${overall.branches.toFixed(1)}%** |\n`;
  appendFileSync(stepSummary, `${body}\n`);
}

const ghOutput = process.env.GITHUB_OUTPUT;
if (ghOutput) {
  appendFileSync(
    ghOutput,
    `lines_pct=${overall.lines.toFixed(1)}\nbranches_pct=${overall.branches.toFixed(1)}\nfunctions_pct=${overall.functions.toFixed(1)}\nstatements_pct=${overall.statements.toFixed(1)}\n`,
  );
}

if (threshold !== null && Number.isFinite(threshold)) {
  if (overall.lines < threshold) {
    console.error(
      `[coverage] FAIL — lines ${overall.lines.toFixed(1)}% < threshold ${threshold}%`,
    );
    process.exit(1);
  }
  console.log(`[coverage] threshold OK (${overall.lines.toFixed(1)}% ≥ ${threshold}%)`);
}

// Silence unused-var lints in case the env is not set.
void existsSync;
