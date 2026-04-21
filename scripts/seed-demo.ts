#!/usr/bin/env node
/**
 * Deprecated shim — the demo seed now lives inside the @founderos/db package.
 *
 * The canonical demo pipeline is three scripts in packages/db/src/:
 *   1. seed-demo.ts            — the 3 canonical portfolio companies
 *   2. seed-demo-depth.ts      — 90 days of runs, cost events, approvals, activity
 *   3. seed-demo-narrative.ts  — memory, decision inbox, integrations,
 *                                 and the experimental "Little Wins" 4th company
 *
 * The whole chain is bound to `pnpm seed:demo`. This script used to be the
 * standalone Little Wins seed — that logic moved into the narrative step.
 *
 * For one-shot Little Wins seeding use:
 *   DATABASE_URL=… pnpm --filter @founderos/db exec tsx src/seed-demo-narrative.ts
 *
 * See docs/runbooks/admin-guide.md → "Demo mode" for the full runbook.
 */

console.error(
  "[scripts/seed-demo.ts] Deprecated. Use `pnpm seed:demo` (chains seed-demo.ts → seed-demo-depth.ts → seed-demo-narrative.ts inside @founderos/db). See docs/runbooks/admin-guide.md → Demo mode.",
);
process.exit(1);
