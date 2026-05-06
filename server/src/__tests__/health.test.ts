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

  // Task #139 — /api/health ROOT no longer carries deployment metadata.
  // The fields used to ride on this endpoint behind a unauth/authed branch;
  // they're now split into /api/health/bootstrap-state (public) and
  // /api/health/diagnostics (admin-gated).
  describe("response shape after task #139 split", () => {
    it("returns only {status, version} for unauth callers (no deployment metadata)", async () => {
      const db = {
        execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
        select: vi.fn(),
      } as unknown as Db;
      const app = express();
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
      expect(res.body).toEqual({ status: "ok", version: serverVersion });
      expect(res.body).not.toHaveProperty("deploymentMode");
      expect(res.body).not.toHaveProperty("deploymentExposure");
      expect(res.body).not.toHaveProperty("authReady");
      expect(res.body).not.toHaveProperty("bootstrapStatus");
      expect(res.body).not.toHaveProperty("features");
      expect(res.body).not.toHaveProperty("devServer");
    });

    it("returns the same minimal shape for authenticated callers", async () => {
      const db = {
        execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
        select: vi.fn(),
      } as unknown as Db;
      const app = express();
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
      expect(res.body).toEqual({ status: "ok", version: serverVersion });
    });
  });

  describe("GET /health/bootstrap-state", () => {
    it("returns bootstrap fields for unauth callers (UI consumes pre-signin)", async () => {
      const app = express();
      app.use(
        "/health",
        healthRoutes(undefined, {
          deploymentMode: "local_trusted",
          deploymentExposure: "private",
          authReady: true,
          companyDeletionEnabled: true,
        }),
      );

      const res = await request(app).get("/health/bootstrap-state");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        deploymentMode: "local_trusted",
        authReady: true,
        bootstrapStatus: "ready",
        bootstrapInviteActive: false,
      });
    });

    it("does not leak deploymentExposure or features", async () => {
      const app = express();
      app.use(
        "/health",
        healthRoutes(undefined, {
          deploymentMode: "local_trusted",
          deploymentExposure: "public",
          authReady: true,
          companyDeletionEnabled: true,
        }),
      );

      const res = await request(app).get("/health/bootstrap-state");

      expect(res.body).not.toHaveProperty("deploymentExposure");
      expect(res.body).not.toHaveProperty("features");
      expect(res.body).not.toHaveProperty("devServer");
    });
  });

  describe("GET /health/diagnostics", () => {
    it("requires instance admin (assertInstanceAdmin gate)", async () => {
      // assertInstanceAdmin short-circuits for local_implicit + 'board' actor
      // type when role check passes; without an actor middleware the actor is
      // missing so we expect the gate to refuse. The exact status code here
      // depends on assertInstanceAdmin's throw shape — verify it's NOT 200.
      const app = express();
      app.use(
        "/health",
        healthRoutes(undefined, {
          deploymentMode: "authenticated",
          deploymentExposure: "private",
          authReady: true,
          companyDeletionEnabled: true,
        }),
      );

      const res = await request(app).get("/health/diagnostics");

      // 401 / 403 / 500-with-thrown-HttpError are all acceptable; the only
      // wrong answer is 200 with the diagnostics payload exposed.
      expect(res.status).not.toBe(200);
    });

    it("returns diagnostics payload to local_trusted (local_implicit short-circuits the admin check)", async () => {
      const app = express();
      // Inject a local_implicit actor — assertInstanceAdmin lets this through
      // in local_trusted mode without a real role row.
      app.use((req, _res, next) => {
        (req as unknown as {
          actor: { type: string; userId: string; source: string; isInstanceAdmin: boolean };
        }).actor = {
          type: "board",
          userId: "local-board",
          source: "local_implicit",
          isInstanceAdmin: false,
        };
        next();
      });
      app.use(
        "/health",
        healthRoutes(undefined, {
          deploymentMode: "local_trusted",
          deploymentExposure: "public",
          authReady: true,
          companyDeletionEnabled: true,
        }),
      );

      const res = await request(app).get("/health/diagnostics");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        deploymentExposure: "public",
        features: { companyDeletionEnabled: true },
      });
    });
  });
});
