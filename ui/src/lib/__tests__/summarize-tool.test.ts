// BL-014 (P4.c) — unit tests for the founder-mode tool action summarizer.
// Voice contract: emoji + present-progressive verb + ellipsis.
//   summarizeTool("bash_run_command", { command: "ls -la" }) → "📂 Browsing files…"

import { describe, expect, it } from "vitest";
import { summarizeTool, SUMMARIZE_TOOL_KEYS } from "../summarize-tool";

describe("summarizeTool — top-15 founder-language slug coverage", () => {
  it("covers exactly the 15 canonical summary keys", () => {
    // Locks in the top-15 contract — adding a 16th key requires updating
    // both the helper AND the spec scope.
    expect(SUMMARIZE_TOOL_KEYS).toHaveLength(15);
    expect(new Set(SUMMARIZE_TOOL_KEYS).size).toBe(15);
  });

  // ── Bash family (spec example, multi-adapter aliases) ────────
  it("summarizes bash_run_command with founder voice (spec example)", () => {
    expect(summarizeTool("bash_run_command", { command: "ls -la" })).toBe(
      "\u{1F4C2} Browsing files…",
    );
  });

  it("summarizes Codex `command_execution` as bash family", () => {
    expect(summarizeTool("command_execution", { command: "pnpm test" })).toBe(
      "\u{1F4C2} Browsing files…",
    );
  });

  it("summarizes Gemini `shell` as bash family", () => {
    expect(summarizeTool("shell", { command: "echo hi" })).toBe(
      "\u{1F4C2} Browsing files…",
    );
  });

  it("summarizes Cursor `shellToolCall` as bash family (case-insensitive)", () => {
    expect(summarizeTool("shellToolCall", { command: "pwd" })).toBe(
      "\u{1F4C2} Browsing files…",
    );
  });

  it("summarizes Claude canonical `Bash` (capitalized) as bash family", () => {
    expect(summarizeTool("Bash", { command: "ls" })).toBe(
      "\u{1F4C2} Browsing files…",
    );
  });

  // ── Read / Write / Edit ──────────────────────────────────────
  it("summarizes Claude canonical `Read`", () => {
    expect(summarizeTool("Read", { path: "/etc/hosts" })).toBe(
      "\u{1F4D6} Reading a file…",
    );
  });

  it("summarizes adapter alias `read_file`", () => {
    expect(summarizeTool("read_file", { path: "ui/src/app.tsx" })).toBe(
      "\u{1F4D6} Reading a file…",
    );
  });

  it("summarizes Codex alias `view` as read", () => {
    expect(summarizeTool("view")).toBe("\u{1F4D6} Reading a file…");
  });

  it("summarizes Claude `Edit` with ✏️ pencil voice", () => {
    expect(summarizeTool("Edit", { file_path: "x.ts" })).toBe(
      "✏️ Editing a file…",
    );
  });

  it("summarizes Claude `MultiEdit` as edit family", () => {
    expect(summarizeTool("MultiEdit")).toBe("✏️ Editing a file…");
  });

  it("summarizes OpenAI `str_replace_editor` as edit family", () => {
    expect(summarizeTool("str_replace_editor")).toBe("✏️ Editing a file…");
  });

  it("summarizes Claude `Write` with 📝 voice", () => {
    expect(summarizeTool("Write", { file_path: "x.ts" })).toBe(
      "\u{1F4DD} Writing a file…",
    );
  });

  it("summarizes alias `create_file` as write family", () => {
    expect(summarizeTool("create_file")).toBe("\u{1F4DD} Writing a file…");
  });

  // ── Search family ───────────────────────────────────────────
  it("summarizes Grep as codebase search", () => {
    expect(summarizeTool("Grep", { pattern: "foo" })).toBe(
      "\u{1F50D} Searching the codebase…",
    );
  });

  it("summarizes Glob as file finder", () => {
    expect(summarizeTool("Glob", { pattern: "**/*.ts" })).toBe(
      "\u{1F5C2}\u{FE0F} Finding files…",
    );
  });

  // ── Web family ──────────────────────────────────────────────
  it("summarizes WebFetch with globe voice", () => {
    expect(summarizeTool("WebFetch", { url: "https://example.com" })).toBe(
      "\u{1F310} Fetching a web page…",
    );
  });

  it("summarizes WebSearch distinctly from WebFetch", () => {
    expect(summarizeTool("WebSearch", { query: "founderos" })).toBe(
      "\u{1F50E} Searching the web…",
    );
  });

  it("summarizes adapter-snake-case `web_search` consistently with WebSearch", () => {
    expect(summarizeTool("web_search")).toBe(summarizeTool("WebSearch"));
  });

  // ── Task / TodoWrite / Notebook ──────────────────────────────
  it("summarizes Task subagent dispatch", () => {
    expect(summarizeTool("Task", { description: "review diff" })).toBe(
      "\u{1F916} Delegating to a subagent…",
    );
  });

  it("summarizes TodoWrite as task list update", () => {
    expect(summarizeTool("TodoWrite", { todos: [] })).toBe(
      "✅ Updating the task list…",
    );
  });

  it("summarizes NotebookEdit as notebook update", () => {
    expect(summarizeTool("NotebookEdit", { notebook_path: "n.ipynb" })).toBe(
      "\u{1F4D3} Updating a notebook…",
    );
  });

  // ── apply_patch — distinct from edit (diff-application semantic) ──
  it("summarizes Codex `apply_patch` as patch application", () => {
    expect(summarizeTool("apply_patch", { file: "x.ts" })).toBe(
      "\u{1F9F5} Applying a patch…",
    );
  });

  // ── MCP / Composio integration families ─────────────────────
  it("summarizes any `mcp__*` slug as integration call (Slack, Figma, etc.)", () => {
    expect(summarizeTool("mcp__claude_ai_Slack__send_message")).toBe(
      "\u{1F50C} Calling an integration…",
    );
    expect(summarizeTool("mcp__claude_ai_Figma__get_design_context")).toBe(
      "\u{1F50C} Calling an integration…",
    );
  });

  it("summarizes `composio_*` slugs as Composio action", () => {
    expect(summarizeTool("composio_slack_send_message")).toBe(
      "\u{1F517} Running a Composio action…",
    );
  });

  // ── Permission-gate synthetic results ───────────────────────
  it("summarizes `permission_denied` synthetic results with a lock", () => {
    expect(summarizeTool("permission_denied")).toBe(
      "\u{1F512} Tool call blocked by permission gate",
    );
  });

  // ── Fallback case ───────────────────────────────────────────
  it("falls back to 'Working…' for unknown slugs (no leaked engineer copy)", () => {
    expect(summarizeTool("brand_new_undefined_tool_xyz")).toBe("Working…");
    expect(summarizeTool("unknown")).toBe("Working…");
    expect(summarizeTool("")).toBe("Working…");
  });

  it("never throws on missing or non-object input", () => {
    expect(() => summarizeTool("Read")).not.toThrow();
    expect(() => summarizeTool("Read", null)).not.toThrow();
    expect(() => summarizeTool("Read", undefined)).not.toThrow();
    expect(() => summarizeTool("Read", "string-input")).not.toThrow();
    expect(() => summarizeTool("Read", 42)).not.toThrow();
  });

  // ── Distinct strings per family (3+ slugs producing distinct summaries) ──
  it("produces distinct summary strings across 3+ unrelated slugs", () => {
    const a = summarizeTool("bash_run_command", { command: "x" });
    const b = summarizeTool("Read", { path: "x" });
    const c = summarizeTool("WebSearch", { query: "x" });
    const d = summarizeTool("Task", {});
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});
