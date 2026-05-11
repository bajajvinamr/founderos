// @vitest-environment jsdom
//
// BL-013 (P4.b) — founder mode hides four categories of engineer-only noise:
//   1. `thinking` blocks (chain-of-thought)
//   2. raw tool-use blocks (`tool`, `tool_group`, `command_group`)
//   3. `stderr_group` (UNLESS the run failed — failure signal stays visible)
//   4. the `init` model/session kick-off event
//
// Engineer mode is additive — every block type renders exactly as before
// #174 (BL-012). The viewMode hook is `useDisplayMode()` backed by
// `localStorage["founderos.viewMode"]`.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TranscriptEntry } from "../../adapters";
import { ThemeProvider } from "../../context/ThemeContext";
import { RunTranscriptView } from "./RunTranscriptView";

const STORAGE_KEY = "founderos.viewMode";
const TS = "2026-03-12T00:00:00.000Z";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

interface RenderHandle {
  container: HTMLDivElement;
  root: Root;
}

function makeRoot(): RenderHandle {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

function tearDown(handle: RenderHandle): void {
  act(() => {
    handle.root.unmount();
  });
  handle.container.remove();
}

function render(handle: RenderHandle, entries: TranscriptEntry[]): void {
  act(() => {
    handle.root.render(
      <ThemeProvider>
        <RunTranscriptView entries={entries} />
      </ThemeProvider>,
    );
  });
}

describe("RunTranscriptView — founder mode gating (BL-013 P4.b)", () => {
  let handle: RenderHandle;

  beforeEach(() => {
    localStorage.clear();
    handle = makeRoot();
  });

  afterEach(() => {
    tearDown(handle);
    localStorage.clear();
  });

  // ── Thinking blocks ──────────────────────────────────────────
  it("founder mode hides thinking (chain-of-thought) blocks", () => {
    // Default viewMode is "founder" — no localStorage write needed.
    render(handle, [
      {
        kind: "assistant",
        ts: TS,
        text: "Visible founder copy",
      },
      {
        kind: "thinking",
        ts: TS,
        text: "INTERNAL_CHAIN_OF_THOUGHT_TOKEN",
      },
    ]);

    expect(handle.container.textContent).toContain("Visible founder copy");
    expect(handle.container.textContent).not.toContain("INTERNAL_CHAIN_OF_THOUGHT_TOKEN");
  });

  it("engineer mode shows thinking blocks (parity with pre-#174)", () => {
    localStorage.setItem(STORAGE_KEY, "engineer");
    render(handle, [
      {
        kind: "assistant",
        ts: TS,
        text: "Visible engineer copy",
      },
      {
        kind: "thinking",
        ts: TS,
        text: "ENGINEER_VISIBLE_THINKING",
      },
    ]);

    expect(handle.container.textContent).toContain("Visible engineer copy");
    expect(handle.container.textContent).toContain("ENGINEER_VISIBLE_THINKING");
  });

  // ── Raw tool-use blocks ──────────────────────────────────────
  it("founder mode hides raw tool-use blocks", () => {
    render(handle, [
      {
        kind: "assistant",
        ts: TS,
        text: "Founder-facing narrative",
      },
      {
        kind: "tool_call",
        ts: TS,
        name: "Read",
        toolUseId: "tu_1",
        input: { path: "RAW_TOOL_INPUT_TOKEN.txt" },
      },
      {
        kind: "tool_result",
        ts: TS,
        toolUseId: "tu_1",
        toolName: "Read",
        content: "RAW_TOOL_RESULT_BODY",
        isError: false,
      },
    ]);

    expect(handle.container.textContent).toContain("Founder-facing narrative");
    expect(handle.container.textContent).not.toContain("RAW_TOOL_INPUT_TOKEN");
    // The result content travels with the tool block (which is also hidden in
    // founder mode), so it must not surface either.
    expect(handle.container.textContent).not.toContain("RAW_TOOL_RESULT_BODY");
  });

  it("engineer mode shows raw tool-use blocks", () => {
    localStorage.setItem(STORAGE_KEY, "engineer");
    render(handle, [
      {
        kind: "tool_call",
        ts: TS,
        name: "Read",
        toolUseId: "tu_eng",
        input: { path: "ENGINEER_TOOL_INPUT.txt" },
      },
      {
        kind: "tool_result",
        ts: TS,
        toolUseId: "tu_eng",
        toolName: "Read",
        content: "ENGINEER_TOOL_RESULT_BODY",
        isError: false,
      },
    ]);

    // Engineer mode renders the tool card. The card collapses its full
    // payload by default but always surfaces the humanized tool name in the
    // header — that's our presence assertion. Founder mode would render no
    // tool card at all (cf. the founder-hides counterpart above).
    expect(handle.container.textContent).toContain("Used Read");
  });

  // ── stderr_group — failure-signal preservation ───────────────
  it("founder mode hides stderr_group on a successful run", () => {
    render(handle, [
      {
        kind: "stderr",
        ts: TS,
        text: "STDERR_NOISE_LINE_SUCCESS",
      },
      {
        kind: "result",
        ts: TS,
        text: "Done.",
        inputTokens: 10,
        outputTokens: 20,
        cachedTokens: 0,
        costUsd: 0.0001,
        subtype: "ok",
        isError: false,
        errors: [],
      },
    ]);

    expect(handle.container.textContent).not.toContain("STDERR_NOISE_LINE_SUCCESS");
  });

  it("founder mode SHOWS stderr_group when the run failed (signal, not noise)", () => {
    render(handle, [
      {
        kind: "stderr",
        ts: TS,
        text: "STDERR_FAILURE_SIGNAL_LINE",
      },
      {
        kind: "result",
        ts: TS,
        text: "boom",
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        subtype: "error",
        isError: true,
        errors: ["boom"],
      },
    ]);

    // `TranscriptStderrGroup` is collapsed by default — we assert the pill
    // is rendered (its "1 log line" header) which proves the block survived
    // founder-mode gating on a failed run. Compare with the success-case
    // counterpart above where the pill is absent entirely.
    expect(handle.container.textContent).toContain("1 log line");
  });

  // ── init event ───────────────────────────────────────────────
  it("founder mode hides the init model/session kick-off event", () => {
    render(handle, [
      {
        kind: "init",
        ts: TS,
        model: "claude-haiku-4-5",
        sessionId: "INIT_SESSION_TOKEN_42",
      },
      {
        kind: "assistant",
        ts: TS,
        text: "Founder copy survives",
      },
    ]);

    expect(handle.container.textContent).not.toContain("claude-haiku-4-5");
    expect(handle.container.textContent).not.toContain("INIT_SESSION_TOKEN_42");
    expect(handle.container.textContent).toContain("Founder copy survives");
  });

  it("engineer mode shows the init event", () => {
    localStorage.setItem(STORAGE_KEY, "engineer");
    render(handle, [
      {
        kind: "init",
        ts: TS,
        model: "claude-haiku-4-5",
        sessionId: "ENG_INIT_SESSION_TOKEN_42",
      },
    ]);

    expect(handle.container.textContent).toContain("claude-haiku-4-5");
  });
});
