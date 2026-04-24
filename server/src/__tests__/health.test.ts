import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@founderos/db";
import { serverVersion } from "../version.js";
import { healthRoutes } from "../routes/health.js";

// Mock dev-server-status at module level. The previous implementation used
// `vi.resetModules()` + dynamic `await import()` in every test, which caused
// flakes under parallel fork execution (module cache races). Static import
// + hoisted mock fully isolates this file's module graph.
vi.mock("../dev-server-status.js", () => ({
  readPersistedDevServerStatus: () => undefined,
  toDevServerHealthStatus: () => undefined,
}));

describe("GET /health", () => {
  it("returns 200 with status ok when no db is provided", async () => {
    const app = express();
    app.use("/health", healthRoutes());

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", version: serverVersion });
  });

  it("returns 200 when the database probe succeeds", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    } as unknown as Db;
    const app = express();
    app.use("/health", healthRoutes(db));

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", version: serverVersion });
  });

  it("returns 503 when the database probe fails", async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as Db;
    const app = express();
    app.use("/health", healthRoutes(db));

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "unhealthy",
      version: serverVersion,
      error: "database_unreachable",
    });
  });
});
