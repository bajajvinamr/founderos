import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Fork-per-file isolation. Server tests share an embedded Postgres cluster
    // and a lot of module-level state (plugin registries, subprocess managers,
    // etc). Running in worker threads with shared heap produced flaky failures
    // in health, tenant-isolation, workspace-runtime, issue-feedback-routes,
    // issue-closed-workspace-routes, issue-comment-reopen-routes under parallel
    // execution. Forks are heavier but give each test file a clean native
    // process, which is what these integration tests assume.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
    isolate: true,
    testTimeout: 30_000,
  },
});
