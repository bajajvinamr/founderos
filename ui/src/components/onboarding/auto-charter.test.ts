/**
 * Tests for the deterministic charter generator used by Step 5
 * ("Meet your team") of FounderOS founder onboarding.
 *
 * The wizard runs `buildAutoCharters()` purely client-side; the actual
 * agents run their real prompts server-side on first heartbeat. So this
 * function only needs to:
 *   - always populate every slot (cos / growth / content / finance) with
 *     a non-empty charter + first priority,
 *   - reflect the founder's vision and chosen bottlenecks (so step 5
 *     feels personalised, not boilerplate),
 *   - be deterministic so re-renders don't shuffle copy mid-flow.
 *
 * It does NOT need full text snapshots — the actual agent prompts are
 * server-side and tested independently.
 */
import { describe, expect, it } from "vitest";
import {
  buildAutoCharters,
  buildFirstDecisions,
  listSlots,
} from "./auto-charter";
import type { Bottleneck, TeamShape } from "./onboarding-types";

const VISION_SAMPLE =
  "We are building an AI-native control plane for solo founders.";

describe("buildAutoCharters", () => {
  it("populates all four canonical slots", () => {
    const charters = buildAutoCharters({
      vision: VISION_SAMPLE,
      bottlenecks: ["pmf"],
      team: "solo",
    });
    expect(Object.keys(charters).sort()).toEqual([
      "content",
      "cos",
      "finance",
      "growth",
    ]);
  });

  it("matches the slot order exposed by listSlots()", () => {
    const slots = listSlots();
    const charters = buildAutoCharters({
      vision: VISION_SAMPLE,
      bottlenecks: ["growth"],
      team: "solo",
    });
    for (const slot of slots) {
      expect(charters[slot], `slot ${slot} must be present`).toBeDefined();
      expect(charters[slot].slot).toBe(slot);
    }
  });

  it("returns non-empty charter + firstPriority for every slot", () => {
    const charters = buildAutoCharters({
      vision: VISION_SAMPLE,
      bottlenecks: ["hiring"],
      team: "cofounder",
    });
    for (const slot of listSlots()) {
      expect(
        charters[slot].charter.trim().length,
        `${slot}.charter must be non-empty`,
      ).toBeGreaterThan(0);
      expect(
        charters[slot].firstPriority.trim().length,
        `${slot}.firstPriority must be non-empty`,
      ).toBeGreaterThan(0);
    }
  });

  it("is deterministic — same input produces byte-identical output", () => {
    const input = {
      vision: VISION_SAMPLE,
      bottlenecks: ["pmf", "growth"] as Bottleneck[],
      team: "solo" as TeamShape,
    };
    const a = buildAutoCharters(input);
    const b = buildAutoCharters(input);
    expect(a).toEqual(b);
  });

  it("specialises the growth charter on the chosen bottleneck", () => {
    const pmf = buildAutoCharters({
      vision: VISION_SAMPLE,
      bottlenecks: ["pmf"],
      team: "solo",
    });
    const growth = buildAutoCharters({
      vision: VISION_SAMPLE,
      bottlenecks: ["growth"],
      team: "solo",
    });
    // Different bottleneck → different growth charter copy.
    expect(growth.growth.charter).not.toBe(pmf.growth.charter);
    expect(growth.growth.firstPriority).not.toBe(pmf.growth.firstPriority);
  });

  it("incorporates the founder's vision into the charter copy", () => {
    const distinctiveVision = "We're indexing every public sermon transcript.";
    const charters = buildAutoCharters({
      vision: distinctiveVision,
      bottlenecks: ["growth"],
      team: "solo",
    });
    // CoS charter should reference (a clipped form of) the distinctive
    // vision — that's the whole point of step 5 feeling personalised.
    expect(charters.cos.charter).toContain("public sermon");
  });

  it("falls back gracefully when the vision is empty", () => {
    const charters = buildAutoCharters({
      vision: "",
      bottlenecks: ["pmf"],
      team: "solo",
    });
    for (const slot of listSlots()) {
      expect(charters[slot].charter.length).toBeGreaterThan(0);
    }
  });

  it("changes CoS voicing based on team shape", () => {
    const solo = buildAutoCharters({
      vision: VISION_SAMPLE,
      bottlenecks: ["pmf"],
      team: "solo",
    });
    const team = buildAutoCharters({
      vision: VISION_SAMPLE,
      bottlenecks: ["pmf"],
      team: "small_team",
    });
    expect(solo.cos.charter).not.toBe(team.cos.charter);
  });
});

describe("buildFirstDecisions", () => {
  it("returns three cards for every supported primary bottleneck", () => {
    for (const primary of ["pmf", "growth", "hiring"] as Bottleneck[]) {
      const cards = buildFirstDecisions([primary]);
      expect(
        cards.length,
        `bottleneck ${primary} should produce three first-decision cards`,
      ).toBe(3);
      for (const card of cards) {
        expect(card.id.length).toBeGreaterThan(0);
        expect(card.title.length).toBeGreaterThan(0);
        expect(card.rationale.length).toBeGreaterThan(0);
      }
    }
  });

  it("routes every card to a real agent slot", () => {
    const slots = new Set(listSlots());
    for (const primary of ["pmf", "growth", "hiring"] as Bottleneck[]) {
      for (const card of buildFirstDecisions([primary])) {
        expect(slots.has(card.slot), `card ${card.id} routes to unknown slot`).toBe(true);
      }
    }
  });

  it("returns deterministic cards for the same bottleneck", () => {
    const a = buildFirstDecisions(["pmf"]);
    const b = buildFirstDecisions(["pmf"]);
    expect(a).toEqual(b);
  });

  it("falls back to a default card set when bottleneck is unrecognised", () => {
    // The function should never throw or return empty for arbitrary input —
    // the wizard must always have something to render in step 6.
    const cards = buildFirstDecisions([]);
    expect(cards.length).toBeGreaterThan(0);
  });
});
