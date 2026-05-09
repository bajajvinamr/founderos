// @vitest-environment jsdom

/**
 * Component-level test for the AI step of the V2 onboarding wizard.
 *
 * What this is testing:
 *   - Typing in the API key field eventually triggers a debounced
 *     `validateProviderKey` call (not on every keystroke).
 *   - A successful validation drops `validation.status` to "valid"
 *     and reports the trimmed key to the parent.
 *   - An "invalid_key" failure drops to "invalid".
 *   - A "rate_limited" failure surfaces the warning + skip affordance,
 *     and clicking skip flips status to "skipped".
 *   - Stale typing aborts the in-flight controller (we cannot directly
 *     observe abort, but we assert the second call wins by checking
 *     final state matches the second response).
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Step4Plugin,
  type ValidationState,
} from "./Step4Plugin";
import { DEFAULT_INTEGRATION_STATE } from "../onboarding-types";

const validateProviderKeyMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/providers", () => ({
  validateProviderKey: validateProviderKeyMock,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const DEBOUNCE_MS = 600;

interface HarnessRefs {
  validation: ValidationState;
  anthropicKey: string;
}

function buildProps(
  refs: HarnessRefs,
  patch: (mutator: (prev: HarnessRefs) => HarnessRefs) => void,
) {
  return {
    adapterChoice: "anthropic_api" as const,
    anthropicKey: refs.anthropicKey,
    integrations: { ...DEFAULT_INTEGRATION_STATE },
    validation: refs.validation,
    onAdapterChoiceChange: () => {},
    onAnthropicKeyChange: (next: string) =>
      patch((prev) => ({ ...prev, anthropicKey: next })),
    onIntegrationsChange: () => {},
    onValidationChange: (next: ValidationState) =>
      patch((prev) => ({ ...prev, validation: next })),
  };
}

describe("<Step4Plugin /> live key validation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    validateProviderKeyMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function renderHarness(initial: HarnessRefs): {
    getRefs: () => HarnessRefs;
  } {
    let current: HarnessRefs = initial;
    function patch(mutator: (prev: HarnessRefs) => HarnessRefs) {
      current = mutator(current);
      act(() => {
        root.render(<Step4Plugin {...buildProps(current, patch)} />);
      });
    }
    act(() => {
      root.render(<Step4Plugin {...buildProps(current, patch)} />);
    });
    return { getRefs: () => current };
  }

  function getInput(): HTMLInputElement {
    const el = container.querySelector(
      '[data-testid="anthropic-key-input"]',
    ) as HTMLInputElement | null;
    if (!el) throw new Error("API key input not rendered");
    return el;
  }

  function typeIntoInput(value: string) {
    const input = getInput();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    act(() => {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function flushAsync() {
    // Drain any queued promise callbacks. Three rounds is enough for
    // the validateProviderKey then() chain to settle.
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  it("does not call validateProviderKey before the debounce window expires", async () => {
    renderHarness({ validation: { status: "idle" }, anthropicKey: "" });
    typeIntoInput("sk-ant-typing");

    // Advance just under the debounce window.
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS - 50);
    });
    expect(validateProviderKeyMock).not.toHaveBeenCalled();
  });

  it("calls validateProviderKey once after debounce and reports valid", async () => {
    validateProviderKeyMock.mockResolvedValueOnce({ valid: true });

    const harness = renderHarness({
      validation: { status: "idle" },
      anthropicKey: "",
    });

    typeIntoInput("sk-ant-good");

    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    await flushAsync();

    expect(validateProviderKeyMock).toHaveBeenCalledTimes(1);
    expect(validateProviderKeyMock).toHaveBeenCalledWith(
      "anthropic",
      "sk-ant-good",
      expect.any(AbortSignal),
    );
    expect(harness.getRefs().validation).toEqual({ status: "valid" });
    // Trimmed key reported back to the parent.
    expect(harness.getRefs().anthropicKey).toBe("sk-ant-good");
  });

  it("surfaces invalid_key reason on rejection (Next stays blocked)", async () => {
    validateProviderKeyMock.mockResolvedValueOnce({
      valid: false,
      reason: "invalid_key",
    });

    const harness = renderHarness({
      validation: { status: "idle" },
      anthropicKey: "",
    });

    typeIntoInput("sk-ant-bad");
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    await flushAsync();

    const refs = harness.getRefs();
    expect(refs.validation).toEqual({
      status: "invalid",
      reason: "invalid_key",
    });
    // Critical: the parent's stored key is NOT updated when validation
    // failed — bootstrap would otherwise carry a known-bad key.
    expect(refs.anthropicKey).toBe("");
  });

  it("surfaces 'warning' state on rate_limited and unblocks Next when user clicks skip", async () => {
    validateProviderKeyMock.mockResolvedValueOnce({
      valid: false,
      reason: "rate_limited",
    });

    const harness = renderHarness({
      validation: { status: "idle" },
      anthropicKey: "",
    });

    typeIntoInput("sk-ant-x");
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    await flushAsync();

    expect(harness.getRefs().validation).toEqual({
      status: "warning",
      reason: "rate_limited",
    });

    const skipButton = container.querySelector(
      '[data-testid="skip-validation"]',
    ) as HTMLButtonElement | null;
    expect(skipButton).not.toBeNull();

    act(() => {
      skipButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const refs = harness.getRefs();
    expect(refs.validation).toEqual({ status: "skipped" });
    // Skipping persists the typed key as-is (bootstrap re-validates).
    expect(refs.anthropicKey).toBe("sk-ant-x");
  });

  it("surfaces 'warning' state on network_error", async () => {
    validateProviderKeyMock.mockResolvedValueOnce({
      valid: false,
      reason: "network_error",
    });

    const harness = renderHarness({
      validation: { status: "idle" },
      anthropicKey: "",
    });

    typeIntoInput("sk-ant-net");
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    await flushAsync();

    expect(harness.getRefs().validation).toEqual({
      status: "warning",
      reason: "network_error",
    });
  });

  it("debounces fast typing — only the latest call wins", async () => {
    // Resolve in call order; second call wins because the first is
    // cancelled by clearTimeout before it ever runs.
    validateProviderKeyMock.mockResolvedValueOnce({ valid: true });

    const harness = renderHarness({
      validation: { status: "idle" },
      anthropicKey: "",
    });

    // First keystroke schedules a timer.
    typeIntoInput("sk-ant-firs");
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS - 100);
    });
    expect(validateProviderKeyMock).not.toHaveBeenCalled();

    // Second keystroke before debounce expires — clears prior timer.
    typeIntoInput("sk-ant-final");
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    await flushAsync();

    expect(validateProviderKeyMock).toHaveBeenCalledTimes(1);
    const callArgs = validateProviderKeyMock.mock.calls[0];
    expect(callArgs[1]).toBe("sk-ant-final");
    expect(harness.getRefs().validation).toEqual({ status: "valid" });
  });

  it("clears state to idle when the field is emptied", async () => {
    validateProviderKeyMock.mockResolvedValueOnce({ valid: true });

    const harness = renderHarness({
      validation: { status: "idle" },
      anthropicKey: "",
    });

    typeIntoInput("sk-ant-good");
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    await flushAsync();
    expect(harness.getRefs().validation).toEqual({ status: "valid" });

    // User clears the input — should drop back to idle without
    // firing another validation.
    validateProviderKeyMock.mockClear();
    typeIntoInput("");
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    await flushAsync();

    expect(validateProviderKeyMock).not.toHaveBeenCalled();
    expect(harness.getRefs().validation).toEqual({ status: "idle" });
  });
});
