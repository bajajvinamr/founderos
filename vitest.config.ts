import { defineConfig } from "vitest/config";

// Ensure test workers use NODE_ENV=test regardless of the shell environment.
// This prevents React from loading its production build (which omits `act`)
// and Lexical from loading its minified prod bundle (which breaks node
// registration when dev and prod modules are mixed).
process.env.NODE_ENV = "test";

export default defineConfig({
  test: {
    projects: [
      "packages/shared",
      "packages/db",
      "packages/adapters/claude-local",
      "packages/adapters/codex-local",
      "packages/adapters/opencode-local",
      "packages/runner",
      "server",
      "ui",
      "cli",
    ],
  },
});
