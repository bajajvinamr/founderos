import {
  pgTable,
  text,
  integer,
  boolean,
  uuid,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const departments = pgTable("departments", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  description: text("description"),
  icon: text("icon"),
  sortOrder: integer("sort_order").notNull().default(0),
  isCore: boolean("is_core").notNull().default(false),
});

export const workspaceDepartments = pgTable(
  "workspace_departments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    departmentId: text("department_id")
      .notNull()
      .references(() => departments.id),
    enabled: boolean("enabled").notNull().default(true),
    autonomyLevel: integer("autonomy_level").notNull().default(2),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniq: unique().on(t.companyId, t.departmentId),
  }),
);

export type Department = typeof departments.$inferSelect;
export type DepartmentInsert = typeof departments.$inferInsert;
export type WorkspaceDepartment = typeof workspaceDepartments.$inferSelect;
export type WorkspaceDepartmentInsert = typeof workspaceDepartments.$inferInsert;
