import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "@founderos/db";
import { draftHireProposal, hireProposalSchema } from "../services/hire-proposal.js";

// Mock the adapter layer so we never touch real LLM in tests
vi.mock("../adapters/index.js", () => ({
  findActiveServerAdapter: vi.fn().mockReturnValue(null),
}));

// ─── DB mock helpers ───────────────────────────────────────────────────────

function makeAgent(overrides: {
  id: string;
  companyId: string;
  name: string;
  role: string;
  title?: string | null;
  adapterType?: string;
  adapterConfig?: Record<string, unknown>;
  status?: string;
}) {
  return {
    id: overrides.id,
    companyId: overrides.companyId,
    name: overrides.name,
    role: overrides.role,
    title: overrides.title ?? null,
    status: overrides.status ?? "active",
    adapterType: overrides.adapterType ?? "claude_local",
    adapterConfig: overrides.adapterConfig ?? {},
  };
}

function makeCompany(id: string, name = "Acme Inc") {
  return {
    id,
    name,
    status: "active",
    metrics: { charter: "Building the best AI company in the world" },
  };
}

function mockDb(agents: ReturnType<typeof makeAgent>[], companyId = "c1"): Db {
  const company = makeCompany(companyId);

  return {
    select: () => ({
      from: (table: unknown) => ({
        where: (_cond: unknown) => {
          // Distinguish companies vs agents table by presence of a name column
          if (agents.some((a) => "role" in a)) {
            // Could be either — check table
          }
          // Return company when queried for companies, agents otherwise
          if (String(table).includes("companies")) {
            return Promise.resolve([company]);
          }
          return Promise.resolve(agents);
        },
      }),
    }),
  } as unknown as Db;
}

/**
 * Simplified mock that lets us distinguish which table is being queried
 * by inspecting the table object's own name property.
 */
function mockDbSmart(agents: ReturnType<typeof makeAgent>[], companyId = "c1"): Db {
  const company = makeCompany(companyId);
  let callCount = 0;

  return {
    select: () => {
      callCount++;
      const isFirst = callCount <= 1; // first select = company, second = agents
      return {
        from: (_table: unknown) => ({
          where: (_cond: unknown) => {
            if (isFirst) {
              return Promise.resolve([company]);
            }
            return Promise.resolve(agents);
          },
        }),
      };
    },
  } as unknown as Db;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("draftHireProposal — fallback path (no LLM)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns Head of Growth proposal when intent contains 'growth'", async () => {
    const ceo = makeAgent({ id: "a-ceo", companyId: "c1", name: "Atlas", role: "ceo" });
    const db = mockDbSmart([ceo]);

    const proposal = await draftHireProposal({
      db,
      companyId: "c1",
      intent: "I need someone to run outbound growth campaigns",
    });

    expect(proposal.role).toBe("cmo");
    expect(proposal.department).toBe("growth");
    expect(proposal.title).toMatch(/growth/i);
    expect(proposal.monthlyCompCents).toBe(20_000);
  });

  it("returns CFO proposal when intent contains 'CFO'", async () => {
    const ceo = makeAgent({ id: "a-ceo", companyId: "c1", name: "Atlas", role: "ceo" });
    const db = mockDbSmart([ceo]);

    const proposal = await draftHireProposal({
      db,
      companyId: "c1",
      intent: "I need a CFO to watch burn and pressure-test pricing",
    });

    expect(proposal.role).toBe("cfo");
    expect(proposal.department).toBe("finance");
  });

  it("returns default Chief of Staff when intent is empty/unknown", async () => {
    const ceo = makeAgent({ id: "a-ceo", companyId: "c1", name: "Atlas", role: "ceo" });
    const db = mockDbSmart([ceo]);

    const proposal = await draftHireProposal({
      db,
      companyId: "c1",
      intent: "someone to help me generally",
    });

    expect(proposal.role).toBe("general");
    expect(proposal.department).toBe("ops");
  });

  it("returned proposal always passes the Zod schema", async () => {
    const ceo = makeAgent({ id: "a-ceo", companyId: "c1", name: "Atlas", role: "ceo" });
    const db = mockDbSmart([ceo]);

    const proposal = await draftHireProposal({
      db,
      companyId: "c1",
      intent: "a designer for our landing page",
    });

    const result = hireProposalSchema.safeParse(proposal);
    expect(result.success).toBe(true);
  });

  it("throws when no CEO teammate exists", async () => {
    const engineer = makeAgent({ id: "a-eng", companyId: "c1", name: "Forge", role: "engineer" });
    const db = mockDbSmart([engineer]);

    await expect(
      draftHireProposal({
        db,
        companyId: "c1",
        intent: "need a growth person",
      }),
    ).rejects.toThrow("CEO teammate must exist");
  });
});
