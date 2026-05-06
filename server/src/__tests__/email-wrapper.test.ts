/**
 * email-wrapper.test.ts — S4.8 prerequisite #197.
 *
 * Tests for the transport-layer compliance wrapper. Two layers of coverage:
 *
 *   - Pure unit tests for wrapEmailForCompliance() — no DB, deterministic.
 *     Covers: missing address fail-closed, footer injection, idempotency
 *     when marker already present, html injection BEFORE </body>, and
 *     escape behavior on unsafe address values.
 *
 *   - Integration test for sendWithCompliance() with a real embedded
 *     postgres + companies row. Exercises the full path including DB load,
 *     wrap, transport handoff.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb } from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  loadComplianceContextForCompany,
  sendWithCompliance,
  wrapEmailForCompliance,
  type ComplianceContext,
} from "../services/transports/email-wrapper.js";

// ── Pure unit tests ─────────────────────────────────────────────────────────

describe("wrapEmailForCompliance — pure unit", () => {
  const baseInput = {
    to: "alice@example.com",
    from: "founder@founderos.io",
    subject: "Welcome",
    text: "Hey Alice,\n\nThanks for signing up.",
    html: "<!DOCTYPE html><html><body><p>Hey Alice,</p><p>Thanks for signing up.</p></body></html>",
  };

  const ctx: ComplianceContext = {
    companyId: "11111111-1111-1111-1111-111111111111",
    companyName: "Acme Corp",
    physicalAddress: "123 Main St, Suite 4\nSan Francisco, CA 94105\nUSA",
    supportEmail: "support@acme.example.com",
  };

  const unsubscribeUrl =
    "https://founderos.fly.dev/u/customer/abc.def";

  it("fails closed when physicalAddress is null", () => {
    const result = wrapEmailForCompliance(
      baseInput,
      { ...ctx, physicalAddress: null },
      unsubscribeUrl,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("compliance_address_missing");
      expect(result.companyId).toBe(ctx.companyId);
    }
  });

  it("fails closed when physicalAddress is empty string", () => {
    const result = wrapEmailForCompliance(
      baseInput,
      { ...ctx, physicalAddress: "   " },
      unsubscribeUrl,
    );
    expect(result.ok).toBe(false);
  });

  it("injects text + html footers when address present", () => {
    const result = wrapEmailForCompliance(baseInput, ctx, unsubscribeUrl);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.alreadyHadFooter).toBe(false);
    expect(result.wrapped.text).toContain("[founderos-compliance-footer]");
    expect(result.wrapped.text).toContain("Acme Corp");
    expect(result.wrapped.text).toContain("123 Main St");
    expect(result.wrapped.text).toContain("Unsubscribe: " + unsubscribeUrl);

    expect(result.wrapped.html).toContain("<!-- founderos-compliance-footer -->");
    expect(result.wrapped.html).toContain("Acme Corp");
    expect(result.wrapped.html).toContain('href="https://founderos.fly.dev/u/customer/abc.def"');
  });

  it("injects html footer BEFORE </body> tag when present", () => {
    const result = wrapEmailForCompliance(baseInput, ctx, unsubscribeUrl);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const html = result.wrapped.html ?? "";
    const footerIdx = html.indexOf("<!-- founderos-compliance-footer -->");
    const bodyCloseIdx = html.lastIndexOf("</body>");
    expect(footerIdx).toBeGreaterThan(-1);
    expect(bodyCloseIdx).toBeGreaterThan(footerIdx);
  });

  it("appends html footer at end when no </body> tag present (fragment)", () => {
    const fragmentInput = {
      ...baseInput,
      html: "<p>Hey Alice,</p>",
    };
    const result = wrapEmailForCompliance(fragmentInput, ctx, unsubscribeUrl);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.wrapped.html).toContain("<p>Hey Alice,</p>");
    expect(result.wrapped.html).toContain("<!-- founderos-compliance-footer -->");
    // Footer appended at end (not interpolated mid-html).
    const idx = (result.wrapped.html ?? "").indexOf("<!-- founderos-compliance-footer -->");
    expect(idx).toBeGreaterThan((result.wrapped.html ?? "").indexOf("<p>Hey Alice"));
  });

  it("idempotent — does not double-inject when both markers already present", () => {
    const inputWithFooter = {
      ...baseInput,
      text: baseInput.text + "\n[founderos-compliance-footer]",
      html: baseInput.html.replace(
        "</body>",
        "<!-- founderos-compliance-footer --></body>",
      ),
    };
    const result = wrapEmailForCompliance(
      inputWithFooter,
      ctx,
      unsubscribeUrl,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.alreadyHadFooter).toBe(true);
    expect(result.wrapped).toEqual(inputWithFooter);
  });

  it("escapes HTML-unsafe characters in companyName / physicalAddress", () => {
    const xssCtx: ComplianceContext = {
      ...ctx,
      companyName: "Acme <script>alert(1)</script>",
      physicalAddress: '123 "Main" & Center\nNo, NV',
    };
    const result = wrapEmailForCompliance(baseInput, xssCtx, unsubscribeUrl);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.wrapped.html).not.toContain("<script>alert(1)</script>");
    expect(result.wrapped.html).toContain("&lt;script&gt;");
    expect(result.wrapped.html).toContain("&quot;Main&quot;");
    expect(result.wrapped.html).toContain("&amp; Center");
  });

  it("renders supportEmail when present, omits when null", () => {
    const withSupport = wrapEmailForCompliance(baseInput, ctx, unsubscribeUrl);
    if (!withSupport.ok) throw new Error("setup failed");
    expect(withSupport.wrapped.text).toContain("support@acme.example.com");

    const withoutSupport = wrapEmailForCompliance(
      baseInput,
      { ...ctx, supportEmail: null },
      unsubscribeUrl,
    );
    if (!withoutSupport.ok) throw new Error("setup failed");
    expect(withoutSupport.wrapped.text).not.toContain("support@");
  });
});

// ── Integration tests ──────────────────────────────────────────────────────

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping email-wrapper integration tests: ${support.reason ?? "unsupported"}`,
  );
}

describeEmbedded("email-wrapper — DB integration", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("email-wrapper");
    db = createDb(testDb.connectionString);
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const [company] = await db
      .insert(companies)
      .values({
        name: "Acme Test Co",
        instanceId: "test-instance",
        issuePrefix: `EW${suffix}`,
        physicalAddress: "456 Test Lane\nTestville, TS 12345",
        supportEmail: "support@acme.test",
      })
      .returning();
    companyId = company.id;
  });

  it("loadComplianceContextForCompany reads physical_address + support_email", async () => {
    const ctx = await loadComplianceContextForCompany(db, companyId);
    expect(ctx).not.toBeNull();
    expect(ctx!.companyName).toBe("Acme Test Co");
    expect(ctx!.physicalAddress).toContain("456 Test Lane");
    expect(ctx!.supportEmail).toBe("support@acme.test");
  });

  it("loadComplianceContextForCompany returns null for unknown id", async () => {
    const ctx = await loadComplianceContextForCompany(
      db,
      "00000000-0000-0000-0000-000000000000",
    );
    expect(ctx).toBeNull();
  });

  it("sendWithCompliance refuses send when physical_address is null", async () => {
    // Wipe the address to simulate unconfigured tenant.
    await db
      .update(companies)
      .set({ physicalAddress: null })
      .where(eq(companies.id, companyId));

    const send = vi.fn().mockResolvedValue({ id: "x", status: "queued" });
    const result = await sendWithCompliance({
      db,
      companyId,
      unsubscribeUrl: "https://founderos.fly.dev/u/customer/a.b",
      input: {
        to: "x@y.test",
        from: "f@founderos.io",
        subject: "Hi",
        text: "hi",
        html: "<p>hi</p>",
      },
      send,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("compliance_address_missing");
    expect(send).not.toHaveBeenCalled();
  });

  it("sendWithCompliance wraps + delegates to underlying send", async () => {
    const send = vi.fn().mockResolvedValue({ id: "msg-123", status: "queued" });
    const result = await sendWithCompliance({
      db,
      companyId,
      unsubscribeUrl: "https://founderos.fly.dev/u/customer/a.b",
      input: {
        to: "x@y.test",
        from: "f@founderos.io",
        subject: "Hi",
        text: "Hello there",
        html: "<!DOCTYPE html><html><body><p>Hello</p></body></html>",
      },
      send,
    });

    expect(result.status).toBe("queued");
    expect(result.id).toBe("msg-123");
    expect(send).toHaveBeenCalledOnce();
    const sentArg = send.mock.calls[0]![0];
    expect(sentArg.text).toContain("Acme Test Co");
    expect(sentArg.text).toContain("456 Test Lane");
    expect(sentArg.text).toContain("Unsubscribe: https://founderos.fly.dev/u/customer/a.b");
    expect(sentArg.html).toContain("<!-- founderos-compliance-footer -->");
  });

  it("sendWithCompliance returns 'company_not_found' for unknown companyId", async () => {
    const send = vi.fn();
    const result = await sendWithCompliance({
      db,
      companyId: "00000000-0000-0000-0000-000000000000",
      unsubscribeUrl: "https://founderos.fly.dev/u/customer/a.b",
      input: {
        to: "x@y.test",
        from: "f@founderos.io",
        subject: "Hi",
        text: "hi",
        html: "<p>hi</p>",
      },
      send,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("company_not_found");
    expect(send).not.toHaveBeenCalled();
  });
});
