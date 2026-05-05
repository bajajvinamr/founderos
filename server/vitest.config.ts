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

    coverage: {
      // Vitest's v8 provider — already a devDependency at the root.
      provider: "v8",
      // Per-glob thresholds for high-value modules. CI runs tests with
      // `--coverage` and enforces these here. Failing a threshold fails the
      // test job. Globs are matched relative to this config's root (server/).
      //
      // Why these modules (TC-5 S3 trust closure, council 2026-05-05 R1+R2):
      //   - integrations/**        — ingestion path; cross-org leak surface;
      //                              dedup-key contract; PII redaction.
      //   - funnel*                — funnel diagnostics (S3, lands later);
      //                              glob no-ops until the file exists, then
      //                              the bar is enforced from day one.
      //   - cos/brief*             — daily-brief generation + LLM trust
      //                              boundary (S3, lands later).
      //   - event-ingest.ts        — singleton + dedup-key invariant; single
      //                              write path for every source. 80% bar
      //                              reflects load-bearing nature.
      //
      // Numbers reflect today's measured floor (TC-5 closure, 2026-05-05):
      //   integrations dir:  74.88% lines, 35.29% branches
      //   - hubspot-ingest:  82.66% / 46%   ← above target
      //   - linkedin-ingest: 72.16% / 19%
      //   - notion-ingest:   69.41% / 25%
      //   - slack-ingest:    69.73% / 43%
      //   event-ingest.ts (canonical): 82.27% / 80% ← at target
      //
      // Goal: 75% lines, 60% branches. Floor set at 65% lines / 18% branches
      // to gate regressions today, with a follow-up ticket (#TC-5.1) to add
      // error-path tests for slack/notion/linkedin and raise the bar to 75%.
      // Globs that match no files are a no-op in vitest 3 — safe to land
      // ahead of the modules they reference (S3 funnel/brief come later).
      thresholds: {
        "src/services/integrations/**": {
          lines: 65,
          functions: 75,
          statements: 65,
          branches: 18,
        },
        "src/services/funnel*": {
          lines: 75,
          functions: 75,
          statements: 75,
          branches: 60,
        },
        "src/services/cos/brief*": {
          lines: 75,
          functions: 75,
          statements: 75,
          branches: 60,
        },
        "src/services/event-ingest.ts": {
          lines: 80,
          functions: 80,
          statements: 80,
          branches: 70,
        },
      },
    },
  },
});
