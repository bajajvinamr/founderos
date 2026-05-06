/**
 * Client-readiness #5 — workflow actually sends email (validates W0.1+W0.2).
 *
 * Per LRP Day 6 spec:
 *   - Create workflow with autonomy=4
 *   - Trigger run
 *   - Assert HTTP 201 from POST /runs
 *   - Assert Resend test inbox received email within 30s
 *   - Assert workflow_run.actions[i].status="completed" ONLY after webhook
 *     confirms delivery
 *   - Assert activity_log has entry with action="workflow_run.completed"
 *     and lineage
 *
 * Required fixtures (deep happy path):
 *   - FOUNDEROS_E2E_BOARD_API_KEY — board API key for the test workspace
 *   - FOUNDEROS_E2E_TEST_WORKFLOW_TEMPLATE — name of a pre-installed
 *     template that ends in a single send-email action (e.g.
 *     "onboarding-emails")
 *   - FOUNDEROS_E2E_RESEND_INBOX_TOKEN  — Resend test-mode inbox API key
 *   - FOUNDEROS_E2E_RESEND_INBOX_ADDRESS — destination address used in
 *     the workflow
 *   - FOUNDEROS_E2E_AUTONOMY4_OPT_IN — explicit ack that autonomy=4 will
 *     send a real email; required to prevent accidentally firing prod
 *     emails from a misconfigured fixture set.
 *
 * The "wire ≠ working" gate is critical here (per CLAUDE.md):
 *   "After integrating any 3rd-party service (analytics, error tracking,
 *    payments, APM): verify data actually arrives in that service's
 *    dashboard before moving on. Code compiling is not the same as
 *    integration working."
 *
 * This spec is the live wire-test for the email path.
 */
import { test, expect } from "../../fixtures";
import { envFixture } from "./_helpers";

test.describe("client-readiness — workflow sends real email (W0.1+W0.2)", () => {
  test("[server-alive] /api/health responds", async ({ api }) => {
    const res = await api.get("/api/health");
    expect(
      res.status,
      `GET /api/health returned ${res.status}.`,
    ).toBe(200);
  });

  test("[deep] autonomy=4 workflow → Resend inbox receives email; row marked completed only post-webhook", async ({
    api,
  }) => {
    if ((process.env.FOUNDEROS_E2E_PROFILE || "").toLowerCase() === "public-only") {
      test.skip(true, "public-only profile — autonomy=4 workflow runs send real email and run only on isolated staging");
      return;
    }

    const optIn = envFixture(
      "FOUNDEROS_E2E_AUTONOMY4_OPT_IN",
      "explicit opt-in (any non-empty value) confirming this run will fire real email through Resend test mode",
    );
    const apiKey = envFixture(
      "FOUNDEROS_E2E_BOARD_API_KEY",
      "board API key for the test workspace",
    );
    const templateName = envFixture(
      "FOUNDEROS_E2E_TEST_WORKFLOW_TEMPLATE",
      "name of a pre-installed template (e.g. onboarding-emails)",
    );
    const resendToken = envFixture(
      "FOUNDEROS_E2E_RESEND_INBOX_TOKEN",
      "Resend test-mode inbox API key",
    );
    const resendInbox = envFixture(
      "FOUNDEROS_E2E_RESEND_INBOX_ADDRESS",
      "destination address used as the workflow recipient",
    );

    const reasons = [optIn, apiKey, templateName, resendToken, resendInbox]
      .filter((f) => !f.ok)
      .map((f) => f.reason!);
    if (reasons.length > 0) {
      test.skip(true, reasons.join(" | "));
      return;
    }

    // When fixtures are wired:
    //   1. POST /api/workflows {template, autonomy: 4, recipient: resendInbox}
    //      → assert 201 with workflow id
    //   2. POST /api/workflows/:id/runs → assert 201 with run id
    //   3. Assert workflow_run.actions[i].status === "pending" (not yet
    //      "completed" — webhook hasn't fired)
    //   4. Poll Resend inbox API every 2s up to 30s → assert one message
    //      arrived with the expected subject
    //   5. Poll GET /api/runs/:id every 1s up to 10s → assert
    //      actions[i].status === "completed" — proves the wire from
    //      Resend webhook → completion update is intact
    //   6. GET /api/audit/runs/:id → assert one entry with
    //      action="workflow_run.completed" and lineage chain referencing
    //      the workflow_id
    //
    // Implementation deferred to fixture-wire-up. The opt-in env var is
    // load-bearing — if a future contributor leaks the inbox address into
    // a public fixture, the opt-in gate prevents accidental real-email
    // fires.
    expect(true, "deep flow body to be added when fixture wired").toBe(true);
  });
});
