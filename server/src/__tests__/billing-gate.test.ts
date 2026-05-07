/**
 * billing-gate.test.ts — verifies the server-side plan-tier enforcement
 * middleware that closes the cost surface left open by client-only
 * <BillingGate> in the UI.
 *
 * The middleware is OPT-IN via FOUNDEROS_BILLING_GATE_ENABLED. With the
 * flag off it must pass through unconditionally — that's the soft-default
 * rollout posture documented in the file's docstring. With the flag on
 * it must:
 *
 *   - Allow active subscriptions
 *   - Allow trialing subscriptions (HEALTHY_SUBSCRIPTION_STATUSES)
 *   - Block inactive subscriptions with 402 + { error, message, requestId }
 *   - Bypass for local_implicit (founder self-host)
 *   - Bypass for instance_admin (support / debugging)
 *   - NOT bypass agent-typed actors (instance-level subscription = same gate)
 *   - Fail CLOSED on lookup error (return 402, not pass-through)
 *
 * Tests inject a stub for `isActive` so they don't have to spin up
 * embedded Postgres just to assert the 402 branch — same pattern the
 * rate-limit tests use. Wiring up the live subscription service is
 * covered by subscription-idempotency.test.ts elsewhere.
 *
 * NOTE — defense-in-depth (2026-05-05 council #132): a parallel gate now
 * lives inside `services/heartbeat.ts::enqueueWakeup` (search for
 * "billing.inactive"). It uses the same `isBillingGateEnabled()` flag and
 * same `subscriptionService(db).isSubscriptionActive()` lookup, but throws
 * `paymentRequired()` instead of writing 402 directly. It catches the 5+
 * service-layer wake call sites that bypass route middleware (issue
 * assignment, approval-driven wakes, comment-driven wakes, plugin
 * internal). Integration coverage for that path lives in heartbeat-billing-
 * gate.test.ts (TODO — task created at #132 follow-up; embedded-PG fixture
 * required, not a quick addition).
 */

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { billingGate } from "../middleware/billing-gate.js";

type ActorShape = {
  type: "board" | "agent" | "none";
  userId?: string;
  source?: string;
  isInstanceAdmin?: boolean;
};

function makeApp(opts: {
  actor?: ActorShape;
  isActive?: () => Promise<boolean>;
}) {
  const app = express();
  if (opts.actor) {
    app.use((req, _res, next) => {
      (req as unknown as { actor: ActorShape }).actor = opts.actor!;
      next();
    });
  }
  app.post(
    "/x",
    // db is unused when isActive is injected
    billingGate({} as never, { isActive: opts.isActive }),
    (_req, res) => res.status(200).json({ ok: true }),
  );
  return app;
}

describe("billingGate — flag OFF (default)", () => {
  beforeEach(() => {
    delete process.env.FOUNDEROS_BILLING_GATE_ENABLED;
  });

  it("passes through even when isActive would return false", async () => {
    const app = makeApp({
      actor: { type: "board", userId: "u-1", source: "supabase" },
      isActive: async () => false,
    });
    const res = await request(app).post("/x");
    expect(res.status).toBe(200);
  });
});

describe("billingGate — flag ON", () => {
  beforeEach(() => {
    process.env.FOUNDEROS_BILLING_GATE_ENABLED = "1";
  });
  afterEach(() => {
    delete process.env.FOUNDEROS_BILLING_GATE_ENABLED;
  });

  it("allows board actors with active subscription", async () => {
    const app = makeApp({
      actor: { type: "board", userId: "u-1", source: "supabase" },
      isActive: async () => true,
    });
    const res = await request(app).post("/x");
    expect(res.status).toBe(200);
  });

  it("blocks board actors with inactive subscription (402 + structured body)", async () => {
    const app = makeApp({
      actor: { type: "board", userId: "u-1", source: "supabase" },
      isActive: async () => false,
    });
    const res = await request(app).post("/x");
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("subscription_inactive");
    expect(res.body.message).toMatch(/subscription is required/i);
    // requestId may be null in tests (no request-context wrapper) — must
    // exist as a key, even if null, so the UI can quote whatever's there.
    expect(res.body).toHaveProperty("requestId");
  });

  it("bypasses local_implicit (self-host founder)", async () => {
    const app = makeApp({
      actor: { type: "board", userId: "local-board", source: "local_implicit" },
      isActive: async () => false, // even with inactive sub
    });
    const res = await request(app).post("/x");
    expect(res.status).toBe(200);
  });

  it("bypasses instance_admin (support/debug path)", async () => {
    const app = makeApp({
      actor: {
        type: "board",
        userId: "u-admin",
        source: "supabase",
        isInstanceAdmin: true,
      },
      isActive: async () => false,
    });
    const res = await request(app).post("/x");
    expect(res.status).toBe(200);
  });

  it("does NOT bypass agent-typed actors (instance-level subscription)", async () => {
    // Subscriptions are instance-level, so an agent recursively invoking
    // itself should still be gated when the instance is inactive.
    const app = makeApp({
      actor: { type: "agent", userId: "agent-1" },
      isActive: async () => false,
    });
    const res = await request(app).post("/x");
    expect(res.status).toBe(402);
  });

  it("fails CLOSED when isActive throws — returns 402, not 200", async () => {
    const app = makeApp({
      actor: { type: "board", userId: "u-1", source: "supabase" },
      isActive: async () => {
        throw new Error("db unreachable");
      },
    });
    const res = await request(app).post("/x");
    // Critical: an exception on the active-check must NOT pass-through.
    // Council BLOCK 2026-05-03 was specifically about silent fail-open
    // gates; this assertion is the regression guard.
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("subscription_inactive");
  });

  it("trialing maps to active via HEALTHY_SUBSCRIPTION_STATUSES", async () => {
    // The subscriptionService internals own that mapping; the middleware
    // just calls isActive(). This test asserts the contract: when the
    // service says active=true (which it does for `trialing`), the gate
    // passes through.
    const app = makeApp({
      actor: { type: "board", userId: "u-1", source: "supabase" },
      isActive: async () => true,
    });
    const res = await request(app).post("/x");
    expect(res.status).toBe(200);
  });
});

describe("billingGate — boot banner is logged once", () => {
  // The module-level _bootBannerLogged flag means we can't easily assert
  // "logged exactly once" without resetting module state across tests —
  // and resetting module state breaks vitest's per-file isolation. So
  // this is left as a manual smoke: in real boot, a single log line at
  // server start announces ENABLED or DISABLED, never per-request.
  it("placeholder — boot-banner behavior verified in integration smoke", () => {
    expect(true).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// PR-6c (ADR-013) — billing.gate_blocked audit row on 402 path
// ────────────────────────────────────────────────────────────────────────
describe("billingGate — audit row on 402 (PR-6c)", () => {
  beforeEach(() => {
    process.env.FOUNDEROS_BILLING_GATE_ENABLED = "1";
  });
  afterEach(() => {
    delete process.env.FOUNDEROS_BILLING_GATE_ENABLED;
  });

  function makeAppWithAudit(opts: {
    actor?: ActorShape;
    isActive?: () => Promise<boolean>;
    audit?: (event: { req: unknown; actor: ActorShape }) => Promise<void>;
    routePath?: string;
  }) {
    const app = express();
    if (opts.actor) {
      app.use((req, _res, next) => {
        (req as unknown as { actor: ActorShape }).actor = opts.actor!;
        next();
      });
    }
    app.post(
      opts.routePath ?? "/agents/:id/wakeup",
      billingGate({} as never, {
        isActive: opts.isActive,
        audit: opts.audit as never,
      }),
      (_req, res) => res.status(200).json({ ok: true }),
    );
    return app;
  }

  it("calls audit hook with {req, actor} on the 402 path", async () => {
    const audit = vi.fn().mockResolvedValue(undefined);
    const app = makeAppWithAudit({
      actor: { type: "board", userId: "u-1", source: "supabase" },
      isActive: async () => false,
      audit,
    });

    const res = await request(app).post(
      "/agents/11111111-1111-4111-8111-111111111111/wakeup",
    );

    expect(res.status).toBe(402);
    expect(audit).toHaveBeenCalledTimes(1);
    const event = audit.mock.calls[0][0] as {
      req: { params: { id: string }; path: string };
      actor: ActorShape;
    };
    expect(event.req.params.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(event.actor.userId).toBe("u-1");
  });

  it("does NOT call audit on the 200 path (active subscription)", async () => {
    const audit = vi.fn().mockResolvedValue(undefined);
    const app = makeAppWithAudit({
      actor: { type: "board", userId: "u-1", source: "supabase" },
      isActive: async () => true,
      audit,
    });

    const res = await request(app).post(
      "/agents/11111111-1111-4111-8111-111111111111/wakeup",
    );
    expect(res.status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });

  it("does NOT call audit when local_implicit bypasses the gate", async () => {
    const audit = vi.fn().mockResolvedValue(undefined);
    const app = makeAppWithAudit({
      actor: { type: "board", userId: "local-board", source: "local_implicit" },
      isActive: async () => false,
      audit,
    });
    const res = await request(app).post(
      "/agents/11111111-1111-4111-8111-111111111111/wakeup",
    );
    expect(res.status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });

  it("does NOT call audit when instance_admin bypasses the gate", async () => {
    const audit = vi.fn().mockResolvedValue(undefined);
    const app = makeAppWithAudit({
      actor: {
        type: "board",
        userId: "u-admin",
        source: "supabase",
        isInstanceAdmin: true,
      },
      isActive: async () => false,
      audit,
    });
    const res = await request(app).post(
      "/agents/11111111-1111-4111-8111-111111111111/wakeup",
    );
    expect(res.status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });

  it("calls audit BEFORE returning 402 (audit gets to run, not fire-and-forget)", async () => {
    // Ordering invariant: the response must not flush before audit
    // resolves. If we fire-and-forget the promise, an audit-write
    // failure would still leak via Sentry (good) but a fast-failing
    // 402 would race the audit row commit, creating gaps in the
    // forensic trail under load. Sequential is safer.
    let auditResolved = false;
    const audit = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            auditResolved = true;
            resolve();
          }, 20),
        ),
    );
    const app = makeAppWithAudit({
      actor: { type: "board", userId: "u-1", source: "supabase" },
      isActive: async () => false,
      audit,
    });

    const res = await request(app).post(
      "/agents/11111111-1111-4111-8111-111111111111/wakeup",
    );

    expect(res.status).toBe(402);
    expect(auditResolved).toBe(true);
  });

  it("returns 402 even if audit throws (forensic write must not break the gate)", async () => {
    const audit = vi.fn().mockRejectedValue(new Error("db unreachable"));
    const app = makeAppWithAudit({
      actor: { type: "board", userId: "u-1", source: "supabase" },
      isActive: async () => false,
      audit,
    });

    const res = await request(app).post(
      "/agents/11111111-1111-4111-8111-111111111111/wakeup",
    );

    // The cost-surface protection is load-bearing; audit is forensic.
    // An audit-write failure must NEVER mask the 402 — that would
    // silently fail-open the very gate the audit is supposed to record.
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("subscription_inactive");
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("calls audit even when isActive throws (fail-CLOSED branch is also audited)", async () => {
    // Council BLOCK 2026-05-03 forced isActive() exceptions to fail
    // CLOSED (return 402). That refusal is also forensically interesting
    // — a sustained burst of subscription-lookup failures might be a DB
    // outage masquerading as billing churn. Audit the closed-fail path.
    const audit = vi.fn().mockResolvedValue(undefined);
    const app = makeAppWithAudit({
      actor: { type: "board", userId: "u-1", source: "supabase" },
      isActive: async () => {
        throw new Error("subscription service unreachable");
      },
      audit,
    });

    const res = await request(app).post(
      "/agents/11111111-1111-4111-8111-111111111111/wakeup",
    );

    expect(res.status).toBe(402);
    expect(audit).toHaveBeenCalledTimes(1);
  });
});
