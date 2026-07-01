# Autonomous Bug Loop

A bounded loop for repeatedly finding bugs, loopholes, and product gaps in FounderOS.

## What it does

Each iteration:

1. captures `git status --short`
2. runs `pnpm check:tokens`
3. runs `pnpm typecheck`
4. runs `pnpm lint`
5. optionally runs heavier `pnpm -w run test -- --run` and `pnpm build`
6. scans source/docs/config files for risky bug patterns
7. writes Markdown + JSON reports under `.autonomous-loop/reports/`

The scanner is intentionally conservative: findings are leads, not proof. Verify before fixing or filing.

## Safety boundaries

The loop is read-only except report output. It does **not**:

- push to remote
- deploy
- mutate databases
- edit files outside `.autonomous-loop/reports/`
- read `.env*`, `*.key`, or `*.pem`
- run destructive shell or SQL commands

## Local long-running loop

From repo root:

```sh
node scripts/autonomous-bug-loop.mjs --max-iterations=8 --interval-minutes=30 --mode=standard --report-only
```

Heavy mode adds full tests + build:

```sh
node scripts/autonomous-bug-loop.mjs --max-iterations=4 --interval-minutes=60 --mode=heavy --heavy --report-only
```

Latest report:

```sh
open .autonomous-loop/reports/latest.md
```

## GitHub scheduled loop

Workflow: `.github/workflows/autonomous-bug-loop.yml`

- runs daily at `02:17 UTC`
- can be started manually with `workflow_dispatch`
- uploads `.autonomous-loop/reports/` as a 30-day artifact
- appends the latest report to the GitHub Actions job summary

## Triage protocol

For each report:

1. Fix command failures first: typecheck/lint/token failures are higher signal than grep findings.
2. For `[P1]` findings, open the file and verify the surrounding code before changing anything.
3. Convert true positives into small fix branches.
4. If a finding is intentionally safe, add a local code comment explaining why, or tune the scanner only after verifying repeated false positives.

Use `--report-only` for long-running monitor mode so pre-existing failures are reported but do not stop the loop process. Omit `--report-only` when you want CI-style non-zero exit on failed checks.

## Exit criteria

A healthy iteration means:

- no failed commands
- no true-positive P1 findings
- known P2/P3 gaps either fixed, documented, or converted to tracked issues
