import { foreignKey, pgTable, uuid, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { labels } from "./labels.js";

export const issueLabels = pgTable(
  "issue_labels",
  {
    /**
     * Same-tenant invariant enforced by the composite FK
     * `issue_labels_issue_id_company_id_issues_id_company_id_fk` —
     * see migration 0085_tenant_invariants.sql.
     */
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    /**
     * Same-tenant invariant enforced by the composite FK
     * `issue_labels_label_id_company_id_labels_id_company_id_fk` —
     * see migration 0085_tenant_invariants.sql.
     */
    labelId: uuid("label_id").notNull().references(() => labels.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.issueId, table.labelId], name: "issue_labels_pk" }),
    issueIdx: index("issue_labels_issue_idx").on(table.issueId),
    labelIdx: index("issue_labels_label_idx").on(table.labelId),
    companyIdx: index("issue_labels_company_idx").on(table.companyId),
    // Same-tenant invariants (composite FKs) — migration 0085.
    issueTenantFk: foreignKey({
      name: "issue_labels_issue_id_company_id_issues_id_company_id_fk",
      columns: [table.issueId, table.companyId],
      foreignColumns: [issues.id, issues.companyId],
    }).onDelete("cascade"),
    labelTenantFk: foreignKey({
      name: "issue_labels_label_id_company_id_labels_id_company_id_fk",
      columns: [table.labelId, table.companyId],
      foreignColumns: [labels.id, labels.companyId],
    }).onDelete("cascade"),
  }),
);
