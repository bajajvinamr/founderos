/**
 * P0.6 — Tests for companies-export route + redactSecrets walker.
 *
 * Two test surfaces:
 *   1. redactSecrets() unit tests — adversarial inputs (nested objects,
 *      arrays of objects, exact-name match vs substring, depth limit).
 *      These are the load-bearing tests: secret leakage in the export
 *      is the worst possible outcome.
 *   2. Route integration tests — end-to-end via supertest with an
 *      embedded-postgres DB. Seeds a company with goals + integrations
 *      that have an `api_key` field, asserts the exported JSON contains
 *      goals, asserts the api_key is redacted, asserts cross-tenant
 *      access returns 404 (anti-enumeration).
 */

import express from "express";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  companies,
  companyMemory,
  createDb,
  goals,
  integrations,
  projects,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  REDACTED_FIELDS,
  companiesExportRoutes,
  redactSecrets,
} from "../routes/companies-export.js";
import { errorHandler } from "../middleware/index.js";

// ---------------------------------------------------------------------------
// 1. redactSecrets() — unit tests on adversarial inputs (no DB needed).
// ---------------------------------------------------------------------------

describe("redactSecrets — exact field-name match", () => {
  it("redacts every name in REDACTED_FIELDS at the top level", () => {
    const input: Record<string, string> = {};
    for (const field of REDACTED_FIELDS) input[field] = "real-secret-value";
    const out = redactSecrets(input);
    for (const field of REDACTED_FIELDS) {
      expect(out[field]).toBe("[REDACTED]");
    }
  });

  it("does NOT redact substring-matching names — 'secret' is the exact key, 'secrets' is not", () => {
    const out = redactSecrets({
      secret: "redact-me",
      secrets: "keep-me",
      mysecret: "keep-me-too",
      publicSecret: "still-keep",
    });
    expect(out.secret).toBe("[REDACTED]");
    expect(out.secrets).toBe("keep-me");
    expect(out.mysecret).toBe("keep-me-too");
    expect(out.publicSecret).toBe("still-keep");
  });

  it("redacts case-sensitively — 'API_KEY' (uppercase) is NOT in the set", () => {
    const out = redactSecrets({
      api_key: "redact-me",
      API_KEY: "uppercase-not-in-set",
    });
    expect(out.api_key).toBe("[REDACTED]");
    // Documented: REDACTED_FIELDS is exact-match, case-sensitive. If a
    // codebase introduces an uppercase column we'd add it explicitly.
    expect(out.API_KEY).toBe("uppercase-not-in-set");
  });
});

describe("redactSecrets — recursion through containers", () => {
  it("redacts inside nested objects", () => {
    const out = redactSecrets({
      integration: {
        kind: "slack",
        api_key: "real-key",
        config: { channel: "general", token: "real-token" },
      },
    });
    expect(out.integration.api_key).toBe("[REDACTED]");
    expect(out.integration.config.token).toBe("[REDACTED]");
    expect(out.integration.config.channel).toBe("general");
  });

  it("redacts inside arrays of objects", () => {
    const out = redactSecrets({
      integrations: [
        { kind: "slack", api_key: "k1" },
        { kind: "github", access_token: "k2" },
        { kind: "notion", credentials: "k3" },
      ],
    });
    expect(out.integrations[0].api_key).toBe("[REDACTED]");
    expect(out.integrations[1].access_token).toBe("[REDACTED]");
    expect(out.integrations[2].credentials).toBe("[REDACTED]");
    expect(out.integrations[0].kind).toBe("slack");
  });

  it("preserves Date values without recursing into Date internals", () => {
    const date = new Date("2026-05-10T00:00:00.000Z");
    const out = redactSecrets({ createdAt: date, secret: "x" });
    expect(out.createdAt).toBe(date);
    expect(out.secret).toBe("[REDACTED]");
  });

  it("passes primitives + null + undefined through unchanged", () => {
    expect(redactSecrets("plain")).toBe("plain");
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeUndefined();
    expect(redactSecrets(true)).toBe(true);
  });

  it("does not mutate the input object", () => {
    const input = { api_key: "real" };
    const out = redactSecrets(input);
    expect(input.api_key).toBe("real");
    expect(out.api_key).toBe("[REDACTED]");
  });
});

describe("redactSecrets — depth limit", () => {
  it("stops at depth 10 to prevent stack overflow on cyclic refs", () => {
    // Build a 12-deep nest with a secret at the bottom.
    let inner: Record<string, unknown> = { api_key: "leaks-if-deep" };
    for (let i = 0; i < 11; i++) {
      inner = { wrap: inner };
    }
    // Should not throw, even with the cyclic-ish depth; the deepest
    // levels pass through verbatim instead of being walked.
    expect(() => redactSecrets(inner)).not.toThrow();
  });

  it("redacts up through and including the depth boundary", () => {
    // Secret at depth 0 + depth 5 are both inside the limit and get redacted.
    const out = redactSecrets({
      api_key: "lvl0",
      a: { b: { c: { d: { e: { api_key: "lvl5" } } } } },
    });
    expect(out.api_key).toBe("[REDACTED]");
    expect(out.a.b.c.d.e.api_key).toBe("[REDACTED]");
  });
});

describe("redactSecrets — never returns a real value for known field names", () => {
  it("safety net: scan a synthetic 'export payload' shape and assert no api_key value survives", () => {
    const synthetic = {
      schemaVersion: "v1",
      data: {
        company: { name: "Acme", api_key: "should-not-survive" },
        agents: [
          {
            name: "ceo",
            adapterConfig: { provider: "anthropic", apiKey: "should-not-survive" },
          },
        ],
        integrations: [
          { kind: "slack", api_key: "should-not-survive", encrypted_api_key: "should-not-survive" },
        ],
      },
    };
    const out = redactSecrets(synthetic);
    const json = JSON.stringify(out);
    expect(json).not.toContain("should-not-survive");
    expect(out.data.company.api_key).toBe("[REDACTED]");
    expect(out.data.agents[0].adapterConfig.apiKey).toBe("[REDACTED]");
    expect(out.data.integrations[0].api_key).toBe("[REDACTED]");
    expect(out.data.integrations[0].encrypted_api_key).toBe("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// 2. Route integration tests — end-to-end via embedded postgres.
// ---------------------------------------------------------------------------

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(`Skipping companies-export route tests: ${support.reason ?? "unsupported"}`);
}

function buildApp(
  db: ReturnType<typeof createDb>,
  actorOverrides: Record<string, unknown> = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Record<string, unknown>).actor = {
      type: "board",
      userId: "00000000-0000-0000-0000-000000000001",
      companyIds: ["__placeholder__"],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/companies", companiesExportRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("GET /api/companies/:companyId/export (P0.6)", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyA: string;
  let companyB: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("companies_export");
    db = createDb(testDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    // Order matters — child tables before parents.
    await db.execute(sql`TRUNCATE TABLE "company_memory" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "integrations" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "goals" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "projects" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "agents" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);

    const ts = Date.now();
    const [a] = await db
      .insert(companies)
      .values({ name: "Acme Inc", issuePrefix: `EXP${ts}A` })
      .returning({ id: companies.id });
    const [b] = await db
      .insert(companies)
      .values({ name: "Other Corp", issuePrefix: `EXP${ts}B` })
      .returning({ id: companies.id });
    companyA = a.id;
    companyB = b.id;

    // Seed companyA with a goal and an integration carrying a secret-
    // shaped field via the `config` column (which ought to be excluded
    // by the select, but we additionally test the redactor).
    await db.insert(goals).values({
      companyId: companyA,
      title: "Ship MVP",
      description: "First customer in 90 days",
    });

    await db.insert(integrations).values({
      companyId: companyA,
      kind: "slack",
      status: "connected",
      keyHint: "abcd",
      // encryptedApiKey is set on the row but should never appear in
      // the export response (column is excluded from select + walker
      // would redact it anyway).
      encryptedApiKey: "ENCRYPTED-PAYLOAD-SHOULD-NEVER-LEAK",
      config: { workspaceId: "T123" },
    });

    // Seed companyB with a goal that should NOT appear in companyA's export.
    await db.insert(goals).values({
      companyId: companyB,
      title: "Other company secret goal",
    });
  });

  it("exports companyA's goals and integrations as JSON with download headers", async () => {
    const app = buildApp(db, { companyIds: [companyA] });
    const res = await request(app).get(`/companies/${companyA}/export`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="founderos-export-acme-inc-\d{4}-\d{2}-\d{2}\.json"$/);

    const payload = JSON.parse(res.text);
    expect(payload.schemaVersion).toBe("v1");
    expect(payload.companyId).toBe(companyA);
    expect(payload.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(payload.data.company.name).toBe("Acme Inc");
    expect(payload.data.goals).toHaveLength(1);
    expect(payload.data.goals[0].title).toBe("Ship MVP");
    expect(payload.data.integrations).toHaveLength(1);
    expect(payload.data.integrations[0].kind).toBe("slack");

    // Tenant isolation: companyB's goal must NOT appear.
    const goalTitles = payload.data.goals.map((g: { title: string }) => g.title);
    expect(goalTitles).not.toContain("Other company secret goal");
  });

  it("never includes the encrypted_api_key value (column excluded + walker backs it up)", async () => {
    const app = buildApp(db, { companyIds: [companyA] });
    const res = await request(app).get(`/companies/${companyA}/export`);

    expect(res.status).toBe(200);
    // The hard property: the actual ciphertext must never be in the
    // response body, and the field name (if it appears) must show
    // "[REDACTED]" rather than the real value.
    expect(res.text).not.toContain("ENCRYPTED-PAYLOAD-SHOULD-NEVER-LEAK");
    const payload = JSON.parse(res.text);
    const integration = payload.data.integrations[0];
    if ("encryptedApiKey" in integration || "encrypted_api_key" in integration) {
      const v = integration.encryptedApiKey ?? integration.encrypted_api_key;
      expect(v).toBe("[REDACTED]");
    }
  });

  it("cross-tenant access returns 404 (anti-enumeration), not 403", async () => {
    const app = buildApp(db, { companyIds: [companyA] });
    // Attempt to download companyB's data as a user only in companyA.
    const res = await request(app).get(`/companies/${companyB}/export`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Company not found");
  });

  it("instance admin can export any company", async () => {
    const app = buildApp(db, { companyIds: [], isInstanceAdmin: true });
    const res = await request(app).get(`/companies/${companyA}/export`);
    expect(res.status).toBe(200);
    const payload = JSON.parse(res.text);
    expect(payload.data.company.name).toBe("Acme Inc");
  });

  it("returns 404 when the companyId does not resolve to any row", async () => {
    const fakeUuid = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const app = buildApp(db, { companyIds: [fakeUuid], isInstanceAdmin: true });
    const res = await request(app).get(`/companies/${fakeUuid}/export`);
    expect(res.status).toBe(404);
  });

  it("returns 401 when no actor identity is present", async () => {
    const app = buildApp(db, { type: "none" });
    const res = await request(app).get(`/companies/${companyA}/export`);
    expect(res.status).toBe(401);
  });

  it("includes companyMemory + agents + projects keys even when empty", async () => {
    const app = buildApp(db, { companyIds: [companyA] });
    const res = await request(app).get(`/companies/${companyA}/export`);
    expect(res.status).toBe(200);
    const payload = JSON.parse(res.text);
    // All sections are always present so consumers can rely on the
    // shape — empty array vs missing key matters for re-import paths.
    expect(payload.data.companyMemory).toEqual([]);
    expect(payload.data.agents).toEqual([]);
    expect(payload.data.projects).toEqual([]);
    expect(payload.data.agentRuns).toEqual([]);
    expect(payload.data.notifications).toEqual([]);
  });
});
