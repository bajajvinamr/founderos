/**
 * Demo reset — wipes the three canonical demo companies (and the optional
 * Little Wins experimental row) by name, then the usual pipeline can re-run
 * seed-demo.ts → seed-demo-depth.ts → seed-demo-narrative.ts.
 *
 * Requires an explicit confirmation flag to avoid accidents:
 *
 *   DATABASE_URL=…  SEED_DEMO_RESET_YES=1 \
 *     pnpm --filter @founderos/db exec tsx src/seed-demo-reset.ts
 *
 * Or interactively:
 *
 *   DATABASE_URL=…  pnpm --filter @founderos/db exec tsx src/seed-demo-reset.ts
 *   (prompts: Type the company name to confirm)
 *
 * All cascading rows (agents, issues, goals, approvals, integrations, memory,
 * activity, cost_events, heartbeat_runs, …) are cleaned up via the FK
 * ON DELETE CASCADE that the schemas already declare. For tables without
 * cascade (approvals, company_memory, activity_log etc.), we delete by
 * companyId first.
 */
import { createDb } from "./client.js";
import {
  companies,
  agents,
  approvals,
  companyMemory,
  activityLog,
  integrations,
  integrationData,
  costEvents,
  heartbeatRuns,
  goals,
  projects,
  issues,
  budgetIncidents,
} from "./schema/index.js";
import { inArray } from "drizzle-orm";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDb(url);

const DEMO_COMPANY_NAMES = [
  "agnost.ai",
  "Pred",
  "Gravton Labs",
  "Little Wins",
];

const confirmed = process.env.SEED_DEMO_RESET_YES === "1";

if (!confirmed) {
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(
    `\n[seed-demo-reset] About to DELETE the following companies and ALL their data:\n` +
      `    ${DEMO_COMPANY_NAMES.join(", ")}\n\n` +
      `Type "yes delete demo" to continue, anything else to abort: `,
  );
  rl.close();
  if (answer.trim() !== "yes delete demo") {
    console.log("[seed-demo-reset] Aborted.");
    process.exit(1);
  }
}

const existing = await db.select().from(companies);
const toDelete = existing.filter((c) => DEMO_COMPANY_NAMES.includes(c.name));
if (toDelete.length === 0) {
  console.log(
    "[seed-demo-reset] Nothing to delete — none of the demo companies exist.",
  );
  process.exit(0);
}

const ids = toDelete.map((c) => c.id);
console.log(
  `[seed-demo-reset] Deleting ${toDelete.length} companies: ${toDelete.map((c) => c.name).join(", ")}`,
);

// Order matters for tables whose FK lacks ON DELETE CASCADE to companies.
// Start from leaves, walk inward.
await db.delete(integrationData).where(inArray(integrationData.companyId, ids));
await db.delete(integrations).where(inArray(integrations.companyId, ids));
await db.delete(companyMemory).where(inArray(companyMemory.companyId, ids));
await db.delete(approvals).where(inArray(approvals.companyId, ids));
await db.delete(activityLog).where(inArray(activityLog.companyId, ids));
await db.delete(costEvents).where(inArray(costEvents.companyId, ids));
await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.companyId, ids));
await db.delete(budgetIncidents).where(inArray(budgetIncidents.companyId, ids));
await db.delete(issues).where(inArray(issues.companyId, ids));
await db.delete(projects).where(inArray(projects.companyId, ids));
await db.delete(goals).where(inArray(goals.companyId, ids));
await db.delete(agents).where(inArray(agents.companyId, ids));
await db.delete(companies).where(inArray(companies.id, ids));

console.log(
  `[seed-demo-reset] ✓ Wiped ${toDelete.length} companies and their dependent rows.`,
);
process.exit(0);
