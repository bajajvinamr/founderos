import type { Agent } from "@founderos/shared";
import { describe, expect, it } from "vitest";
import { formatActivityVerb, formatIssueActivityAction } from "./activity-format";

describe("activity formatting", () => {
  const agentMap = new Map<string, Agent>([
    ["agent-reviewer", { id: "agent-reviewer", name: "Reviewer Bot" } as Agent],
    ["agent-approver", { id: "agent-approver", name: "Approver Bot" } as Agent],
  ]);

  it("formats blocker activity using linked issue identifiers", () => {
    const details = {
      addedBlockedByIssues: [
        { id: "issue-2", identifier: "PAP-22", title: "Blocked task" },
      ],
      removedBlockedByIssues: [],
    };

    expect(formatActivityVerb("issue.blockers_updated", details)).toBe("added blocker PAP-22 to");
    expect(formatIssueActivityAction("issue.blockers_updated", details)).toBe("added blocker PAP-22");
  });

  it("formats reviewer activity using agent names", () => {
    const details = {
      addedParticipants: [
        { type: "agent", agentId: "agent-reviewer", userId: null },
      ],
      removedParticipants: [],
    };

    expect(formatActivityVerb("issue.reviewers_updated", details, { agentMap })).toBe("added reviewer Reviewer Bot to");
    expect(formatIssueActivityAction("issue.reviewers_updated", details, { agentMap })).toBe("added reviewer Reviewer Bot");
  });

  it("formats approver removals using user-aware labels", () => {
    const details = {
      addedParticipants: [],
      removedParticipants: [
        { type: "user", agentId: null, userId: "local-board" },
      ],
    };

    expect(formatActivityVerb("issue.approvers_updated", details)).toBe("removed approver Board from");
    expect(formatIssueActivityAction("issue.approvers_updated", details)).toBe("removed approver Board");
  });

  it("falls back to updated wording when reviewers are both added and removed", () => {
    const details = {
      addedParticipants: [
        { type: "agent", agentId: "agent-reviewer", userId: null },
      ],
      removedParticipants: [
        { type: "agent", agentId: "agent-approver", userId: null },
      ],
    };

    expect(formatActivityVerb("issue.reviewers_updated", details, { agentMap })).toBe("updated reviewers on");
    expect(formatIssueActivityAction("issue.reviewers_updated", details, { agentMap })).toBe("updated reviewers");
  });

  // ──────────────────────────────────────────────────────────────────
  // Cycle-6 (2026-05-07) audit actions added to activity_log:
  //   - magic_link.issued / magic_link.consumed   (PR-6a, PR #59)
  //   - agent.deleted                             (PR-6b, PR #60 — audit
  //                                                already existed but
  //                                                no row-verb mapping)
  //   - billing.gate_blocked                      (PR-6c, PR #63)
  //
  // Without verb mappings these render as raw "magic link issued" text
  // via the `action.replace(/[._]/g, " ")` fallback. The tests below
  // pin the human-readable phrasing so the buyer-visible activity feed
  // tells the founder what actually happened.
  // ──────────────────────────────────────────────────────────────────

  describe("Cycle-6 audit actions (DB-layer rows from PR-6 split)", () => {
    it("renders magic_link.issued as a human-readable verb", () => {
      // The row entity is the magic_link itself; the activity row reads
      // as "Board issued a magic link for <target>" where the target is
      // surfaced separately by the row component. The verb just owns
      // the action vocabulary.
      expect(formatActivityVerb("magic_link.issued")).toBe("issued a magic link for");
    });

    it("renders magic_link.consumed as a human-readable verb", () => {
      // Distinct from "issued" — this row is the founder/agent claiming
      // the link, which is the security-relevant moment (the auth jump).
      expect(formatActivityVerb("magic_link.consumed")).toBe("claimed a magic link for");
    });

    it("renders agent.deleted as a human-readable verb (not raw text)", () => {
      // PR-6b regression-pinned the audit row but never landed a verb.
      // Without this, the timeline row reads "agent deleted" — fine but
      // inconsistent with sibling lifecycle verbs ("put on leave",
      // "let go of", "brought back").
      expect(formatActivityVerb("agent.deleted")).toBe("removed");
    });

    it("renders billing.gate_blocked as a human-readable verb", () => {
      // The 402 audit. The entity is the agent being woken when the
      // sub was inactive; the verb makes it clear this was a gate
      // refusal, not a normal action. Founders/operators reading this
      // in the activity feed should immediately understand "subscription
      // blocked the wakeup" without needing to interpret the raw action.
      expect(formatActivityVerb("billing.gate_blocked")).toBe("blocked a billing-gated request on");
    });

    it("falls through to the raw replacement for unknown actions (no regression)", () => {
      // Pinning the fallback contract: unmapped actions still render
      // (just with underscores → spaces). This guards against an
      // accidental "throw on unknown action" refactor that would
      // bring down the entire activity feed when a new server-side
      // action ships.
      expect(formatActivityVerb("future.unknown_action")).toBe("future unknown action");
    });
  });
});
