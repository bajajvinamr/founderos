import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { projectWorkspaces } from "./project_workspaces.js";
import { projects } from "./projects.js";

export const executionWorkspaces = pgTable(
  "execution_workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    /**
     * Same-tenant invariant enforced by the composite FK
     * `execution_workspaces_project_id_company_id_projects_id_company_id_fk`
     * — see migration 0085_tenant_invariants.sql.
     */
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    /**
     * Same-tenant invariant enforced by the composite FK
     * `execution_workspaces_project_workspace_id_company_id_project_workspaces_id_company_id_fk`
     * — see migration 0085_tenant_invariants.sql.
     */
    projectWorkspaceId: uuid("project_workspace_id").references(() => projectWorkspaces.id, { onDelete: "set null" }),
    /**
     * Same-tenant invariant enforced by the composite FK
     * `execution_workspaces_source_issue_id_company_id_issues_id_company_id_fk`
     * — see migration 0085_tenant_invariants.sql.
     */
    sourceIssueId: uuid("source_issue_id").references((): AnyPgColumn => issues.id, { onDelete: "set null" }),
    mode: text("mode").notNull(),
    strategyType: text("strategy_type").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    cwd: text("cwd"),
    repoUrl: text("repo_url"),
    baseRef: text("base_ref"),
    branchName: text("branch_name"),
    providerType: text("provider_type").notNull().default("local_fs"),
    providerRef: text("provider_ref"),
    derivedFromExecutionWorkspaceId: uuid("derived_from_execution_workspace_id")
      .references((): AnyPgColumn => executionWorkspaces.id, { onDelete: "set null" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    cleanupEligibleAt: timestamp("cleanup_eligible_at", { withTimezone: true }),
    cleanupReason: text("cleanup_reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectStatusIdx: index("execution_workspaces_company_project_status_idx").on(
      table.companyId,
      table.projectId,
      table.status,
    ),
    companyProjectWorkspaceStatusIdx: index("execution_workspaces_company_project_workspace_status_idx").on(
      table.companyId,
      table.projectWorkspaceId,
      table.status,
    ),
    companySourceIssueIdx: index("execution_workspaces_company_source_issue_idx").on(
      table.companyId,
      table.sourceIssueId,
    ),
    companyLastUsedIdx: index("execution_workspaces_company_last_used_idx").on(
      table.companyId,
      table.lastUsedAt,
    ),
    companyBranchIdx: index("execution_workspaces_company_branch_idx").on(
      table.companyId,
      table.branchName,
    ),
    // Same-tenant invariants (composite FKs) — migration 0085.
    projectTenantFk: foreignKey({
      name: "execution_workspaces_project_id_company_id_projects_id_company_id_fk",
      columns: [table.projectId, table.companyId],
      foreignColumns: [projects.id, projects.companyId],
    }).onDelete("cascade"),
    projectWorkspaceTenantFk: foreignKey({
      name: "execution_workspaces_project_workspace_id_company_id_project_workspaces_id_company_id_fk",
      columns: [table.projectWorkspaceId, table.companyId],
      foreignColumns: [projectWorkspaces.id, projectWorkspaces.companyId],
    }).onDelete("set null"),
    sourceIssueTenantFk: foreignKey({
      name: "execution_workspaces_source_issue_id_company_id_issues_id_company_id_fk",
      columns: [table.sourceIssueId, table.companyId],
      foreignColumns: [issues.id, issues.companyId],
    }).onDelete("set null"),
    // Status enum CHECK — migration 0085. Mirrors ExecutionWorkspaceStatus.
    statusCheck: check(
      "execution_workspaces_status_check",
      sql`${table.status} IN ('active','idle','in_review','archived','cleanup_failed')`,
    ),
  }),
);
