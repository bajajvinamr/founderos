/**
 * rate-limit-ai.test.ts — verifies the new agent-invoke + onboarding-bootstrap
 * limiters added in fix/rate-limits-ai.
 *
 * Both limiters share the same skeleton as the pre-existing 5 limiters in
 * `middleware/rate-limit.ts`; what's different is the choice of key (per-user
 * for agent invoke, per-IP for onboarding bootstrap) and the budget.
 *
 * We don't test the existing limiters here — only the two we just added.
 * The full mount-point integration is exercised by the targeted PR tests
 * in agents.ts and onboarding.ts elsewhere.
 */

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  agentInvokeLimiter,
  onboardingBootstrapLimiter,
} from "../middleware/rate-limit.js";

function makeApp(opts: {
  limiter: ReturnType<typeof Object>;
  withActor?: { userId: string };
}) {
  const app = express();
  // Trust the X-Forwarded-For header so per-IP keying in tests is stable.
  app.set("trust proxy", true);
  if (opts.withActor) {
    app.use((req, _res, next) => {
      (req as unknown as { actor: { userId: string } }).actor = opts.withActor!;
      next();
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/x", opts.limiter as any, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe("agentInvokeLimiter — 30/min per user", () => {
  it("allows up to 30 invocations from the same user within a minute", async () => {
    const app = makeApp({ limiter: agentInvokeLimiter, withActor: { userId: "u-allow" } });
    for (let i = 0; i < 30; i += 1) {
      const res = await request(app).post("/x");
      expect(res.status, `req ${i + 1}`).toBe(200);
    }
  });

  it("returns 429 with friendly body on the 31st request from the same user", async () => {
    const app = makeApp({ limiter: agentInvokeLimiter, withActor: { userId: "u-block" } });
    for (let i = 0; i < 30; i += 1) {
      await request(app).post("/x");
    }
    const blocked = await request(app).post("/x");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("Too many agent invocations");
    expect(blocked.body.message).toContain("agent runs cost money");
  });

  it("does NOT bleed between users — each user has their own bucket", async () => {
    const app = makeApp({ limiter: agentInvokeLimiter, withActor: { userId: "u-A" } });
    // Burn 30 for user A.
    for (let i = 0; i < 30; i += 1) await request(app).post("/x");
    // Different actor on the same Express instance should still be allowed.
    // We simulate this by overriding the actor on a fresh app — the rate
    // limit store is module-scoped, but the key differs.
    const appB = makeApp({ limiter: agentInvokeLimiter, withActor: { userId: "u-B" } });
    const res = await request(appB).post("/x");
    expect(res.status).toBe(200);
  });
});

describe("onboardingBootstrapLimiter — 5/hr per IP", () => {
  it("allows up to 5 bootstrap attempts from the same IP within an hour", async () => {
    const app = makeApp({ limiter: onboardingBootstrapLimiter });
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app)
        .post("/x")
        .set("X-Forwarded-For", "203.0.113.10");
      expect(res.status, `req ${i + 1}`).toBe(200);
    }
  });

  it("returns 429 with friendly body on the 6th attempt from the same IP", async () => {
    const app = makeApp({ limiter: onboardingBootstrapLimiter });
    for (let i = 0; i < 5; i += 1) {
      await request(app).post("/x").set("X-Forwarded-For", "203.0.113.20");
    }
    const blocked = await request(app)
      .post("/x")
      .set("X-Forwarded-For", "203.0.113.20");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("Too many onboarding attempts");
  });
});
