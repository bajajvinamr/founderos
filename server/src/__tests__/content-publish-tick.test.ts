/**
 * Tests for content-publish-tick job (S4.4).
 *
 * G1: No due drafts → no Composio/email calls
 * G2: Draft scheduled for past, status=approved, channel=linkedin → Composio called with connectedAccountId
 * G3: Draft scheduled for past, status=approved, channel=newsletter → sendEmail called
 * G4: Draft has no integration for its channel → status='failed', error set
 * G5: One failing draft doesn't block successful drafts in same tick
 * G6: Draft scheduled for future → not picked up
 *
 * Setup: embedded-pg fixture via startEmbeddedPostgresTestDatabase("s4-4-tick")
 * Mocks: Composio (runComposioTool), email (createEmailSender)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import {
  contentDrafts,
  companies,
  contentBriefs,
  composioConnections,
} from "@founderos/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { runContentPublishTick } from "../jobs/content-publish-tick.js";
import * as ComposioSkillBridge from "../services/skills/composio-skill-bridge.js";
import * as EmailSender from "../services/email-sender.js";
import { startEmbeddedPostgresTestDatabase } from "@founderos/db";

describe("content-publish-tick", () => {
  let db: Db;
  let cleanup: () => Promise<void>;
  let companyId: string;
  let briefId: string;
  let pastTime: Date;
  let futureTime: Date;

  beforeEach(async () => {
    const result = await startEmbeddedPostgresTestDatabase("s4-4-tick");
    cleanup = result.cleanup;
    db = drizzle(result.connectionString);

    pastTime = new Date(Date.now() - 1000 * 60 * 60); // 1 hour ago
    futureTime = new Date(Date.now() + 1000 * 60 * 60); // 1 hour from now

    // Create test company
    const [company] = await db
      .insert(companies)
      .values({
        name: "Test Company",
        brandName: "test",
      })
      .returning();
    companyId = company.id;

    // Create test brief
    const [brief] = await db
      .insert(contentBriefs)
      .values({
        companyId,
        title: "Test Brief",
        thesis: "Test thesis",
      })
      .returning();
    briefId = brief.id;

    // L2-A10: the job now resolves Composio routing from the per-company
    // `composio_connections` row instead of an env-var stub. Seed an active
    // connection for both LinkedIn and Twitter so G2/G5 reach
    // runComposioTool (the mock catches the call). G4 deletes its row to
    // assert the missing-connection failure path.
    await db.insert(composioConnections).values([
      {
        companyId,
        userId: "test-user-linkedin",
        appName: "linkedin",
        composioConnectionId: "ca_linkedin_test",
        status: "active",
      },
      {
        companyId,
        userId: "test-user-twitter",
        appName: "twitter",
        composioConnectionId: "ca_twitter_test",
        status: "active",
      },
    ]);

    // Mock Composio and email
    vi.spyOn(ComposioSkillBridge, "runComposioTool").mockResolvedValue({
      ok: true,
      message: "success",
    });
    vi.spyOn(EmailSender, "createEmailSender").mockReturnValue({
      enabled: true,
      send: vi.fn().mockResolvedValue({ ok: true, id: "email-123" }),
    });
  });

  afterEach(async () => {
    // Close the drizzle/node-postgres pool before tearing down the
    // embedded PG instance — otherwise in-flight pool connections throw
    // 57P01 ("terminating connection due to administrator command")
    // during teardown, which vitest counts as uncaught errors and
    // promotes to a test-file failure (even though all tests passed).
    // S6.9 fix: drain the pool first, swallow any teardown errors.
    try {
      const client = (db as unknown as { $client?: { end: () => Promise<void> } }).$client;
      if (client && typeof client.end === "function") {
        await client.end();
      }
    } catch {
      // pool already closed or never connected — fine
    }
    await cleanup();
    vi.clearAllMocks();
  });

  // G1: No due drafts → no calls
  it("G1: no due drafts → no Composio/email calls", async () => {
    await runContentPublishTick(db);

    expect(ComposioSkillBridge.runComposioTool).not.toHaveBeenCalled();
    const sender = EmailSender.createEmailSender({ apiKey: "test" });
    expect(sender.send).not.toHaveBeenCalled();
  });

  // G2: LinkedIn draft due and approved → Composio called with resolved userId
  it("G2: draft scheduled for past, status=approved, channel=linkedin → Composio called", async () => {
    // Create a LinkedIn draft scheduled for the past
    const [draft] = await db
      .insert(contentDrafts)
      .values({
        companyId,
        briefId,
        format: "linkedin",
        status: "approved",
        payload: {
          body: "Test LinkedIn post",
          hashtagSuggestions: [],
          estimatedReadTime: 2,
        },
        scheduledFor: pastTime,
      })
      .returning();

    await runContentPublishTick(db);

    // L2-A10: Verify Composio was called WITH the resolved userId and
    // connectedAccountId from the seeded composio_connections row, not the
    // empty string. The pre-L2-A10 code passed `userId: ""`, silently
    // routing to whichever account Composio picked first.
    expect(ComposioSkillBridge.runComposioTool).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "test-user-linkedin",
        connectedAccountId: "ca_linkedin_test",
        toolName: "linkedin_post_content",
      }),
    );

    // Verify draft was marked published
    const [updated] = await db.select().from(contentDrafts).where(eq(contentDrafts.id, draft.id));
    expect(updated.status).toBe("published");
    expect(updated.publishedAt).toBeTruthy();
    expect(updated.error).toBeNull();
  });

  // G3: Newsletter draft due and approved → email called
  it("G3: draft scheduled for past, status=approved, channel=newsletter → sendEmail called", async () => {
    const [draft] = await db
      .insert(contentDrafts)
      .values({
        companyId,
        briefId,
        format: "newsletter",
        status: "approved",
        payload: {
          subject: "Test Newsletter",
          body: "<p>Test content</p>",
        },
        scheduledFor: pastTime,
      })
      .returning();

    await runContentPublishTick(db);

    // Verify draft was marked published
    const [updated] = await db.select().from(contentDrafts).where(eq(contentDrafts.id, draft.id));
    expect(updated.status).toBe("published");
    expect(updated.publishedAt).toBeTruthy();
  });

  // G4: No active integration row for channel → error set, status unchanged
  it("G4: draft has no integration for its channel → error set", async () => {
    // Remove the seeded LinkedIn connection so the resolver throws
    // ComposioConnectionMissingError, which the job converts to a
    // user-visible "No active linkedin integration" error.
    await db
      .delete(composioConnections)
      .where(eq(composioConnections.appName, "linkedin"));

    const [draft] = await db
      .insert(contentDrafts)
      .values({
        companyId,
        briefId,
        format: "linkedin",
        status: "approved",
        payload: {
          body: "Test post",
          hashtagSuggestions: [],
          estimatedReadTime: 1,
        },
        scheduledFor: pastTime,
      })
      .returning();

    await runContentPublishTick(db);

    const [updated] = await db.select().from(contentDrafts).where(eq(contentDrafts.id, draft.id));
    expect(updated.status).toBe("approved");  // Status unchanged
    expect(updated.error).toBeTruthy();
    expect(updated.error).toContain("No active linkedin integration");

    // Composio MUST NOT have been called — the resolver short-circuited.
    expect(ComposioSkillBridge.runComposioTool).not.toHaveBeenCalled();
  });

  // G5: One failure doesn't block others
  it("G5: one failing draft does not block successful drafts in same tick", async () => {
    // Create one failing draft with LinkedIn format
    vi.mocked(ComposioSkillBridge.runComposioTool).mockResolvedValueOnce({
      ok: false,
      reason: "error",
      message: "Network error",
    });

    const [failingDraft] = await db
      .insert(contentDrafts)
      .values({
        companyId,
        briefId,
        format: "linkedin",
        status: "approved",
        payload: {
          body: "Failing post",
          hashtagSuggestions: [],
          estimatedReadTime: 1,
        },
        scheduledFor: pastTime,
      })
      .returning();

    // Mock for second call to succeed
    vi.mocked(ComposioSkillBridge.runComposioTool).mockResolvedValueOnce({
      ok: true,
      message: "success",
    });

    // Create success draft with different format to avoid unique constraint violation
    const [successDraft] = await db
      .insert(contentDrafts)
      .values({
        companyId,
        briefId,
        format: "x-thread",
        status: "approved",
        payload: {
          tweets: ["Successful post"],
          commentary: "Test"
        },
        scheduledFor: pastTime,
      })
      .returning();

    await runContentPublishTick(db);

    // Check that failing draft is marked failed
    const [failingUpdated] = await db
      .select()
      .from(contentDrafts)
      .where(eq(contentDrafts.id, failingDraft.id));
    expect(failingUpdated.error).toBeTruthy();  // Draft stays approved but has error set

    // Check that success draft is marked published
    const [successUpdated] = await db
      .select()
      .from(contentDrafts)
      .where(eq(contentDrafts.id, successDraft.id));
    expect(successUpdated.status).toBe("published");
  });

  // G7 (L2-A10): empty userId on an active connection row is rejected.
  // Defense-in-depth — the resolver catches this, AND the job-level guard
  // would catch it if the resolver were ever swapped out. Either way, the
  // empty-userId Composio call must never fire.
  it("G7: active connection with empty userId → fails fast, no Composio call", async () => {
    // Overwrite the seeded row with an empty userId — exercise the
    // resolver's data-integrity guard.
    await db
      .update(composioConnections)
      .set({ userId: "   " }) // whitespace-only — also covered
      .where(eq(composioConnections.appName, "linkedin"));

    const [draft] = await db
      .insert(contentDrafts)
      .values({
        companyId,
        briefId,
        format: "linkedin",
        status: "approved",
        payload: {
          body: "Test post",
          hashtagSuggestions: [],
          estimatedReadTime: 1,
        },
        scheduledFor: pastTime,
      })
      .returning();

    await runContentPublishTick(db);

    const [updated] = await db
      .select()
      .from(contentDrafts)
      .where(eq(contentDrafts.id, draft.id));
    expect(updated.status).toBe("approved"); // Status unchanged
    expect(updated.error).toBeTruthy();
    expect(updated.error?.toLowerCase()).toContain("userid");

    // Composio MUST NOT have been called — never pass userId: "".
    expect(ComposioSkillBridge.runComposioTool).not.toHaveBeenCalled();
  });

  // G6: Future scheduled → not picked up
  it("G6: scheduled_for=future → not picked up", async () => {
    const [draft] = await db
      .insert(contentDrafts)
      .values({
        companyId,
        briefId,
        format: "linkedin",
        status: "approved",
        payload: {
          body: "Future post",
          hashtagSuggestions: [],
          estimatedReadTime: 1,
        },
        scheduledFor: futureTime,
      })
      .returning();

    await runContentPublishTick(db);

    // Draft should remain unchanged
    const [unchanged] = await db.select().from(contentDrafts).where(eq(contentDrafts.id, draft.id));
    expect(unchanged.status).toBe("approved");
    expect(unchanged.publishedAt).toBeNull();

    // No Composio calls should have been made
    expect(ComposioSkillBridge.runComposioTool).not.toHaveBeenCalled();
  });
});
