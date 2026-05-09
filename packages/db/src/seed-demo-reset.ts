/**
 * Demo reset — wipes demo companies, then the usual pipeline can re-run
 * seed-demo.ts → seed-demo-depth.ts → seed-demo-narrative.ts.
 *
 * Targets:
 *   - Any row with `companies.is_demo = true` (the structural backstop —
 *     added in migration 0107 for P0 audit finding #5)
 *   - Plus a few legacy names (pre-is_demo seeds, kept for cleanup of
 *     existing dev databases that still hold the old portfolio names)
 *
 * Requires BOTH env gates to avoid accidents:
 *
 *   FOUNDEROS_SEED_DEMO=1 SEED_DEMO_RESET_YES=1 \
 *   DATABASE_URL=… \
 *     pnpm --filter @founderos/db exec tsx src/seed-demo-reset.ts
 *
 * Or interactively (still requires FOUNDEROS_SEED_DEMO=1):
 *
 *   FOUNDEROS_SEED_DEMO=1 DATABASE_URL=… \
 *     pnpm --filter @founderos/db exec tsx src/seed-demo-reset.ts
 *   (prompts: Type the company name to confirm)
 *
 * All cascading rows (agents, issues, goals, approvals, integrations, memory,
 * activity, cost_events, heartbeat_runs, …) are cleaned up via the FK
 * ON DELETE CASCADE that the schemas already declare. For tables without
 * cascade (approvals, company_memory, activity_log etc.), we delete by
 * companyId first.
 */
import { createDb } from "./client.js";
import { companies } from "./schema/index.js";
import { inArray, sql } from "drizzle-orm";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

if (process.env.FOUNDEROS_SEED_DEMO !== "1") {
  console.error(
    "[seed-demo-reset] Refusing to run: this script DELETES demo company " +
      "rows from the configured DATABASE_URL. Set FOUNDEROS_SEED_DEMO=1 to " +
      "confirm you are pointing at a development/test database, never " +
      "production. See docs/runbooks/seed-demo.md for safe usage.",
  );
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDb(url);

// Names to wipe in addition to anything matched by is_demo = true. Kept
// narrow on purpose — only legacy demo names + the Little Wins experimental
// row. Real customer rows must NEVER appear here; the is_demo column is the
// structural primary check.
const LEGACY_DEMO_COMPANY_NAMES = [
  "Acme Robotics",
  "Beta Labs",
  "Demo Corp",
  // Pre-rename portfolio names (P0 audit #5, 2026-05-09). Kept here so
  // existing dev databases still hold these rows can be cleanly wiped.
  "agnost.ai",
  "Pred",
  "Gravton Labs",
  "Little Wins",
];

const confirmed = process.env.SEED_DEMO_RESET_YES === "1";

if (!confirmed) {
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(
    `\n[seed-demo-reset] About to DELETE all rows where companies.is_demo = true,\n` +
      `plus any rows whose name matches the legacy demo list:\n` +
      `    ${LEGACY_DEMO_COMPANY_NAMES.join(", ")}\n\n` +
      `Type "yes delete demo" to continue, anything else to abort: `,
  );
  rl.close();
  if (answer.trim() !== "yes delete demo") {
    console.log("[seed-demo-reset] Aborted.");
    process.exit(1);
  }
}

const existing = await db.select().from(companies);
const toDelete = existing.filter(
  (c) => c.isDemo === true || LEGACY_DEMO_COMPANY_NAMES.includes(c.name),
);
if (toDelete.length === 0) {
  console.log(
    "[seed-demo-reset] Nothing to delete — none of the demo companies exist.",
  );
  process.exit(0);
}

const ids = toDelete.map((c) => c.id);

// Defense-in-depth: IDs come from the DB but validate before sql.raw interpolation
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
for (const id of ids) {
  if (!UUID_RE.test(id)) throw new Error(`Invalid company ID format: ${id}`);
}

console.log(
  `[seed-demo-reset] Deleting ${toDelete.length} companies: ${toDelete.map((c) => c.name).join(", ")}`,
);

// Delete all company-scoped data in leaf-first FK order.
// Raw SQL per table so parameterized queries work (DO blocks don't support $1).
const LEAF_TABLES = [
  "company_memberships", "invites", "join_requests",
  "integration_data", "integrations", "composio_connections",
  "company_memory", "company_secrets", "company_skills", "company_logos",
  "approval_comments", "approvals",
  "activity_log", "cost_events", "finance_events",
  "heartbeat_run_events", "heartbeat_runs",
  "budget_incidents", "budget_policies",
  "issue_read_states", "issue_approvals", "issue_attachments",
  "issue_comments", "issue_documents", "issue_execution_decisions",
  "issue_inbox_archives", "issue_labels", "issue_relations", "issue_work_products",
  "issues", "inbox_dismissals", "labels",
  "project_goals", "project_workspaces", "execution_workspaces",
  "workspace_operations", "workspace_runtime_services", "projects",
  "goals", "routines", "conversations", "decision_outcomes", "weekly_wraps",
  "feedback_exports", "feedback_votes",
  "documents", "document_revisions", "assets",
  "agent_handoffs", "agent_reviews", "agent_api_keys",
  "agent_config_revisions", "agent_runtime_state",
  "agent_task_sessions", "agent_wakeup_requests",
  "principal_permission_grants", "plugin_company_settings",
  "agents",
];

for (const id of ids) {
  for (const table of LEAF_TABLES) {
    await db.execute(sql.raw(`DELETE FROM ${table} WHERE company_id = '${id}'`));
  }
  await db.execute(sql.raw(`DELETE FROM companies WHERE id = '${id}'`));
}

console.log(
  `[seed-demo-reset] ✓ Wiped ${toDelete.length} companies and their dependent rows.`,
);
process.exit(0);
