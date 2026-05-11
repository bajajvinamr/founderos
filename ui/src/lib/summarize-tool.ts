// BL-014 (P4.c): founder-mode tool action summarization.
//
// #178 (P4.b) hid raw tool-use blocks entirely in founder mode. That gave
// founders a clean transcript but erased the signal that "the agent is
// actually doing work right now." This helper replaces "hide entirely"
// with a single founder-friendly one-liner per invocation — emoji +
// present-progressive verb + ellipsis — so the founder sees motion without
// engineer-language tool names like "bash_run_command" or "Glob".
//
// Contract: stable, side-effect-free, fully synchronous. Called once per
// tool block from `RunTranscriptView.tsx` founder mode. Unknown slugs fall
// back to a generic "Working…" — never throw, never leak engineer copy.

/**
 * Top-15 tool slug families observed across the FounderOS adapter surface
 * (`packages/adapters/{claude,codex,gemini,cursor,opencode,pi}-local` +
 * Anthropic API canonical names from `parse-stdout.ts`). Each canonical
 * key maps to a founder-language summary; the slug normalizer below
 * folds the raw `tool_call.name` string into one of these keys.
 *
 * Coverage rationale per slug:
 *  - bash:        Claude `Bash`, Codex `command_execution`, Gemini `shell`,
 *                 Cursor `shellToolCall` / `shell`, spec example
 *                 `bash_run_command`. Most-frequent tool by call volume.
 *  - read:        Claude `Read`, fixture `read_file`, Codex `view`.
 *  - edit:        Claude `Edit`, `MultiEdit`, fixture `apply_patch`,
 *                 OpenAI `str_replace_editor`, `str_replace`.
 *  - write:       Claude `Write`, `create_file`.
 *  - grep:        Claude `Grep`, ripgrep-shaped slugs.
 *  - glob:        Claude `Glob`, file-pattern enumeration.
 *  - web_fetch:   Claude `WebFetch`, URL retrieval.
 *  - web_search:  Claude `WebSearch`, Codex/Gemini `web_search` system
 *                 activity (already observed in `runTranscriptFixtures`).
 *  - task:        Claude `Task` subagent dispatch.
 *  - todo_write:  Claude `TodoWrite` — task list management.
 *  - notebook:    Claude `NotebookEdit` — Jupyter notebook ops.
 *  - apply_patch: Codex/Cursor `apply_patch` style diff application (sibling
 *                 of edit but distinct verb — surfaced separately to match
 *                 patch-application semantics).
 *  - mcp:         Any `mcp__*` prefixed MCP server tool (Composio, Figma,
 *                 Shopify, Slack, etc.) — generic integration verb.
 *  - composio:    Direct `composio_*` / `executeTool` calls — same family
 *                 as MCP but routed through the FounderOS composio bridge.
 *  - permission:  `permission_denied` synthetic results from
 *                 `permission-tool-gate.ts` — surfaces the gate as a
 *                 first-class founder-language line.
 */

interface ToolSummary {
  readonly emoji: string;
  readonly text: string;
}

const SUMMARIES: Readonly<Record<string, ToolSummary>> = {
  bash: { emoji: "\u{1F4C2}", text: "Browsing files…" }, // 📂
  read: { emoji: "\u{1F4D6}", text: "Reading a file…" }, // 📖
  edit: { emoji: "✏️", text: "Editing a file…" }, // ✏️
  write: { emoji: "\u{1F4DD}", text: "Writing a file…" }, // 📝
  grep: { emoji: "\u{1F50D}", text: "Searching the codebase…" }, // 🔍
  glob: { emoji: "\u{1F5C2}️", text: "Finding files…" }, // 🗂️
  web_fetch: { emoji: "\u{1F310}", text: "Fetching a web page…" }, // 🌐
  web_search: { emoji: "\u{1F50E}", text: "Searching the web…" }, // 🔎
  task: { emoji: "\u{1F916}", text: "Delegating to a subagent…" }, // 🤖
  todo_write: { emoji: "✅", text: "Updating the task list…" }, // ✅
  notebook: { emoji: "\u{1F4D3}", text: "Updating a notebook…" }, // 📓
  apply_patch: { emoji: "\u{1F9F5}", text: "Applying a patch…" }, // 🧵
  mcp: { emoji: "\u{1F50C}", text: "Calling an integration…" }, // 🔌
  composio: { emoji: "\u{1F517}", text: "Running a Composio action…" }, // 🔗
  permission: { emoji: "\u{1F512}", text: "Tool call blocked by permission gate" }, // 🔒
} as const;

const FALLBACK: ToolSummary = { emoji: "", text: "Working…" };

/**
 * Normalize a raw `tool_call.name` (heterogeneous across Claude / Codex /
 * Gemini / Cursor / OpenCode / pi-local adapters) into one of the canonical
 * top-15 summary keys. Match is case-insensitive substring; order matters
 * because some slugs are substrings of others (`web_search` before `web_fetch`
 * is fine since they don't overlap, but `read_file` must beat the bare
 * `read` if we ever add it).
 *
 * Returns `null` when no canonical key matches — caller uses FALLBACK.
 */
function normalizeSlug(toolSlug: string): keyof typeof SUMMARIES | null {
  if (!toolSlug) return null;
  const lower = toolSlug.toLowerCase();

  // MCP / Composio first — these prefixes wrap arbitrary downstream verbs
  // (e.g. `mcp__claude_ai_Slack__send_message`, `composio_slack_send_message`)
  // and we want the integration framing, not the verb framing.
  if (lower.startsWith("mcp__") || lower.startsWith("mcp_")) return "mcp";
  if (lower.startsWith("composio")) return "composio";

  // Permission-denied synthetic tool result from permission-tool-gate.
  if (lower === "permission_denied" || lower.includes("permission_denied")) return "permission";

  // Bash / shell family — `command_execution` (Codex), `shellToolCall` (Cursor),
  // `bash`, `shell`, `bash_run_command` (spec example).
  if (
    lower === "bash"
    || lower === "shell"
    || lower === "command_execution"
    || lower === "shelltoolcall"
    || lower.startsWith("bash_run")
    || lower.startsWith("bash ")
  ) {
    return "bash";
  }

  // Read family — `Read`, `read_file`, `view` (Codex).
  if (lower === "read" || lower === "read_file" || lower === "view") return "read";

  // Apply-patch is its own verb (diff application, not free-form edit).
  if (lower === "apply_patch" || lower === "applypatch") return "apply_patch";

  // Edit family — `Edit`, `MultiEdit`, `str_replace_editor`, `str_replace`.
  if (
    lower === "edit"
    || lower === "multiedit"
    || lower === "str_replace"
    || lower === "str_replace_editor"
    || lower === "str_replace_based_edit_tool"
  ) {
    return "edit";
  }

  // Write family — `Write`, `create_file`.
  if (lower === "write" || lower === "create_file" || lower === "write_file") return "write";

  // Grep / Glob — direct slug names.
  if (lower === "grep" || lower === "ripgrep") return "grep";
  if (lower === "glob") return "glob";

  // Web family — order matters: search before fetch is not a conflict here
  // (no overlap) but keep them explicit.
  if (lower === "websearch" || lower === "web_search") return "web_search";
  if (lower === "webfetch" || lower === "web_fetch" || lower === "fetch_url") return "web_fetch";

  // Task subagent dispatch.
  if (lower === "task" || lower === "dispatch_subagent") return "task";

  // Todo list maintenance.
  if (lower === "todowrite" || lower === "todo_write" || lower === "todoread") return "todo_write";

  // Notebook editing.
  if (
    lower === "notebookedit"
    || lower === "notebook_edit"
    || lower === "notebookread"
    || lower === "notebook_read"
  ) {
    return "notebook";
  }

  return null;
}

/**
 * Convert a raw tool invocation into a single founder-language line.
 *
 * Voice contract: emoji + present-progressive verb + ellipsis. Examples:
 *   summarizeTool("bash_run_command", { command: "ls -la" }) → "📂 Browsing files…"
 *   summarizeTool("Read",             { path: "/etc/hosts" }) → "📖 Reading a file…"
 *   summarizeTool("mcp__Slack__send", { ...           })     → "🔌 Calling an integration…"
 *   summarizeTool("brand_new_tool",   undefined)             → "Working…"
 *
 * The `input` parameter is accepted for forward-compatibility (some future
 * summary keys may want to surface "Reading server/src/app.ts" or
 * "Running `pnpm typecheck`") but the v1 voice is intentionally
 * input-independent — founders care about *what kind of work* is
 * happening, not the engineer-level argument list.
 */
export function summarizeTool(toolSlug: string, _input?: unknown): string {
  const key = normalizeSlug(toolSlug);
  const summary = key ? SUMMARIES[key] : FALLBACK;
  return summary.emoji ? `${summary.emoji} ${summary.text}` : summary.text;
}

/**
 * Exposed list of canonical summary keys so tests + UI consumers can
 * enumerate the supported slug families without re-parsing the helper.
 */
export const SUMMARIZE_TOOL_KEYS: ReadonlyArray<keyof typeof SUMMARIES> = Object.freeze([
  "bash",
  "read",
  "edit",
  "write",
  "grep",
  "glob",
  "web_fetch",
  "web_search",
  "task",
  "todo_write",
  "notebook",
  "apply_patch",
  "mcp",
  "composio",
  "permission",
]);
