#!/usr/bin/env node
/**
 * bump-version.ts
 * Deterministic semantic version bumper for FounderOS Wave 22D.
 * Reads package.json, analyzes git log since last tag, decides bump level, writes back.
 * Idempotent: returns current version if no commits since last tag.
 */

import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { resolve } from "path";

const packageJsonPath = resolve(process.cwd(), "package.json");

interface BumpLevel {
  level: "major" | "minor" | "patch" | "none";
  reason: string;
}

function readPackageJson() {
  const content = readFileSync(packageJsonPath, "utf-8");
  return JSON.parse(content);
}

function writePackageJson(pkg: any) {
  writeFileSync(
    packageJsonPath,
    JSON.stringify(pkg, null, 2) + "\n",
    "utf-8"
  );
}

function getLastTag(): string | null {
  try {
    return execSync("git describe --tags --abbrev=0", {
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
}

function getCommitsSinceTag(tag: string): string[] {
  const log = execSync(`git log --format=%s ${tag}..HEAD`, {
    encoding: "utf-8",
  }).trim();
  return log ? log.split("\n") : [];
}

function getAllCommits(): string[] {
  const log = execSync("git log --format=%s", { encoding: "utf-8" }).trim();
  return log ? log.split("\n") : [];
}

function analyzeBumpLevel(commits: string[]): BumpLevel {
  let hasBreaking = false;
  let hasFeature = false;
  let hasFix = false;

  for (const commit of commits) {
    if (
      commit.includes("BREAKING CHANGE") ||
      commit.includes("!:")
    ) {
      hasBreaking = true;
    }
    if (commit.startsWith("feat")) {
      hasFeature = true;
    }
    if (commit.startsWith("fix") || commit.startsWith("perf")) {
      hasFix = true;
    }
  }

  if (hasBreaking) {
    return { level: "major", reason: "BREAKING CHANGE detected" };
  }
  if (hasFeature) {
    return { level: "minor", reason: "feat commits detected" };
  }
  if (hasFix) {
    return { level: "patch", reason: "fix/perf commits detected" };
  }

  return { level: "none", reason: "only chore/docs/test/style commits" };
}

function bumpSemver(current: string, level: "major" | "minor" | "patch"): string {
  const parts = current.split(".").map((p) => parseInt(p, 10));
  const [major, minor, patch] = parts;

  switch (level) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}

function main() {
  const pkg = readPackageJson();
  let currentVersion = pkg.version || "0.0.0";

  const lastTag = getLastTag();
  const commits = lastTag
    ? getCommitsSinceTag(lastTag)
    : getAllCommits();

  if (commits.length === 0 || (commits.length === 1 && commits[0] === "")) {
    console.log(`No new commits since ${lastTag || "initial"}. Version: ${currentVersion}`);
    return;
  }

  const bump = analyzeBumpLevel(commits);

  if (bump.level === "none") {
    console.log(
      `No version bump needed (${bump.reason}). Version: ${currentVersion}`
    );
    return;
  }

  const newVersion = bumpSemver(currentVersion, bump.level);
  pkg.version = newVersion;
  writePackageJson(pkg);

  console.log(
    `Bumped ${currentVersion} → ${newVersion} (${bump.level}: ${bump.reason})`
  );
}

main();
