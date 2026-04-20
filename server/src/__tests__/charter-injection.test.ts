import { describe, expect, it } from "vitest";
import { injectCharterIntoPrompt } from "../services/heartbeat.js";

describe("injectCharterIntoPrompt", () => {
  it("prepends charter inside <company_charter> tag before existing prompt", () => {
    const result = injectCharterIntoPrompt(
      "We are building a B2B SaaS for small teams.",
      "Each heartbeat: review open issues and advance the highest-priority one.",
    );
    expect(result).toBe(
      "<company_charter>\nWe are building a B2B SaaS for small teams.\n</company_charter>\n\nEach heartbeat: review open issues and advance the highest-priority one.",
    );
  });

  it("returns just the charter block when promptTemplate is empty", () => {
    const result = injectCharterIntoPrompt("Build fast, ship daily.", "");
    expect(result).toBe("<company_charter>\nBuild fast, ship daily.\n</company_charter>");
  });

  it("returns just the charter block when promptTemplate is whitespace-only", () => {
    const result = injectCharterIntoPrompt("Mission statement here.", "   ");
    expect(result).toBe("<company_charter>\nMission statement here.\n</company_charter>");
  });

  it("returns just the charter block when promptTemplate is undefined", () => {
    const result = injectCharterIntoPrompt("Disrupt the space industry.", undefined);
    expect(result).toBe("<company_charter>\nDisrupt the space industry.\n</company_charter>");
  });

  it("handles a non-string promptTemplate gracefully", () => {
    const result = injectCharterIntoPrompt("Charter text.", 42 as unknown as string);
    expect(result).toBe("<company_charter>\nCharter text.\n</company_charter>");
  });
});
