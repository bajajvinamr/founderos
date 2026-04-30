import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the plugin registry so the traversal guard is tested in isolation.
// The guard short-circuits before any registry lookup — the mock should never
// be called for traversal requests, but we still need the module present.
const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn().mockResolvedValue(null),
  getByKey: vi.fn().mockResolvedValue(null),
  getConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

async function createApp() {
  const { pluginUiStaticRoutes } = await import("../routes/plugin-ui-static.js");
  const { errorHandler } = await import("../middleware/index.js");
  const app = express();
  app.use(express.json());
  // The route does not check auth — it's guarded upstream in production.
  // For these tests we just need the static-serving logic reachable.
  app.use(pluginUiStaticRoutes({} as any, {}));
  app.use(errorHandler);
  return app;
}

describe("plugin-ui-static — path traversal guard", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("path with encoded .. segments is blocked by Express URL normalization — route doesn't match (404)", async () => {
    // Express 5 normalizes %2e%2e (and literal ..) in URL paths before route
    // matching.  A path like /_plugins/x/ui/%2e%2e/%2e%2e/etc/passwd is
    // resolved to /etc/passwd which does not match any registered route.
    // The resulting 404 IS the security guarantee — the handler is never
    // reached.  The source-level ".." guard is defense-in-depth for exotic
    // injection vectors (e.g., framework upgrades that change wildcard decoding
    // semantics, or params set directly outside normal request flow).
    const app = await createApp();
    const res = await request(app).get(
      "/_plugins/plugin-123/ui/%2e%2e/%2e%2e/etc/passwd",
    );
    expect(res.status).toBe(404);
    // The registry is not consulted — the route never matched.
    expect(mockRegistry.getById).not.toHaveBeenCalled();
  });

  it("returns 400 for a path segment containing a null byte", async () => {
    const app = await createApp();
    // Null bytes are URL-encoded as %00. Express decodes params before the
    // handler runs, so %00 arrives as the literal NUL character.
    const res = await request(app).get(
      "/_plugins/plugin-123/ui/index%00.js",
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "Invalid file path" });
    expect(mockRegistry.getById).not.toHaveBeenCalled();
  });

  it("passes a normal filename through to the registry lookup (no traversal block)", async () => {
    const app = await createApp();
    // "index.js" is a valid segment — the guard should not block it.
    // The registry mock returns null → 404, which is the expected next step.
    const res = await request(app).get(
      "/_plugins/plugin-123/ui/index.js",
    );
    // 404 means the guard passed and we hit the registry lookup.
    expect(res.status).toBe(404);
    expect(mockRegistry.getById).toHaveBeenCalled();
  });

  it("passes a nested path through to the registry lookup", async () => {
    const app = await createApp();
    const res = await request(app).get(
      "/_plugins/plugin-123/ui/assets/chunk-abc123.js",
    );
    expect(res.status).toBe(404);
    expect(mockRegistry.getById).toHaveBeenCalled();
  });
});
