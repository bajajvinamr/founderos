import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { integrations } from "./integrations.js";

/**
 * Generic cache for data fetched from external integrations.
 *
 * One row per (company, integration, kind). The payload shape is opaque and
 * depends on the kind value:
 *   - "posthog.funnel"               → PostHog funnel stage counts
 *   - "posthog.channels.utm_source"  → PostHog UTM source pageview counts
 */
export const integrationData = pgTable(
  "integration_data",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    /** Namespaced kind, e.g. "posthog.funnel" */
    kind: text("kind").notNull(),
    /** Opaque JSON blob whose shape depends on kind */
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIntegrationKindUniq: unique(
      "integration_data_company_integration_kind_idx",
    ).on(table.companyId, table.integrationId, table.kind),
    companyKindIdx: index("idx_integration_data_company_kind").on(
      table.companyId,
      table.kind,
    ),
  }),
);
