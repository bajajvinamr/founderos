/**
 * customer-email-suppressions.test.ts — S4.8 prerequisite #196 layer 3a.
 *
 * Integration tests for isSuppressed + insertSuppression + recordSuppression.
 *
 * Coverage:
 *   1. isSuppressed returns false on empty table
 *   2. isSuppressed returns true when (company, email, topic) row exists
 *   3. isSuppressed returns true when (company, email, 'all') row exists for
 *      ANY topic query (master-switch shortcut)
 *   4. isSuppressed does NOT cross tenants
 *   5. isSuppressed returns false for different contact_email
 *   6. isSuppressed normalizes uppercase / mixed-case email to lowercase
 *   7. isSuppressed trims whitespace before lookup
 *   8. insertSuppression creates a row on first call
 *   9. insertSuppression returns inserted=false on duplicate (idempotent)
 *  10. insertSuppression different topic on same (company, email) is a new row
 *  11. recordSuppression normalizes uppercase email before insert
 *  12. recordSuppression metadata defaults to {}
 *  13. recordSuppression preserves source_workflow_run_id + source_message_id
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  customerEmailSuppressions,
  companies,
  createDb,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  insertSuppression,
  isSuppressed,
  recordSuppression,
} from "../services/customer-email-suppressions.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping customer-email-suppressions tests: ${support.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("customer-email-suppressions", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyAId: string;
  let companyBId: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("cust-email-supp");
    db = createDb(testDb.connectionString);
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    // Truncate the suppression table between tests so per-test state is clean.
    // The companies table accumulates rows across tests since they share a DB,
    // but we always insert two fresh companies and use their ids — older rows
    // are inert.
    await db.delete(customerEmailSuppressions);

    const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const [companyA] = await db
      .insert(companies)
      .values({ name: "Company A", issuePrefix: `CA${suffix}` })
      .returning();
    const [companyB] = await db
      .insert(companies)
      .values({ name: "Company B", issuePrefix: `CB${suffix}` })
      .returning();
    companyAId = companyA.id;
    companyBId = companyB.id;
  });

  describe("isSuppressed", () => {
    it("returns false on empty table", async () => {
      const result = await isSuppressed(db, companyAId, "alice@example.com", "onboarding");
      expect(result).toBe(false);
    });

    it("returns true when (company, email, topic) row exists", async () => {
      await db.insert(customerEmailSuppressions).values({
        companyId: companyAId,
        contactEmail: "alice@example.com",
        topic: "onboarding",
        reason: "user_unsubscribe",
      });

      const result = await isSuppressed(db, companyAId, "alice@example.com", "onboarding");
      expect(result).toBe(true);
    });

    it("returns true when (company, email, 'all') exists, for ANY topic query", async () => {
      await db.insert(customerEmailSuppressions).values({
        companyId: companyAId,
        contactEmail: "alice@example.com",
        topic: "all",
        reason: "user_unsubscribe",
      });

      const onboarding = await isSuppressed(db, companyAId, "alice@example.com", "onboarding");
      const churn = await isSuppressed(db, companyAId, "alice@example.com", "churn_rescue");
      expect(onboarding).toBe(true);
      expect(churn).toBe(true);
    });

    it("does NOT cross tenants", async () => {
      await db.insert(customerEmailSuppressions).values({
        companyId: companyAId,
        contactEmail: "alice@example.com",
        topic: "onboarding",
        reason: "user_unsubscribe",
      });

      const result = await isSuppressed(db, companyBId, "alice@example.com", "onboarding");
      expect(result).toBe(false);
    });

    it("returns false for different email on same (company, topic)", async () => {
      await db.insert(customerEmailSuppressions).values({
        companyId: companyAId,
        contactEmail: "alice@example.com",
        topic: "onboarding",
        reason: "user_unsubscribe",
      });

      const result = await isSuppressed(db, companyAId, "bob@example.com", "onboarding");
      expect(result).toBe(false);
    });

    it("normalizes mixed-case email lookup to lowercase", async () => {
      await db.insert(customerEmailSuppressions).values({
        companyId: companyAId,
        contactEmail: "alice@example.com",
        topic: "onboarding",
        reason: "user_unsubscribe",
      });

      const result = await isSuppressed(
        db,
        companyAId,
        "Alice@Example.COM",
        "onboarding",
      );
      expect(result).toBe(true);
    });

    it("trims whitespace before lookup", async () => {
      await db.insert(customerEmailSuppressions).values({
        companyId: companyAId,
        contactEmail: "alice@example.com",
        topic: "onboarding",
        reason: "user_unsubscribe",
      });

      const result = await isSuppressed(
        db,
        companyAId,
        "  alice@example.com  ",
        "onboarding",
      );
      expect(result).toBe(true);
    });
  });

  describe("insertSuppression", () => {
    it("creates a row on first call", async () => {
      const { inserted } = await insertSuppression(db, {
        companyId: companyAId,
        contactEmail: "alice@example.com",
        topic: "onboarding",
        reason: "user_unsubscribe",
      });

      expect(inserted).toBe(true);

      const rows = await db
        .select()
        .from(customerEmailSuppressions)
        .where(eq(customerEmailSuppressions.companyId, companyAId));
      expect(rows).toHaveLength(1);
      expect(rows[0].contactEmail).toBe("alice@example.com");
      expect(rows[0].topic).toBe("onboarding");
    });

    it("returns inserted=false on duplicate (idempotent)", async () => {
      const args = {
        companyId: companyAId,
        contactEmail: "alice@example.com",
        topic: "onboarding" as const,
        reason: "user_unsubscribe" as const,
      };

      const first = await insertSuppression(db, args);
      const second = await insertSuppression(db, args);

      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);

      const rows = await db
        .select()
        .from(customerEmailSuppressions)
        .where(eq(customerEmailSuppressions.companyId, companyAId));
      expect(rows).toHaveLength(1);
    });

    it("different topic on same (company, email) creates a separate row", async () => {
      await insertSuppression(db, {
        companyId: companyAId,
        contactEmail: "alice@example.com",
        topic: "onboarding",
        reason: "user_unsubscribe",
      });
      await insertSuppression(db, {
        companyId: companyAId,
        contactEmail: "alice@example.com",
        topic: "churn_rescue",
        reason: "user_unsubscribe",
      });

      const rows = await db
        .select()
        .from(customerEmailSuppressions)
        .where(eq(customerEmailSuppressions.companyId, companyAId));
      expect(rows).toHaveLength(2);
    });
  });

  describe("recordSuppression", () => {
    it("normalizes uppercase email before insert (no DB CHECK violation)", async () => {
      const { inserted } = await recordSuppression(db, {
        companyId: companyAId,
        contactEmail: "Alice@Example.COM",
        topic: "onboarding",
        reason: "user_unsubscribe",
      });

      expect(inserted).toBe(true);

      const rows = await db
        .select()
        .from(customerEmailSuppressions)
        .where(eq(customerEmailSuppressions.companyId, companyAId));
      expect(rows).toHaveLength(1);
      expect(rows[0].contactEmail).toBe("alice@example.com");
    });

    it("metadata defaults to {} when not provided", async () => {
      await recordSuppression(db, {
        companyId: companyAId,
        contactEmail: "alice@example.com",
        topic: "onboarding",
        reason: "user_unsubscribe",
      });

      const rows = await db
        .select()
        .from(customerEmailSuppressions)
        .where(eq(customerEmailSuppressions.companyId, companyAId));
      expect(rows[0].metadata).toEqual({});
    });

    it("preserves source_workflow_run_id + source_message_id when provided", async () => {
      const runId = "33333333-3333-3333-3333-333333333333";
      await recordSuppression(db, {
        companyId: companyAId,
        contactEmail: "alice@example.com",
        topic: "churn_rescue",
        reason: "spam_report",
        sourceWorkflowRunId: runId,
        sourceMessageId: "resend-msg-abc-123",
        metadata: { resend_event: "complained" },
      });

      const rows = await db
        .select()
        .from(customerEmailSuppressions)
        .where(eq(customerEmailSuppressions.companyId, companyAId));
      expect(rows[0].sourceWorkflowRunId).toBe(runId);
      expect(rows[0].sourceMessageId).toBe("resend-msg-abc-123");
      expect(rows[0].metadata).toEqual({ resend_event: "complained" });
    });
  });
});
