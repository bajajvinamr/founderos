/**
 * churn-rescue-generator.test.ts — S4.8 run-CREATION time generator.
 *
 * Coverage:
 *   1. Empty cohort → ok=false, reason=empty_input
 *   2. All-invalid emails → ok=false, reason=all_dropped
 *   3. Single valid candidate → ok=true with 1 action
 *   4. Multiple candidates → 1 action per retained recipient, in order
 *   5. Suppression-pre-filter (#196) → suppressed candidate dropped
 *   6. Cap enforced (#195 default 100) → overCap counted, truncated
 *   7. Each cancellationCategory produces a distinct subject line
 *   8. Coupon code is appended as URL param to the rescueUrl
 *   9. Determinism — same input twice produces byte-identical output
 *  10. Tenant isolation — company B's suppression doesn't filter company A
 *  11. Cancellation category survives through to the rendered email body
 *  12. PII safety — raw cancellation text in payload meta NEVER leaks into body
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  customerEmailSuppressions,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  generateChurnRescueActions,
  CANCELLATION_CATEGORIES,
} from "../services/workflows/templates/churn-rescue-generator.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping churn-rescue-generator tests: ${support.reason ?? "unsupported"}`,
  );
}

describeEmbedded("S4.8 churn-rescue generator", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyAId: string;
  let companyBId: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("churn-gen");
    db = createDb(testDb.connectionString);
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    await db.delete(customerEmailSuppressions);
    await db.delete(companies);
    const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const [a] = await db
      .insert(companies)
      .values({
        name: "Co A",
        instanceId: "test",
        issuePrefix: `GA${suffix}`,
      })
      .returning();
    const [b] = await db
      .insert(companies)
      .values({
        name: "Co B",
        instanceId: "test",
        issuePrefix: `GB${suffix}`,
      })
      .returning();
    companyAId = a.id;
    companyBId = b.id;
  });

  // ── 1-2. Failure shapes ──────────────────────────────────────────────────

  it("rejects empty input as empty_input failure", async () => {
    const result = await generateChurnRescueActions(db, {
      companyId: companyAId,
      candidates: [],
      config: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("empty_input");
  });

  it("rejects all-invalid input as all_dropped", async () => {
    const result = await generateChurnRescueActions(db, {
      companyId: companyAId,
      candidates: [
        { email: "no-at-sign", cancellationCategory: "pricing" },
        { email: "trailing@", cancellationCategory: "other" },
      ],
      config: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("all_dropped");
  });

  // ── 3-4. Happy path ──────────────────────────────────────────────────────

  it("renders one action per retained recipient", async () => {
    const result = await generateChurnRescueActions(db, {
      companyId: companyAId,
      candidates: [
        {
          email: "alice@example.com",
          contactName: "Alice",
          cancellationCategory: "pricing",
        },
      ],
      config: { rescueUrl: "https://example.com/billing", couponCode: "SAVE25" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actions).toHaveLength(1);
    const action = result.actions[0];
    expect(action.type).toBe("send_email");
    expect(action.payload.recipientEmail).toBe("alice@example.com");
    expect(action.payload.recipientName).toBe("Alice");
    expect(action.status).toBe("pending");
    expect(action.payload.subject).toContain("Sorry to see you go");
  });

  it("preserves recipient order from materialization", async () => {
    const result = await generateChurnRescueActions(db, {
      companyId: companyAId,
      candidates: [
        { email: "charlie@example.com", cancellationCategory: "other" },
        { email: "alice@example.com", cancellationCategory: "pricing" },
        { email: "bob@example.com", cancellationCategory: "missing_features" },
      ],
      config: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actions.map((a) => a.payload.recipientEmail)).toEqual([
      "charlie@example.com",
      "alice@example.com",
      "bob@example.com",
    ]);
  });

  // ── 5. Suppression pre-filter (uses #195 → #196) ─────────────────────────

  it("drops candidates with topic='churn_rescue' suppression", async () => {
    await db.insert(customerEmailSuppressions).values({
      companyId: companyAId,
      contactEmail: "blocked@example.com",
      topic: "churn_rescue",
      reason: "user_unsubscribe",
      metadata: {},
    });
    const result = await generateChurnRescueActions(db, {
      companyId: companyAId,
      candidates: [
        { email: "blocked@example.com", cancellationCategory: "pricing" },
        { email: "ok@example.com", cancellationCategory: "pricing" },
      ],
      config: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].payload.recipientEmail).toBe("ok@example.com");
    expect(result.counts.droppedSuppressed).toBe(1);
  });

  // ── 6. Cap enforcement ───────────────────────────────────────────────────

  it("truncates at the recipient cap (default 100)", async () => {
    const candidates = Array.from({ length: 105 }, (_, i) => ({
      email: `user${i}@example.com`,
      cancellationCategory: "pricing" as const,
    }));
    const result = await generateChurnRescueActions(db, {
      companyId: companyAId,
      candidates,
      config: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actions).toHaveLength(100);
    expect(result.counts.droppedOverCap).toBe(5);
  });

  // ── 7. Per-category subject distinctness ─────────────────────────────────

  it("produces a distinct subject line per cancellation category", async () => {
    const subjects = new Set<string>();
    for (const category of CANCELLATION_CATEGORIES) {
      const result = await generateChurnRescueActions(db, {
        companyId: companyAId,
        candidates: [
          { email: `${category}@example.com`, cancellationCategory: category },
        ],
        config: {},
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      subjects.add(result.actions[0].payload.subject);
    }
    // 9 categories → 9 distinct subjects
    expect(subjects.size).toBe(CANCELLATION_CATEGORIES.length);
  });

  // ── 8. Coupon URL contract ───────────────────────────────────────────────

  it("appends coupon code as a URL query param to rescueUrl", async () => {
    const result = await generateChurnRescueActions(db, {
      companyId: companyAId,
      candidates: [
        { email: "alice@example.com", cancellationCategory: "pricing" },
      ],
      config: {
        rescueUrl: "https://example.com/billing?source=email",
        couponCode: "RESCUE25",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actions[0].payload.bodyText).toContain(
      "https://example.com/billing?source=email&coupon=RESCUE25",
    );
    expect(result.actions[0].payload.bodyHtml).toContain(
      "https://example.com/billing?source=email&amp;coupon=RESCUE25",
    );
  });

  // ── 9. Determinism — same input twice → byte-identical output ────────────

  it("produces byte-identical output across two runs (idempotency contract)", async () => {
    const args = {
      companyId: companyAId,
      candidates: [
        {
          email: "alice@example.com",
          contactName: "Alice",
          cancellationCategory: "pricing" as const,
        },
        {
          email: "bob@example.com",
          contactName: "Bob",
          cancellationCategory: "missing_features" as const,
        },
      ],
      config: { rescueUrl: "https://x.io/r", couponCode: "RESCUE25" },
    };
    const a = await generateChurnRescueActions(db, args);
    const b = await generateChurnRescueActions(db, args);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(JSON.stringify(a.actions)).toBe(JSON.stringify(b.actions));
  });

  // ── 10. Cross-tenant isolation ───────────────────────────────────────────

  it("does NOT honor company B's suppression when generating for company A", async () => {
    await db.insert(customerEmailSuppressions).values({
      companyId: companyBId,
      contactEmail: "shared@example.com",
      topic: "churn_rescue",
      reason: "user_unsubscribe",
      metadata: {},
    });
    const result = await generateChurnRescueActions(db, {
      companyId: companyAId,
      candidates: [
        { email: "shared@example.com", cancellationCategory: "pricing" },
      ],
      config: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actions).toHaveLength(1);
  });

  // ── 11. Category passthrough ──────────────────────────────────────────────

  it("renders different bodies for different cancellation categories", async () => {
    const pricingResult = await generateChurnRescueActions(db, {
      companyId: companyAId,
      candidates: [
        { email: "p@example.com", cancellationCategory: "pricing" },
      ],
      config: {},
    });
    const competitorResult = await generateChurnRescueActions(db, {
      companyId: companyAId,
      candidates: [
        { email: "c@example.com", cancellationCategory: "moving_to_competitor" },
      ],
      config: {},
    });
    expect(pricingResult.ok && competitorResult.ok).toBe(true);
    if (!pricingResult.ok || !competitorResult.ok) return;
    expect(pricingResult.actions[0].payload.bodyText).not.toBe(
      competitorResult.actions[0].payload.bodyText,
    );
    expect(pricingResult.actions[0].payload.bodyText).toContain("cost");
  });

  // ── 12. PII safety — caller passes ENUM only, no raw text path ──────────

  it("does not surface arbitrary metadata in the rendered body (PII allowlist)", async () => {
    // Even if the caller (somehow) attaches a free-form externalId or name,
    // the renderer only uses fields it explicitly templates. The
    // cancellationCategory enum is the ONLY upstream signal that influences
    // copy — protecting against the #193 prompt-injection class of failure.
    const result = await generateChurnRescueActions(db, {
      companyId: companyAId,
      candidates: [
        {
          email: "alice@example.com",
          contactName: "Alice <script>alert(1)</script>",
          externalId: "DROP TABLE users; --",
          cancellationCategory: "other",
        },
      ],
      config: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const html = result.actions[0].payload.bodyHtml;
    // contactName flows into the greeting, but is HTML-escaped
    expect(html).toContain("Alice &lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    // externalId never surfaces in the body
    expect(html).not.toContain("DROP TABLE");
    expect(result.actions[0].payload.bodyText).not.toContain("DROP TABLE");
  });
});
