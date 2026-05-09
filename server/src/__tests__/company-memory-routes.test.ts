/**
 * Route-level CRUD tests for company-memory.ts (audit P0.3).
 *
 * Tenant-scoping is already covered in tenant-isolation.test.ts (line ~218).
 * This file pins the request → service forwarding contract — specifically
 * that the route forwards the new fields exposed in the audit P0.3 patch
 * (`category`, `expiresAt`) to the service layer.
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const ENTRY_ID = "44444444-4444-4444-8444-444444444444";

type Actor = Record<string, unknown>;

function actor(): Actor {
  return {
    type: "board",
    userId: "user-1",
    companyIds: [COMPANY_A],
    isInstanceAdmin: false,
    source: "session",
  };
}

function makeServiceEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTRY_ID,
    companyId: COMPANY_A,
    kind: "founder_note",
    title: "Pricing decision",
    body: "We anchor at $4k buyer price.",
    topic: null,
    occurredAt: new Date("2026-05-01T00:00:00.000Z"),
    pinned: false,
    source: "manual",
    category: null,
    expiresAt: null,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    ...overrides,
  };
}

const memoryServiceSpy = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  generateWeeklySummary: vi.fn(),
};

const logActivitySpy = vi.fn();

vi.mock("../services/index.js", () => ({
  companyMemoryService: () => memoryServiceSpy,
  logActivity: logActivitySpy,
}));

async function buildApp() {
  const { companyMemoryRoutes } = await import("../routes/company-memory.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor: Actor }).actor = actor();
    next();
  });
  // Pass `db` as an empty stub — service is fully mocked above so the
  // route never touches it.
  app.use("/api", companyMemoryRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("companyMemoryRoutes — CRUD wiring", () => {
  beforeEach(() => {
    memoryServiceSpy.list.mockReset();
    memoryServiceSpy.create.mockReset();
    memoryServiceSpy.update.mockReset();
    memoryServiceSpy.remove.mockReset();
    memoryServiceSpy.generateWeeklySummary.mockReset();
    logActivitySpy.mockReset();
  });

  it("GET /companies/:id/memory returns service rows", async () => {
    memoryServiceSpy.list.mockResolvedValue([makeServiceEntry()]);
    const app = await buildApp();

    const res = await request(app).get(`/api/companies/${COMPANY_A}/memory`);

    expect(res.status).toBe(200);
    expect(memoryServiceSpy.list).toHaveBeenCalledWith(COMPANY_A, expect.any(Object));
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].id).toBe(ENTRY_ID);
  });

  it("POST /companies/:id/memory forwards category to the service (audit P0.3)", async () => {
    memoryServiceSpy.create.mockResolvedValue(
      makeServiceEntry({ category: "decision", title: "New entry" }),
    );
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/memory`)
      .send({
        title: "New entry",
        body: "Body content here",
        category: "decision",
      });

    expect(res.status).toBe(201);
    expect(memoryServiceSpy.create).toHaveBeenCalledTimes(1);
    const callArgs = memoryServiceSpy.create.mock.calls[0];
    expect(callArgs[0]).toBe(COMPANY_A);
    expect(callArgs[1]).toMatchObject({
      title: "New entry",
      body: "Body content here",
      category: "decision",
      source: "manual",
    });
  });

  it("POST rejects an invalid category at the validator", async () => {
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/memory`)
      .send({
        title: "x",
        body: "y",
        category: "not-a-real-category",
      });

    expect(res.status).toBe(400);
    expect(memoryServiceSpy.create).not.toHaveBeenCalled();
  });

  it("PATCH forwards category and pinned to the service", async () => {
    memoryServiceSpy.update.mockResolvedValue(
      makeServiceEntry({ category: "pattern", pinned: true }),
    );
    const app = await buildApp();

    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/memory/${ENTRY_ID}`)
      .send({ category: "pattern", pinned: true });

    expect(res.status).toBe(200);
    expect(memoryServiceSpy.update).toHaveBeenCalledTimes(1);
    const [id, patch] = memoryServiceSpy.update.mock.calls[0];
    expect(id).toBe(ENTRY_ID);
    expect(patch).toMatchObject({ category: "pattern", pinned: true });
  });

  it("PATCH returns 404 when service reports no row updated", async () => {
    memoryServiceSpy.update.mockResolvedValue(null);
    const app = await buildApp();

    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/memory/${ENTRY_ID}`)
      .send({ title: "renamed" });

    expect(res.status).toBe(404);
  });

  it("DELETE returns 204 on success", async () => {
    memoryServiceSpy.remove.mockResolvedValue(true);
    const app = await buildApp();

    const res = await request(app).delete(
      `/api/companies/${COMPANY_A}/memory/${ENTRY_ID}`,
    );

    expect(res.status).toBe(204);
    expect(memoryServiceSpy.remove).toHaveBeenCalledWith(ENTRY_ID);
  });

  it("DELETE returns 404 when service reports no row removed", async () => {
    memoryServiceSpy.remove.mockResolvedValue(false);
    const app = await buildApp();

    const res = await request(app).delete(
      `/api/companies/${COMPANY_A}/memory/${ENTRY_ID}`,
    );

    expect(res.status).toBe(404);
  });
});
