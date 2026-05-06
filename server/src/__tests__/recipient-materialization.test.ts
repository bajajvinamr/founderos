/**
 * recipient-materialization.test.ts — S4.8 prerequisite #195.
 *
 * Tests for the recipient materialization gate. Coverage:
 *   1. Empty input → empty_input failure
 *   2. All-invalid input → all_dropped failure
 *   3. Valid candidates → retained, lowercased
 *   4. Dedup: same email appearing twice collapses to one
 *   5. Invalid email shapes dropped (no @, no domain, whitespace)
 *   6. Suppression pre-filter: topic="onboarding" suppression drops the contact
 *   7. Suppression pre-filter: topic="all" master switch drops the contact
 *   8. Cross-tenant: company B's suppressions DON'T affect company A's run
 *   9. Cap: recipients > cap are truncated and overCap counted
 *  10. Env override raises cap
 *  11. Counts shape: every drop contributes to the right counter
 *  12. Order preserved in retained list
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { sql } from "drizzle-orm";
import {
  companies,
  createDb,
  customerEmailSuppressions,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { materializeRecipients } from "../services/recipient-materialization.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping recipient-materialization tests: ${support.reason ?? "unsupported"}`,
  );
}

describeEmbedded("recipient-materialization", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyAId: string;
  let companyBId: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("recipient-mat");
    db = createDb(testDb.connectionString);
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    delete process.env.FOUNDEROS_RECIPIENT_CAP_CHURN_RESCUE;

    const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const [a] = await db
      .insert(companies)
      .values({ name: "Co A", instanceId: "test", issuePrefix: `CA${suffix}` })
      .returning();
    const [b] = await db
      .insert(companies)
      .values({ name: "Co B", instanceId: "test", issuePrefix: `CB${suffix}` })
      .returning();
    companyAId = a.id;
    companyBId = b.id;
  });

  afterEach(() => {
    delete process.env.FOUNDEROS_RECIPIENT_CAP_CHURN_RESCUE;
  });

  it("rejects empty input as empty_input failure", async () => {
    const result = await materializeRecipients(db, {
      companyId: companyAId,
      topic: "churn_rescue",
      candidates: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("empty_input");
  });

  it("rejects all-invalid input as all_dropped", async () => {
    const result = await materializeRecipients(db, {
      companyId: companyAId,
      topic: "churn_rescue",
      candidates: [
        { email: "no-at-sign" },
        { email: "trailing@" },
        { email: "" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("all_dropped");
    if (result.reason !== "all_dropped") return;
    expect(result.counts.invalidEmail).toBe(3);
    expect(result.counts.retained).toBe(0);
  });

  it("retains valid candidates with lowercased emails", async () => {
    const result = await materializeRecipients(db, {
      companyId: companyAId,
      topic: "churn_rescue",
      candidates: [
        { email: "ALICE@example.COM", name: "Alice" },
        { email: " bob@example.com ", externalId: "ph_123" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recipients).toHaveLength(2);
    expect(result.recipients[0].email).toBe("alice@example.com");
    expect(result.recipients[0].name).toBe("Alice");
    expect(result.recipients[1].email).toBe("bob@example.com");
    expect(result.recipients[1].externalId).toBe("ph_123");
  });

  it("deduplicates same email with different casing/whitespace", async () => {
    const result = await materializeRecipients(db, {
      companyId: companyAId,
      topic: "churn_rescue",
      candidates: [
        { email: "alice@example.com" },
        { email: "ALICE@example.com" },
        { email: " alice@example.com " },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recipients).toHaveLength(1);
    expect(result.counts.duplicate).toBe(2);
  });

  it("drops invalid email shapes individually", async () => {
    const result = await materializeRecipients(db, {
      companyId: companyAId,
      topic: "churn_rescue",
      candidates: [
        { email: "alice@example.com" },
        { email: "no-at-sign" },
        { email: "missing-domain@" },
        { email: "bob@example.com" },
        { email: "@no-local.com" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recipients).toHaveLength(2);
    expect(result.counts.invalidEmail).toBe(3);
  });

  it("filters out contacts with topic-specific suppression", async () => {
    await db.insert(customerEmailSuppressions).values({
      companyId: companyAId,
      contactEmail: "bob@example.com",
      topic: "churn_rescue",
      reason: "user_unsubscribe",
      metadata: {},
    });

    const result = await materializeRecipients(db, {
      companyId: companyAId,
      topic: "churn_rescue",
      candidates: [
        { email: "alice@example.com" },
        { email: "bob@example.com" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recipients).toHaveLength(1);
    expect(result.recipients[0].email).toBe("alice@example.com");
    expect(result.counts.suppressed).toBe(1);
  });

  it("filters out contacts with topic='all' master suppression", async () => {
    await db.insert(customerEmailSuppressions).values({
      companyId: companyAId,
      contactEmail: "carol@example.com",
      topic: "all",
      reason: "user_unsubscribe",
      metadata: {},
    });

    const result = await materializeRecipients(db, {
      companyId: companyAId,
      topic: "churn_rescue",
      candidates: [{ email: "carol@example.com" }],
    });
    // All candidates dropped → all_dropped failure
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("all_dropped");
  });

  it("cross-tenant: company B's suppression DOESN'T filter company A's run", async () => {
    await db.insert(customerEmailSuppressions).values({
      companyId: companyBId,
      contactEmail: "shared@example.com",
      topic: "churn_rescue",
      reason: "user_unsubscribe",
      metadata: {},
    });

    const result = await materializeRecipients(db, {
      companyId: companyAId,
      topic: "churn_rescue",
      candidates: [{ email: "shared@example.com" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recipients).toHaveLength(1);
  });

  it("caps recipients at default 100, marks overCap", async () => {
    const cands = Array.from({ length: 105 }, (_, i) => ({
      email: `user${i}@example.com`,
    }));
    const result = await materializeRecipients(db, {
      companyId: companyAId,
      topic: "churn_rescue",
      candidates: cands,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recipients).toHaveLength(100);
    expect(result.counts.overCap).toBe(5);
  });

  it("env override raises the cap", async () => {
    process.env.FOUNDEROS_RECIPIENT_CAP_CHURN_RESCUE = "200";
    const cands = Array.from({ length: 150 }, (_, i) => ({
      email: `user${i}@example.com`,
    }));
    const result = await materializeRecipients(db, {
      companyId: companyAId,
      topic: "churn_rescue",
      candidates: cands,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recipients).toHaveLength(150);
    expect(result.counts.overCap).toBe(0);
  });

  it("preserves first-seen order in retained list", async () => {
    const result = await materializeRecipients(db, {
      companyId: companyAId,
      topic: "churn_rescue",
      candidates: [
        { email: "charlie@example.com" },
        { email: "alice@example.com" },
        { email: "bob@example.com" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recipients.map((r) => r.email)).toEqual([
      "charlie@example.com",
      "alice@example.com",
      "bob@example.com",
    ]);
  });

  it("counts shape is consistent across all drop reasons", async () => {
    await db.insert(customerEmailSuppressions).values({
      companyId: companyAId,
      contactEmail: "supp@example.com",
      topic: "churn_rescue",
      reason: "user_unsubscribe",
      metadata: {},
    });

    const result = await materializeRecipients(db, {
      companyId: companyAId,
      topic: "churn_rescue",
      candidates: [
        { email: "ok@example.com" },
        { email: "OK@example.com" }, // duplicate
        { email: "supp@example.com" }, // suppressed
        { email: "garbage" }, // invalid
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.counts).toEqual({
      received: 4,
      invalidEmail: 1,
      duplicate: 1,
      suppressed: 1,
      overCap: 0,
      retained: 1,
    });
  });
});
