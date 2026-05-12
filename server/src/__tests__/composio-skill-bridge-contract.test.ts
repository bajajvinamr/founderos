/**
 * Structural contract tests for `runComposioTool` — Loop 2 ticket L2-D23.
 *
 * Background:
 *   PR #30 (verified 2026-05-05 at `composio-skill-bridge.ts:96-113`) closed
 *   the Composio cross-org leak by making `connectedAccountId: string` a
 *   REQUIRED, non-optional, non-nullable input field on `runComposioTool`.
 *   Before PR #30, Composio v3 `executeTool({ userId })` would silently pick
 *   an arbitrary connected account when the user had the same app connected
 *   in multiple orgs — agent in Org A could post to Org B Slack.
 *
 *   Invariant source (CLAUDE.md):
 *     "Composio cross-org leak is closed (PR #30, verified 2026-05-05 at
 *      composio-skill-bridge.ts:96-113). runComposioTool({ userId, toolName,
 *      params, connectedAccountId }) now requires connectedAccountId: string;
 *      threaded through 6 skill call sites. Agent in Org A can no longer
 *      post to Org B Slack."
 *
 * What this test asserts:
 *   1. The type-level contract — `connectedAccountId` is a required,
 *      non-nullable `string` on `runComposioTool`'s input — is enforced
 *      at compile time. (Proofs live in `composio-skill-bridge.contract.ts`,
 *      which is typechecked by `pnpm typecheck`; this test imports the
 *      sentinel export to keep that module in the graph.)
 *   2. The runtime function exists and is callable.
 *   3. Calling `runComposioTool` with `connectedAccountId: ""` while Composio
 *      is configured passes the empty string to the underlying client — the
 *      runtime layer does NOT silently substitute a default. (Empty string
 *      defense: catches the case where some call site computes the id from
 *      a nullable source and falls back to "" instead of erroring at the
 *      route boundary.)
 *   4. Every existing call site of `runComposioTool` in the server source
 *      tree passes a `connectedAccountId:` field — a static survey via
 *      `fs.readFileSync` + regex. If a new skill is added without it, this
 *      test fails (TypeScript will also refuse to compile, but the static
 *      survey is the belt-and-suspenders against `as any` or partial-type
 *      escape hatches).
 *
 * Hard rules:
 *   - This file does NOT modify `composio-skill-bridge.ts` or
 *     `composio-client.ts` — it is a structural guard only.
 *   - This file does NOT add new skill call sites.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Compile-time contract sentinel ──────────────────────────────────────
//
// Importing the contract module's sentinel keeps the type-level proofs in
// the typecheck graph. If the proofs fail, `pnpm typecheck` fails before
// this test ever runs — that is the primary defense. The runtime assertion
// here is just to make the linkage explicit and ensure the sentinel value
// is what we expect.

import { CONTRACT_VERIFIED } from "../services/skills/composio-skill-bridge.contract.ts";
import type { ComposioSkillBridgeContract } from "../services/skills/composio-skill-bridge.contract.ts";

// ─── Module-under-test imports ───────────────────────────────────────────

import * as ComposioSkillBridge from "../services/skills/composio-skill-bridge.ts";
import * as ComposioClient from "../services/composio-client.ts";

// ─── Path helpers ────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// `server/src/__tests__` → `server/src`
const SERVER_SRC = resolve(__dirname, "..");

describe("L2-D23: runComposioTool cross-org leak invariant (PR #30)", () => {
  // ─── Layer 1: compile-time contract linkage ────────────────────────────

  it("links to composio-skill-bridge.contract.ts (compile-time proofs)", () => {
    // If this import compiles, the contract proofs in
    // composio-skill-bridge.contract.ts compiled too — `connectedAccountId`
    // is still required + string. If the proofs ever flip to false,
    // `pnpm typecheck` fails before this assertion ever runs.
    expect(CONTRACT_VERIFIED).toBe(
      "composio-skill-bridge:L2-D23:cross-org-leak-closed",
    );

    // Type-level handle — confirms the contract type is exported.
    type _Contract = ComposioSkillBridgeContract;
    const _typeHandle: _Contract | undefined = undefined;
    void _typeHandle;
  });

  // ─── Layer 2: runtime function exists ──────────────────────────────────

  it("exposes runComposioTool as a callable function", () => {
    expect(typeof ComposioSkillBridge.runComposioTool).toBe("function");
    // Arity: { userId, connectedAccountId, toolName, input } — one params arg.
    expect(ComposioSkillBridge.runComposioTool.length).toBe(1);
  });

  // ─── Layer 3: runtime guard — empty connectedAccountId reaches client ──
  //
  // When the bridge is invoked with `connectedAccountId: ""` (an empty
  // string, the canonical fallback for nullable-resolved values), the
  // underlying Composio client MUST receive that exact value. The bridge
  // does NOT silently substitute a default — that would re-open the
  // cross-org leak by letting Composio fall back to "pick any active
  // connection for this user_id".

  describe("runtime: empty connectedAccountId is passed through unchanged", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      process.env.COMPOSIO_API_KEY = "test-api-key-for-contract-test";
      process.env.COMPOSIO_V3_READY = "1";
      ComposioClient._resetComposioClientForTests();
    });

    afterEach(() => {
      process.env = { ...originalEnv };
      ComposioClient._resetComposioClientForTests();
      vi.restoreAllMocks();
    });

    it("passes empty-string connectedAccountId through to the client (no silent default)", async () => {
      // Spy on the singleton's executeTool to capture what the bridge passes.
      const client = ComposioClient.getComposioClient();
      expect(client).not.toBeNull();
      const executeSpy = vi
        .spyOn(client!, "executeTool")
        .mockResolvedValue({ ok: true, output: {} });

      const result = await ComposioSkillBridge.runComposioTool({
        userId: "user-A",
        connectedAccountId: "",
        toolName: "slack_send_message",
        input: { channel: "C1", text: "hi" },
      });

      // The result is whatever executeTool returned — the bridge does not
      // inject any pre-flight rejection on empty string. (That is a
      // deliberate design choice — the TYPE enforces correctness; the
      // runtime stays thin. Pre-flight rejection here would let call sites
      // continue passing empty strings without fixing the upstream
      // resolution path.)
      expect(result).toEqual({ ok: true, output: {} });

      // Critical: the empty string is forwarded VERBATIM. If a future
      // refactor adds `connectedAccountId: input.connectedAccountId || undefined`
      // (i.e. silently drops empty strings), Composio falls back to
      // "pick any account for user_id" — the exact leak PR #30 closed.
      expect(executeSpy).toHaveBeenCalledTimes(1);
      const call = executeSpy.mock.calls[0]![0];
      expect(call).toMatchObject({
        userId: "user-A",
        toolName: "slack_send_message",
        params: { channel: "C1", text: "hi" },
        connectedAccountId: "",
      });
      // Belt-and-suspenders — assert the property is present (not just
      // matching) so a future refactor that drops the key on empty string
      // fails the test.
      expect(Object.prototype.hasOwnProperty.call(call, "connectedAccountId")).toBe(
        true,
      );
      expect(call.connectedAccountId).toBe("");
    });

    it("forwards a valid connectedAccountId through to the client", async () => {
      const client = ComposioClient.getComposioClient();
      expect(client).not.toBeNull();
      const executeSpy = vi
        .spyOn(client!, "executeTool")
        .mockResolvedValue({ ok: true, output: { ok: true } });

      await ComposioSkillBridge.runComposioTool({
        userId: "user-A",
        connectedAccountId: "ca_org_A_slack_123",
        toolName: "slack_send_message",
        input: { channel: "C1", text: "hi" },
      });

      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(executeSpy.mock.calls[0]![0]).toMatchObject({
        userId: "user-A",
        connectedAccountId: "ca_org_A_slack_123",
        toolName: "slack_send_message",
      });
    });
  });

  // ─── Layer 4: static survey of every call site ─────────────────────────
  //
  // Defense against future drift: any new file that imports `runComposioTool`
  // and calls it MUST pass `connectedAccountId:` in the call. The compiler
  // already enforces this (the field is required); the static survey is a
  // belt-and-suspenders against (a) `as any` escape hatches, (b) partial-
  // type assertions, (c) someone bypassing TS by going through a `Function`
  // reference. If a call site is added without `connectedAccountId:` (or
  // with a literal-empty / null / undefined value), this test fails with
  // the path of the offending file.

  describe("static survey: every runComposioTool() call site passes connectedAccountId", () => {
    /** Recursively collect every `.ts` file under a directory. */
    function listTsFiles(dir: string): string[] {
      const out: string[] = [];
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return out;
      }
      for (const entry of entries) {
        if (entry === "node_modules" || entry === "__tests__") continue;
        const full = join(dir, entry);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          out.push(...listTsFiles(full));
        } else if (
          st.isFile() &&
          (full.endsWith(".ts") || full.endsWith(".tsx")) &&
          !full.endsWith(".d.ts")
        ) {
          out.push(full);
        }
      }
      return out;
    }

    /**
     * Find every `runComposioTool({ ... })` call site. We're tolerant of
     * formatting: the regex matches `runComposioTool(` and we then scan
     * forward up to 1200 chars (well past any realistic call literal)
     * looking for the matching close-brace argument object.
     *
     * Returns an array of `{ file, lineNumber, body }` per call site.
     */
    function findCallSites(
      file: string,
    ): Array<{ file: string; lineNumber: number; body: string }> {
      const src = readFileSync(file, "utf-8");
      const hits: Array<{ file: string; lineNumber: number; body: string }> = [];

      // We want CALLS only, not the function DEFINITION. Skip the bridge
      // module's own definition line + the contract module.
      if (
        file.endsWith("composio-skill-bridge.ts") ||
        file.endsWith("composio-skill-bridge.contract.ts")
      ) {
        return hits;
      }

      // Find `runComposioTool(` followed by an argument object literal.
      // We tolerate whitespace and `await`/`const x =` prefixes since we
      // only care about what's INSIDE the parens.
      const re = /\brunComposioTool\s*\(/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(src)) !== null) {
        const start = match.index + match[0].length;
        // Scan forward extracting the balanced parenthesized expression.
        let depth = 1;
        let i = start;
        while (i < src.length && depth > 0) {
          const ch = src[i]!;
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
          if (depth === 0) break;
          i++;
        }
        const body = src.slice(start, i);
        const lineNumber = src.slice(0, match.index).split("\n").length;
        hits.push({ file, lineNumber, body });
      }
      return hits;
    }

    it("at least one call site exists (sanity check)", () => {
      const files = listTsFiles(SERVER_SRC);
      const allHits = files.flatMap(findCallSites);
      // Six skill call sites + one job call site = 7 expected at PR #30
      // verification time. Asserting `>= 6` keeps the test resilient if a
      // skill is consolidated or a new one is added; the per-site check
      // below is the real defense.
      expect(allHits.length).toBeGreaterThanOrEqual(6);
    });

    it("every call site passes `connectedAccountId:`", () => {
      const files = listTsFiles(SERVER_SRC);
      const allHits = files.flatMap(findCallSites);

      const failures: string[] = [];
      for (const hit of allHits) {
        // The call body must contain `connectedAccountId:` somewhere.
        // (Shorthand `{ connectedAccountId, ... }` is also valid; we
        // accept both colon-form and shorthand.)
        const hasColonForm = /\bconnectedAccountId\s*:/.test(hit.body);
        const hasShorthand =
          /[{,\s]connectedAccountId\s*[,}]/.test(hit.body) ||
          /[{,\s]connectedAccountId\s*$/.test(hit.body.trim());
        if (!hasColonForm && !hasShorthand) {
          failures.push(
            `${hit.file}:${hit.lineNumber} — runComposioTool() call missing connectedAccountId.\n` +
              `Body: ${hit.body.slice(0, 200)}`,
          );
        }
      }

      if (failures.length > 0) {
        throw new Error(
          `Cross-org leak invariant violated (PR #30) — ${failures.length} call site(s):\n\n` +
            failures.join("\n\n"),
        );
      }
    });

    it("no call site passes a literal-empty / null / undefined connectedAccountId", () => {
      const files = listTsFiles(SERVER_SRC);
      const allHits = files.flatMap(findCallSites);

      const suspicious: string[] = [];
      for (const hit of allHits) {
        // Match any of:
        //   connectedAccountId: ""
        //   connectedAccountId: ''
        //   connectedAccountId: null
        //   connectedAccountId: undefined
        // We do NOT flag variable references — those are checked by the
        // type system + caller-side resolution (e.g. evaluateComposioRoute
        // narrowing). This catches only LITERALLY-dead values.
        const literalEmptyRe =
          /\bconnectedAccountId\s*:\s*(?:""|''|null|undefined)\s*[,}\n]/;
        if (literalEmptyRe.test(hit.body)) {
          suspicious.push(
            `${hit.file}:${hit.lineNumber} — passes literally-empty connectedAccountId.\n` +
              `Body: ${hit.body.slice(0, 300)}`,
          );
        }
      }

      if (suspicious.length > 0) {
        throw new Error(
          `Cross-org leak invariant at risk — ${suspicious.length} call site(s) pass a literal-empty value:\n\n` +
            suspicious.join("\n\n"),
        );
      }
    });
  });
});
