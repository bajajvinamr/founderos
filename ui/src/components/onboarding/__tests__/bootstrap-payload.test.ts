/**
 * Regression test for the V2 wizard bootstrap-payload key-passing bug
 * (found via audit 2026-05-18).
 *
 * The bug: `FounderOnboardingWizard.tsx:handleFinish` previously built
 * the payload inline with
 *
 *   anthropicKey: adapterChoice === "anthropic_api" ? draft.anthropicKey : ""
 *
 * which stripped the API key for `openai_api` and `google_api` adapter
 * families. The `AdapterValidationPanel` stores the key for ALL three
 * api-mode adapters in `draft.anthropicKey` (misnamed field), but the
 * server-side `instance_api_keys` setKey writes nothing when the field
 * is empty — leaving founders past onboarding with `no_api_key` at first
 * heartbeat. End-to-end OpenAI / Google onboarding was broken.
 *
 * The fix: send the key for any api-mode adapter family. Extracted into
 * a pure `buildBootstrapPayload` helper so this regression test can
 * exercise it without rendering the wizard's full tree.
 */

import { describe, expect, it } from "vitest";

import { buildBootstrapPayload } from "../FounderOnboardingWizard.js";
import { buildAutoCharters } from "../auto-charter.js";
import {
  DEFAULT_AUTONOMY_LEVEL,
  DEFAULT_INTEGRATION_STATE,
  DEFAULT_NON_CORE_DEPARTMENTS,
  type OnboardingDraft,
} from "../onboarding-types.js";

function makeDraft(overrides: Partial<OnboardingDraft> = {}): OnboardingDraft {
  return {
    vision: "Building a self-improving AI agent platform for founders.",
    bottlenecks: ["growth"],
    team: "solo",
    cofounderName: "",
    cofounderEmail: "",
    adapterChoice: null,
    anthropicKey: "",
    adapterValidated: false,
    validatedFor: null,
    integrations: { ...DEFAULT_INTEGRATION_STATE },
    nonCoreDepartments: [...DEFAULT_NON_CORE_DEPARTMENTS],
    autonomyLevel: DEFAULT_AUTONOMY_LEVEL,
    charters: buildAutoCharters({
      vision: "Building a self-improving AI agent platform.",
      bottlenecks: ["growth"],
      team: "solo",
    }),
    firstDecisionId: null,
    telemetryEnabled: false,
    ...overrides,
  };
}

describe("buildBootstrapPayload — API key passing invariant", () => {
  // ── The three api-mode adapter families MUST send the key. ────────────
  it("sends anthropicKey for adapterChoice='anthropic_api'", () => {
    const key = "sk-ant-test-anthropic-key-1234567890";
    const payload = buildBootstrapPayload(
      makeDraft({ anthropicKey: key }),
      "anthropic_api",
    );
    expect(payload.anthropicKey).toBe(key);
    expect(payload.adapterChoice).toBe("anthropic_api");
  });

  it("sends anthropicKey for adapterChoice='openai_api' (regression: previously stripped)", () => {
    // Pre-fix, this returned "" — the wizard captured the OpenAI key in
    // draft.anthropicKey (shared field) but handleFinish stripped it
    // before POST. Server rejected with `unprocessable: API key required`.
    const key = "sk-test-openai-key-1234567890";
    const payload = buildBootstrapPayload(
      makeDraft({ anthropicKey: key }),
      "openai_api",
    );
    expect(payload.anthropicKey).toBe(key);
    expect(payload.adapterChoice).toBe("openai_api");
  });

  it("sends anthropicKey for adapterChoice='google_api' (regression: previously stripped)", () => {
    const key = "AIzaSy-test-google-key-1234567890";
    const payload = buildBootstrapPayload(
      makeDraft({ anthropicKey: key }),
      "google_api",
    );
    expect(payload.anthropicKey).toBe(key);
    expect(payload.adapterChoice).toBe("google_api");
  });

  // ── CLI-family adapters MUST send empty string (no key needed). ───────
  it("sends empty anthropicKey for adapterChoice='claude_local' (CLI family, no API key)", () => {
    // Even if the draft happens to have a key value (e.g., the founder
    // switched tiles mid-flow), CLI adapters don't have an API key — the
    // runner uses the founder's CLI subscription credentials directly.
    const payload = buildBootstrapPayload(
      makeDraft({ anthropicKey: "leftover-key-from-switching-tiles" }),
      "claude_local",
    );
    expect(payload.anthropicKey).toBe("");
    expect(payload.adapterChoice).toBe("claude_local");
  });

  it("sends empty anthropicKey for adapterChoice='gemini_local' (CLI family)", () => {
    const payload = buildBootstrapPayload(
      makeDraft({ anthropicKey: "some-key" }),
      "gemini_local",
    );
    expect(payload.anthropicKey).toBe("");
  });

  it("sends empty anthropicKey for adapterChoice='codex_local' (CLI family)", () => {
    const payload = buildBootstrapPayload(
      makeDraft({ anthropicKey: "some-key" }),
      "codex_local",
    );
    expect(payload.anthropicKey).toBe("");
  });
});

describe("buildBootstrapPayload — non-key fields pass through correctly", () => {
  it("trims vision", () => {
    const payload = buildBootstrapPayload(
      makeDraft({ vision: "  Building stuff  " }),
      "anthropic_api",
    );
    expect(payload.vision).toBe("Building stuff");
  });

  it("preserves bottlenecks array", () => {
    const payload = buildBootstrapPayload(
      makeDraft({ bottlenecks: ["growth", "ops"] }),
      "claude_local",
    );
    expect(payload.bottlenecks).toEqual(["growth", "ops"]);
  });

  it("sends null cofounder when both fields are empty/whitespace", () => {
    const payload = buildBootstrapPayload(
      makeDraft({ cofounderName: "   ", cofounderEmail: "" }),
      "claude_local",
    );
    expect(payload.cofounder).toBeNull();
  });

  it("sends cofounder object when at least one field has content", () => {
    const payload = buildBootstrapPayload(
      makeDraft({ cofounderName: "Alice", cofounderEmail: "" }),
      "claude_local",
    );
    expect(payload.cofounder).toEqual({ name: "Alice", email: null });
  });

  it("propagates telemetry consent verbatim (default: false)", () => {
    const optIn = buildBootstrapPayload(
      makeDraft({ telemetryEnabled: true }),
      "claude_local",
    );
    expect(optIn.telemetryEnabled).toBe(true);

    const optOut = buildBootstrapPayload(
      makeDraft({ telemetryEnabled: false }),
      "claude_local",
    );
    expect(optOut.telemetryEnabled).toBe(false);
  });
});
