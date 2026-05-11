// @vitest-environment jsdom

/**
 * Unit tests for the Step 4 adapter-validation panel.
 *
 * Project convention (see __tests__/provider-labels.test.tsx) is raw
 * react-dom/client + react act(), NOT @testing-library — so this file
 * follows the same pattern.
 *
 * Two paths exercised:
 *   1. `api_key` adapter — typing a key, clicking Validate, watching
 *      the mocked `validateProviderKey()` result drive `onValidated`.
 *   2. `subscription` adapter — clicking the attestation button flips
 *      the gate without a network call.
 *
 * Plus the edit-invalidation rule: editing the key after a successful
 * validation must reset the gate.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterValidationPanel } from "./AdapterValidationPanel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const validateProviderKeyMock = vi.fn();
vi.mock("@/api/providers", async () => {
  const actual = await vi.importActual<typeof import("@/api/providers")>(
    "@/api/providers",
  );
  return {
    ...actual,
    validateProviderKey: (
      ...args: Parameters<typeof actual.validateProviderKey>
    ) => validateProviderKeyMock(...args),
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  validateProviderKeyMock.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function $(selector: string): HTMLElement | null {
  return container.querySelector(selector);
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flushPromises() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("AdapterValidationPanel — api_key path", () => {
  it("renders the password input + Validate button for anthropic_api", () => {
    act(() => {
      root.render(
        <AdapterValidationPanel
          adapterChoice="anthropic_api"
          apiKey=""
          onApiKeyChange={() => {}}
          validated={false}
          onValidated={() => {}}
        />,
      );
    });
    const panel = $("[data-testid='adapter-validation-panel']");
    expect(panel?.getAttribute("data-validation-mode")).toBe("api-key");
    const input = $("[data-testid='adapter-validation-api-key-input']") as
      | HTMLInputElement
      | null;
    expect(input?.type).toBe("password");
    expect($("[data-testid='adapter-validation-validate-btn']")).not.toBeNull();
  });

  it("disables Validate when the key field is empty", () => {
    act(() => {
      root.render(
        <AdapterValidationPanel
          adapterChoice="anthropic_api"
          apiKey=""
          onApiKeyChange={() => {}}
          validated={false}
          onValidated={() => {}}
        />,
      );
    });
    const btn = $(
      "[data-testid='adapter-validation-validate-btn']",
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("fires onValidated(true) and shows the green status on success", async () => {
    validateProviderKeyMock.mockResolvedValueOnce({ valid: true });
    const onValidated = vi.fn();
    // We mount with validated=true directly. validateProviderKeyMock is
    // still triggered by the click; we are testing both that the mock
    // ran with the right args AND that the parent-reported validated
    // state surfaces the green status badge. Decoupling the two avoids
    // racing async state updates against the re-render in jsdom.
    act(() => {
      root.render(
        <AdapterValidationPanel
          adapterChoice="anthropic_api"
          apiKey="sk-ant-1234567890"
          onApiKeyChange={() => {}}
          validated={true}
          onValidated={onValidated}
        />,
      );
    });
    expect($("[data-testid='adapter-validation-status-valid']")).not.toBeNull();
    // Now exercise the click → validateProviderKey path in a separate
    // mount so the wire contract is also asserted.
    act(() => {
      root.render(
        <AdapterValidationPanel
          adapterChoice="anthropic_api"
          apiKey="sk-ant-1234567890"
          onApiKeyChange={() => {}}
          validated={false}
          onValidated={onValidated}
        />,
      );
    });
    await act(async () => {
      ($(
        "[data-testid='adapter-validation-validate-btn']",
      ) as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onValidated).toHaveBeenCalledWith(true);
    expect(validateProviderKeyMock).toHaveBeenCalledTimes(1);
    expect(validateProviderKeyMock.mock.calls[0][0]).toBe("anthropic");
    expect(validateProviderKeyMock.mock.calls[0][1]).toBe("sk-ant-1234567890");
  });

  it("fires onValidated(false) and surfaces reason copy on invalid_key", async () => {
    validateProviderKeyMock.mockResolvedValueOnce({
      valid: false,
      reason: "invalid_key",
    });
    const onValidated = vi.fn();
    act(() => {
      root.render(
        <AdapterValidationPanel
          adapterChoice="anthropic_api"
          apiKey="sk-ant-bad"
          onApiKeyChange={() => {}}
          validated={false}
          onValidated={onValidated}
        />,
      );
    });
    const btn = $(
      "[data-testid='adapter-validation-validate-btn']",
    ) as HTMLButtonElement;
    act(() => {
      btn.click();
    });
    await flushPromises();
    expect(onValidated).toHaveBeenCalledWith(false);
    const errEl = $("[data-testid='adapter-validation-status-invalid']");
    expect(errEl?.textContent).toContain("Double-check");
  });

  it("editing the key after a successful validation resets the gate", async () => {
    validateProviderKeyMock.mockResolvedValueOnce({ valid: true });
    const onValidated = vi.fn();
    function renderWith(validated: boolean, apiKey: string) {
      act(() => {
        root.render(
          <AdapterValidationPanel
            adapterChoice="anthropic_api"
            apiKey={apiKey}
            onApiKeyChange={() => {}}
            validated={validated}
            onValidated={onValidated}
          />,
        );
      });
    }
    renderWith(false, "sk-ant-good");
    act(() => {
      ($(
        "[data-testid='adapter-validation-validate-btn']",
      ) as HTMLButtonElement).click();
    });
    await flushPromises();
    expect(onValidated).toHaveBeenLastCalledWith(true);
    renderWith(true, "sk-ant-good");
    onValidated.mockClear();
    // Founder edits the key — onValidated should fire with false to slam
    // the wizard's gate shut.
    const input = $(
      "[data-testid='adapter-validation-api-key-input']",
    ) as HTMLInputElement;
    act(() => {
      setInputValue(input, "sk-ant-edited");
    });
    expect(onValidated).toHaveBeenCalledWith(false);
  });

  it("maps openai_api → 'openai_api' and google_api → 'google_api' provider ids", async () => {
    validateProviderKeyMock.mockResolvedValue({ valid: true });
    act(() => {
      root.render(
        <AdapterValidationPanel
          adapterChoice="openai_api"
          apiKey="sk-openai-test"
          onApiKeyChange={() => {}}
          validated={false}
          onValidated={() => {}}
        />,
      );
    });
    act(() => {
      ($(
        "[data-testid='adapter-validation-validate-btn']",
      ) as HTMLButtonElement).click();
    });
    await flushPromises();
    expect(validateProviderKeyMock.mock.calls[0][0]).toBe("openai_api");

    act(() => {
      root.render(
        <AdapterValidationPanel
          adapterChoice="google_api"
          apiKey="AIza-test"
          onApiKeyChange={() => {}}
          validated={false}
          onValidated={() => {}}
        />,
      );
    });
    act(() => {
      ($(
        "[data-testid='adapter-validation-validate-btn']",
      ) as HTMLButtonElement).click();
    });
    await flushPromises();
    expect(validateProviderKeyMock).toHaveBeenCalledTimes(2);
    expect(validateProviderKeyMock.mock.calls[1][0]).toBe("google_api");
  });
});

describe("AdapterValidationPanel — subscription path", () => {
  it("renders the CLI attestation button for claude_local", () => {
    act(() => {
      root.render(
        <AdapterValidationPanel
          adapterChoice="claude_local"
          apiKey=""
          onApiKeyChange={() => {}}
          validated={false}
          onValidated={() => {}}
        />,
      );
    });
    const panel = $("[data-testid='adapter-validation-panel']");
    expect(panel?.getAttribute("data-validation-mode")).toBe("subscription");
    expect($("[data-testid='adapter-validation-api-key-input']")).toBeNull();
    const btn = $("[data-testid='adapter-validation-confirm-cli-btn']");
    expect(btn?.textContent).toContain("Claude Code");
  });

  it("flips onValidated(true) on the attestation click — no network call", () => {
    const onValidated = vi.fn();
    act(() => {
      root.render(
        <AdapterValidationPanel
          adapterChoice="gemini_local"
          apiKey=""
          onApiKeyChange={() => {}}
          validated={false}
          onValidated={onValidated}
        />,
      );
    });
    act(() => {
      ($(
        "[data-testid='adapter-validation-confirm-cli-btn']",
      ) as HTMLButtonElement).click();
    });
    expect(onValidated).toHaveBeenCalledWith(true);
    expect(validateProviderKeyMock).not.toHaveBeenCalled();
  });

  it("disables the attestation button when parent reports validated=true", () => {
    const onValidated = vi.fn();
    // Mount directly with validated=true to mirror what the wizard
    // re-renders after the founder clicks Confirm. We do this rather
    // than click-then-rerender so we are testing the rendered output
    // contract (parent says validated → button disabled) rather than
    // racing against React's async state batching across act() blocks.
    act(() => {
      root.render(
        <AdapterValidationPanel
          adapterChoice="codex_local"
          apiKey=""
          onApiKeyChange={() => {}}
          validated={true}
          onValidated={onValidated}
        />,
      );
    });
    const btn = $(
      "[data-testid='adapter-validation-confirm-cli-btn']",
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("Confirmed");
  });
});
