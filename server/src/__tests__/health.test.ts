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

  // Council 2026-05-05 P3 — unauth callers must not receive recon-heavy fields.
  // Verifies the bifurcation in routes/health.ts when req.actor.type === "none".
  describe("unauth response shape (council 2026-05-05 P3)", () => {
    it("omits deploymentExposure, features, and devServer for unauth callers", async () => {
      const db = {
        execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
        select: vi.fn(),
      } as unknown as Db;
      const app = express();
      // No actor middleware → req.actor undefined → treated as unauth.
      app.use(
        "/health",
        healthRoutes(db, {
          deploymentMode: "local_trusted",
          deploymentExposure: "public",
          authReady: true,
          companyDeletionEnabled: true,
        }),
      );

      const res = await request(app).get("/health");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "ok", version: serverVersion });
      expect(res.body).not.toHaveProperty("deploymentExposure");
      expect(res.body).not.toHaveProperty("features");
      expect(res.body).not.toHaveProperty("devServer");
      // UI-load-bearing fields kept for the unauth onboarding flow:
      expect(res.body).toHaveProperty("deploymentMode");
      expect(res.body).toHaveProperty("authReady");
    });

    it("returns full payload for authenticated callers", async () => {
      const db = {
        execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
        select: vi.fn(),
      } as unknown as Db;
      const app = express();
      // Inject a board actor before mounting the route.
      app.use((req, _res, next) => {
        (req as unknown as { actor: { type: string; userId: string } }).actor = {
          type: "board",
          userId: "test-user",
        };
        next();
      });
      app.use(
        "/health",
        healthRoutes(db, {
          deploymentMode: "local_trusted",
          deploymentExposure: "public",
          authReady: true,
          companyDeletionEnabled: true,
        }),
      );

      const res = await request(app).get("/health");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: "ok",
        version: serverVersion,
        deploymentMode: "local_trusted",
        deploymentExposure: "public",
        authReady: true,
        features: { companyDeletionEnabled: true },
      });
    });
  });
});
