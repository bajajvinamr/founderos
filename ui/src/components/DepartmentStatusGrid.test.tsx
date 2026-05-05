// @vitest-environment node

import { describe, expect, it } from "vitest";
import { computeDepartmentRollup } from "./DepartmentStatusGrid";
import type { Agent, Approval } from "@founderos/shared";

function makeAgent(over: Partial<Agent> = {}): Agent {
  return {
    id: "a1",
    companyId: "c1",
    name: "Alex",
    urlKey: "alex",
    role: "ceo",
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
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function makeApproval(over: Partial<Approval> = {}): Approval {
  return {
    id: "ap1",
    companyId: "c1",
    type: "approve_ceo_strategy",
    title: "test",
    rationale: "",
    payload: {},
    status: "pending",
    requestedByAgentId: "a1",
    decidedByUserId: null,
    decidedAt: null,
    revisionNotes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as Approval;
}

describe("computeDepartmentRollup", () => {
  it("returns grey for an unstaffed department", () => {
    const r = computeDepartmentRollup("growth", [], []);
    expect(r.health).toBe("grey");
    expect(r.agentCount).toBe(0);
    expect(r.unresolvedApprovals).toBe(0);
  });

  it("returns red when any agent is in error status", () => {
    const ceo = makeAgent({ id: "ceo1", role: "ceo", status: "error", lastHeartbeatAt: new Date() });
    const r = computeDepartmentRollup("chief-of-staff", [ceo], []);
    expect(r.health).toBe("red");
    expect(r.agentCount).toBe(1);
  });

  it("returns red when unresolvedApprovals > 5 even with healthy agents", () => {
    const ceo = makeAgent({ id: "ceo1", role: "ceo", status: "active", lastHeartbeatAt: new Date() });
    const approvals: Approval[] = Array.from({ length: 6 }, (_, i) =>
      makeApproval({ id: `ap${i}`, requestedByAgentId: "ceo1" }),
    );
    const r = computeDepartmentRollup("chief-of-staff", [ceo], approvals);
    expect(r.health).toBe("red");
    expect(r.unresolvedApprovals).toBe(6);
  });

  it("returns yellow when last activity is stale (>24h)", () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const ceo = makeAgent({ id: "ceo1", role: "ceo", status: "active", lastHeartbeatAt: stale });
    const r = computeDepartmentRollup("chief-of-staff", [ceo], []);
    expect(r.health).toBe("yellow");
  });

  it("returns yellow when no heartbeat ever recorded", () => {
    const ceo = makeAgent({ id: "ceo1", role: "ceo", status: "active", lastHeartbeatAt: null });
    const r = computeDepartmentRollup("chief-of-staff", [ceo], []);
    expect(r.health).toBe("yellow");
  });

  it("returns green when fresh activity + no errors + < 5 approvals", () => {
    const ceo = makeAgent({
      id: "ceo1",
      role: "ceo",
      status: "active",
      lastHeartbeatAt: new Date(),
    });
    const approval = makeApproval({ requestedByAgentId: "ceo1" });
    const r = computeDepartmentRollup("chief-of-staff", [ceo], [approval]);
    expect(r.health).toBe("green");
    expect(r.unresolvedApprovals).toBe(1);
  });

  it("only counts approvals from agents in the department", () => {
    const ceo = makeAgent({ id: "ceo1", role: "ceo", lastHeartbeatAt: new Date() });
    const cmo = makeAgent({ id: "cmo1", role: "cmo", lastHeartbeatAt: new Date() });
    const cosApproval = makeApproval({ id: "ap-cos", requestedByAgentId: "ceo1" });
    const growthApproval = makeApproval({ id: "ap-growth", requestedByAgentId: "cmo1" });

    const cosRollup = computeDepartmentRollup(
      "chief-of-staff",
      [ceo, cmo],
      [cosApproval, growthApproval],
    );
    expect(cosRollup.unresolvedApprovals).toBe(1);

    const growthRollup = computeDepartmentRollup(
      "growth",
      [ceo, cmo],
      [cosApproval, growthApproval],
    );
    expect(growthRollup.unresolvedApprovals).toBe(1);
  });

  it("picks the most recent heartbeat across multiple agents in the dept", () => {
    const older = new Date(Date.now() - 5 * 60 * 60 * 1000);
    const newer = new Date(Date.now() - 1 * 60 * 60 * 1000);
    const eng1 = makeAgent({ id: "e1", role: "engineer", lastHeartbeatAt: older });
    const eng2 = makeAgent({ id: "e2", role: "engineer", lastHeartbeatAt: newer });
    const r = computeDepartmentRollup("engineering", [eng1, eng2], []);
    expect(r.lastActivityAt?.getTime()).toBe(newer.getTime());
    expect(r.health).toBe("green");
  });

  it("ignores approvals with null requestedByAgentId", () => {
    const ceo = makeAgent({ id: "ceo1", role: "ceo", lastHeartbeatAt: new Date() });
    const orphanApproval = makeApproval({ id: "ap-orphan", requestedByAgentId: null });
    const r = computeDepartmentRollup("chief-of-staff", [ceo], [orphanApproval]);
    expect(r.unresolvedApprovals).toBe(0);
    expect(r.health).toBe("green");
  });
});
