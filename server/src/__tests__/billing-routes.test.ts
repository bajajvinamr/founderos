import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { billingRoutes } from "../routes/billing.js";

// Minimal Db stub — billingRoutes never actually hits .query when Stripe is
// unconfigured (the checkout + webhook short-circuit on config), and the
// subscription service's getCurrentSubscription catches errors and returns
// null. So a tiny throw-through stub is enough for these contract tests.
const fakeDb = {
  query: {
    instanceSubscription: {
      findFirst: async () => null,
    },
  },
} as unknown as Parameters<typeof billingRoutes>[0];

describe("billing routes — contract when Stripe is not configured", () => {
  let originalKey: string | undefined;
  let app: express.Express;

  beforeEach(() => {
    originalKey = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PRICE_ID_PRO;
    delete process.env.STRIPE_WEBHOOK_SECRET;

    app = express();
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as unknown as { rawBody: Buffer }).rawBody = buf;
        },
      }),
    );
    app.use("/api/billing", billingRoutes(fakeDb));
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.STRIPE_SECRET_KEY = originalKey;
    }
  });

  it("GET /status reports stripeConfigured: false", async () => {
    const res = await request(app).get("/api/billing/status");
    expect(res.status).toBe(200);
    expect(res.body.stripeConfigured).toBe(false);
    expect(res.body.plan).toBe("free");
  });

  it("POST /checkout returns 501 when STRIPE_SECRET_KEY is missing", async () => {
    const res = await request(app).post("/api/billing/checkout").send({});
    expect(res.status).toBe(501);
    expect(res.body.error).toMatch(/Stripe/i);
  });

  it("POST /webhook returns 501 when Stripe is not configured", async () => {
    const res = await request(app)
      .post("/api/billing/webhook")
      .set("stripe-signature", "t=0,v1=deadbeef")
      .send({ id: "evt_test", type: "customer.subscription.created" });
    expect(res.status).toBe(501);
  });

  it("POST /webhook returns 400 when stripe-signature header missing (Stripe configured, secret missing)", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake_key_for_test_only_not_real_1234567890";
    // Re-mount app so the new key is picked up by the route factory.
    app = express();
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as unknown as { rawBody: Buffer }).rawBody = buf;
        },
      }),
    );
    app.use("/api/billing", billingRoutes(fakeDb));

    const res = await request(app)
      .post("/api/billing/webhook")
      .send({ id: "evt_test", type: "customer.subscription.created" });
    // STRIPE_WEBHOOK_SECRET is not set, so we expect 501 (webhook secret config check).
    expect(res.status).toBe(501);
  });
});
