// @vitest-environment node
//
// TopBlockersWidget (BL-023 / P8.c) — pure projector tests.
//
// The widget itself reads from two react-query hooks and renders shadcn Cards;
// rendering it requires a QueryClient + Router harness. We export the pure
// `buildBlockerItems` projector and unit-test that — it's where the actual
// behaviour lives (filter by status, ordering, click-through href shape).

import { describe, expect, it } from "vitest";
import type { Agent, Approval } from "@founderos/shared";
import { buildBlockerItems } from "./TopBlockersWidget";

function makeApproval(overrides: Partial<Approval>): Approval {
  return {
    id: "appr-1",
    companyId: "co-1",
    type: "request_board_approval",
    requestedByAgentId: "agt-1",
    requestedByUserId: null,
    status: "pending",
    payload: {},
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-05-11T10:00:00Z"),
    updatedAt: new Date("2026-05-11T10:00:00Z"),
    ...overrides,
  };
}

function makeAgent(overrides: Partial<Agent>): Agent {
  const base: Agent = {
    id: "agt-1",
    companyId: "co-1",
    name: "Test Agent",
    urlKey: "test-agent",
    role: "general",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissionLevel: "observe",
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-05-11T10:00:00Z"),
    updatedAt: new Date("2026-05-11T10:00:00Z"),
  };
  return { ...base, ...overrides };
}

describe("buildBlockerItems", () => {
  it("returns empty array when no approvals and no errored agents", () => {
    expect(buildBlockerItems([], [])).toEqual([]);
  });

  it("handles undefined inputs (initial query state)", () => {
    expect(buildBlockerItems(undefined, undefined)).toEqual([]);
  });

  it("emits one item per pending approval", () => {
    const approvals = [
      makeApproval({ id: "a-1", payload: { title: "Approve frog reply" } }),
      makeApproval({ id: "a-2", payload: { title: "Approve thinkboi reply" } }),
    ];
    const items = buildBlockerItems(approvals, []);
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toBe("Approve frog reply");
    expect(items[0]?.kind).toBe("approval");
    expect(items[0]?.href).toBe("/approvals/a-1");
    expect(items[0]?.reason).toMatch(/decision/i);
  });

  it("skips approvals that are not in `pending` status", () => {
    const approvals = [
      makeApproval({ id: "a-1", status: "approved" }),
      makeApproval({ id: "a-2", status: "rejected" }),
      makeApproval({ id: "a-3", status: "pending" }),
    ];
    const items = buildBlockerItems(approvals, []);
    expect(items).toHaveLength(1);
    expect(items[0]?.key).toBe("approval:a-3");
  });

  it("falls back to a humanized type name when payload.title is missing", () => {
    const approvals = [
      makeApproval({ id: "a-1", type: "request_board_approval", payload: {} }),
    ];
    const items = buildBlockerItems(approvals, []);
    // "request_board_approval" → "Request Board Approval"
    expect(items[0]?.title).toMatch(/Request Board Approval/i);
  });

  it("emits one item per errored agent", () => {
    const agents = [
      makeAgent({ id: "a-1", name: "CoS", status: "error" }),
      makeAgent({ id: "a-2", name: "Growth", status: "error" }),
    ];
    const items = buildBlockerItems([], agents);
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toBe("CoS");
    expect(items[0]?.kind).toBe("agent_error");
    expect(items[0]?.reason).toMatch(/stuck/i);
  });

  it("skips agents that are not in `error` status", () => {
    const agents = [
      makeAgent({ id: "a-1", status: "active" }),
      makeAgent({ id: "a-2", status: "paused" }),
      makeAgent({ id: "a-3", status: "running" }),
      makeAgent({ id: "a-4", status: "error" }),
      makeAgent({ id: "a-5", status: "pending_approval" }),
    ];
    const items = buildBlockerItems([], agents);
    expect(items).toHaveLength(1);
    expect(items[0]?.key).toBe("agent:a-4");
  });

  it("uses agent.urlKey for the click-through href when present", () => {
    const agents = [
      makeAgent({ id: "a-1", urlKey: "cos", status: "error" }),
    ];
    const items = buildBlockerItems([], agents);
    expect(items[0]?.href).toBe("/agents/cos");
  });

  it("falls back to agent.id when urlKey is missing (defensive)", () => {
    // The type guarantees urlKey: string, but the component uses
    // `agent.urlKey ?? agent.id` defensively. Simulate the runtime case
    // where an upstream API stub or legacy row writes nullish urlKey.
    const agents = [
      makeAgent({ id: "a-1", status: "error" } as Partial<Agent>),
    ];
    // Coerce urlKey to undefined post-construction so we exercise the
    // nullish-coalescing branch without violating the public type.
    (agents[0] as unknown as { urlKey: string | undefined }).urlKey = undefined;
    const items = buildBlockerItems([], agents);
    expect(items[0]?.href).toBe("/agents/a-1");
  });

  it("places approvals before errored agents in the output order", () => {
    const approvals = [makeApproval({ id: "a-1", payload: { title: "T" } })];
    const agents = [makeAgent({ id: "g-1", name: "Bot", status: "error" })];
    const items = buildBlockerItems(approvals, agents);
    expect(items[0]?.kind).toBe("approval");
    expect(items[1]?.kind).toBe("agent_error");
  });

  it("produces stable, unique keys across both sources", () => {
    const approvals = [
      makeApproval({ id: "shared", payload: { title: "Approval" } }),
    ];
    const agents = [makeAgent({ id: "shared", name: "Agent", status: "error" })];
    const items = buildBlockerItems(approvals, agents);
    const keys = items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
