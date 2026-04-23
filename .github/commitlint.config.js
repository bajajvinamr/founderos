/**
 * commitlint.config.js
 * Enforces Conventional Commits on all PR titles (read by wave-22e PR-lint workflow).
 * Consumed by @commitlint/cli for local validation and GitHub Actions CI.
 */

module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "docs",
        "style",
        "refactor",
        "perf",
        "test",
        "chore",
        "ci",
      ],
    ],
    "type-case": [2, "always", "lower-case"],
    "type-empty": [2, "never"],
    "scope-case": [2, "always", "lower-case"],
    "subject-empty": [2, "never"],
    "subject-full-stop": [2, "never", "."],
    "subject-case": [2, "never", ["start-case", "pascal-case"]],
    "header-max-length": [2, "always", 100],
  },
};
