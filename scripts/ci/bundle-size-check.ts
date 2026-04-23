#!/usr/bin/env tsx
/**
 * Bundle size budget check.
 *
 * Reads every .js file under ui/dist/assets, gzips it in-memory, sums the
 * gzipped bytes, and fails if the total exceeds the configured budget.
 *
 * Config (env):
 *   BUNDLE_SIZE_BUDGET_KB   total gzipped budget in KB (default 1536 = 1.5 MB)
 *   BUNDLE_DIST_DIR         absolute or repo-relative dist dir (default ui/dist)
 *   GITHUB_STEP_SUMMARY     if set, appends a markdown table for the job summary
 *   GITHUB_OUTPUT           if set, emits `total_kb=` and `budget_kb=` outputs
 *
 * Exits 0 on pass, 1 on budget exceeded, 2 on missing dist dir.
 */
import { readdirSync, readFileSync, statSync, appendFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { resolve, join, relative } from "node:path";

type Entry = { name: string; bytes: number; gzipBytes: number };

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const distDir = resolve(repoRoot, process.env.BUNDLE_DIST_DIR ?? "ui/dist");
const assetsDir = join(distDir, "assets");
const budgetKb = Number.parseInt(process.env.BUNDLE_SIZE_BUDGET_KB ?? "1536", 10);

if (!Number.isFinite(budgetKb) || budgetKb <= 0) {
  console.error(`[bundle-size] invalid BUNDLE_SIZE_BUDGET_KB=${process.env.BUNDLE_SIZE_BUDGET_KB}`);
  process.exit(2);
}

if (!existsSync(assetsDir)) {
  console.error(`[bundle-size] assets dir not found: ${assetsDir}`);
  console.error(`[bundle-size] run \`pnpm --filter @founderos/ui build\` first.`);
  process.exit(2);
}

function walkJs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkJs(full));
    } else if (st.isFile() && entry.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

const files = walkJs(assetsDir).sort();

if (files.length === 0) {
  console.error(`[bundle-size] no .js files found under ${assetsDir}`);
  process.exit(2);
}

const entries: Entry[] = files.map((full) => {
  const buf = readFileSync(full);
  const gz = gzipSync(buf);
  return {
    name: relative(assetsDir, full),
    bytes: buf.byteLength,
    gzipBytes: gz.byteLength,
  };
});

entries.sort((a, b) => b.gzipBytes - a.gzipBytes);

const totalRaw = entries.reduce((sum, e) => sum + e.bytes, 0);
const totalGz = entries.reduce((sum, e) => sum + e.gzipBytes, 0);
const totalKb = totalGz / 1024;
const kb = (n: number) => (n / 1024).toFixed(1);

const TOP_N = 15;
const top = entries.slice(0, TOP_N);

console.log("");
console.log(`Bundle size report — ${files.length} .js assets in ${relative(repoRoot, assetsDir)}`);
console.log("");
console.log(`  ${"asset".padEnd(48)}  ${"raw KB".padStart(10)}  ${"gzip KB".padStart(10)}`);
console.log(`  ${"-".repeat(48)}  ${"-".repeat(10)}  ${"-".repeat(10)}`);
for (const e of top) {
  console.log(`  ${e.name.padEnd(48)}  ${kb(e.bytes).padStart(10)}  ${kb(e.gzipBytes).padStart(10)}`);
}
if (entries.length > TOP_N) {
  const rest = entries.slice(TOP_N);
  const restGz = rest.reduce((s, e) => s + e.gzipBytes, 0);
  const restRaw = rest.reduce((s, e) => s + e.bytes, 0);
  console.log(
    `  ${`… ${rest.length} more`.padEnd(48)}  ${kb(restRaw).padStart(10)}  ${kb(restGz).padStart(10)}`,
  );
}
console.log(`  ${"-".repeat(48)}  ${"-".repeat(10)}  ${"-".repeat(10)}`);
console.log(
  `  ${"TOTAL".padEnd(48)}  ${kb(totalRaw).padStart(10)}  ${kb(totalGz).padStart(10)}`,
);
console.log("");
console.log(`Budget: ${budgetKb} KB gzipped. Measured: ${totalKb.toFixed(1)} KB gzipped.`);

const stepSummary = process.env.GITHUB_STEP_SUMMARY;
if (stepSummary) {
  const rows = top
    .map((e) => `| \`${e.name}\` | ${kb(e.bytes)} | ${kb(e.gzipBytes)} |`)
    .join("\n");
  const pct = ((totalKb / budgetKb) * 100).toFixed(1);
  const status = totalKb > budgetKb ? "FAIL" : "PASS";
  const md =
    `### Bundle size — ${status}\n\n` +
    `- Total gzipped: **${totalKb.toFixed(1)} KB** / ${budgetKb} KB budget (${pct}%)\n` +
    `- Assets analyzed: ${files.length}\n\n` +
    `| Asset | Raw KB | Gzip KB |\n| --- | ---: | ---: |\n${rows}\n`;
  appendFileSync(stepSummary, `${md}\n`);
}

const ghOutput = process.env.GITHUB_OUTPUT;
if (ghOutput) {
  appendFileSync(
    ghOutput,
    `total_kb=${totalKb.toFixed(1)}\nbudget_kb=${budgetKb}\nasset_count=${files.length}\n`,
  );
}

if (totalKb > budgetKb) {
  console.error(`[bundle-size] FAIL — ${totalKb.toFixed(1)} KB exceeds budget ${budgetKb} KB`);
  process.exit(1);
}

console.log(`[bundle-size] OK`);
