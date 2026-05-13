/**
 * Structural contract tests for the content-publish-tick userId resolution —
 * Loop 2 ticket L2-A10 sibling to L2-D23.
 *
 * Background:
 *   PR #30 closed the cross-org leak on Composio's `connectedAccountId`
 *   field. The OTHER axis Composio v3 uses for per-account routing is
 *   `userId` — Composio uses it for OAuth-scoped tools (Gmail "send as me",
 *   LinkedIn "post as me"). Passing `userId: ""` silently downgrades to
 *   "any account for any user" — the same failure shape PR #30 closed.
 *
 *   L2-A10 closes this gap in content-publish-tick.ts (which previously had
 *   a `userId: ""` TODO). This contract test asserts:
 *
 *   1. RUNTIME: `runComposioTool` continues to forward an empty userId
 *      VERBATIM to the underlying client — the bridge does NOT silently
 *      substitute a default. (Same defense as L2-D23 for connectedAccountId.
 *      The TYPE enforces correctness at compile time; the runtime stays
 *      thin so the responsibility lives with the caller's resolver.)
 *
 *   2. STATIC SURVEY: No call site in the server source tree passes a
 *      literal-empty `userId`. This catches future regressions where
 *      someone forgets to wire up the resolver and falls back to "".
 *
 * Hard rules:
 *   - This test does NOT modify `composio-skill-bridge.ts` or
 *     `composio-client.ts` — those are reviewed-locked by PR #223.
 *   - This test is a STRUCTURAL guard; it does not add or remove call sites.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as ComposioSkillBridge from "../services/skills/composio-skill-bridge.js";
import * as ComposioClient from "../services/composio-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// `server/src/__tests__` → `server/src`
const SERVER_SRC = resolve(__dirname, "..");

describe("L2-A10: runComposioTool empty-userId defense", () => {
  // ─── Runtime: empty userId is forwarded verbatim ──────────────────────
  describe("runtime: empty userId is passed through unchanged", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      process.env.COMPOSIO_API_KEY = "test-api-key-for-userid-contract";
      process.env.COMPOSIO_V3_READY = "1";
      ComposioClient._resetComposioClientForTests();
    });

    afterEach(() => {
      process.env = { ...originalEnv };
      ComposioClient._resetComposioClientForTests();
      vi.restoreAllMocks();
    });

    it("forwards empty-string userId to the client without silent default", async () => {
      const client = ComposioClient.getComposioClient();
      expect(client).not.toBeNull();
      const executeSpy = vi
        .spyOn(client!, "executeTool")
        .mockResolvedValue({ ok: true, output: {} });

      await ComposioSkillBridge.runComposioTool({
        userId: "",
        connectedAccountId: "ca_org_A_linkedin_123",
        toolName: "linkedin_post_content",
        input: { content: "hi" },
      });

      expect(executeSpy).toHaveBeenCalledTimes(1);
      const call = executeSpy.mock.calls[0]![0];
      // The bridge MUST NOT inject a default for empty userId. If a
      // future refactor adds `userId: input.userId || someDefault`, the
      // call site loses the ability to fail fast — silent routing to a
      // "default" user is the same shape as the cross-org leak.
      expect(call).toMatchObject({
        userId: "",
        connectedAccountId: "ca_org_A_linkedin_123",
        toolName: "linkedin_post_content",
      });
      expect(Object.prototype.hasOwnProperty.call(call, "userId")).toBe(true);
      expect(call.userId).toBe("");
    });

    it("forwards a real userId verbatim", async () => {
      const client = ComposioClient.getComposioClient();
      expect(client).not.toBeNull();
      const executeSpy = vi
        .spyOn(client!, "executeTool")
        .mockResolvedValue({ ok: true, output: {} });

      await ComposioSkillBridge.runComposioTool({
        userId: "user-A",
        connectedAccountId: "ca_org_A_linkedin_123",
        toolName: "linkedin_post_content",
        input: { content: "hi" },
      });

      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(executeSpy.mock.calls[0]![0]).toMatchObject({
        userId: "user-A",
        connectedAccountId: "ca_org_A_linkedin_123",
      });
    });
  });

  // ─── Static survey: no call site passes a literal-empty userId ────────
  describe("static survey: no runComposioTool() call site passes a literal-empty userId", () => {
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
     * Find every `runComposioTool({ ... })` call site by extracting the
     * balanced parenthesized expression after the function name. Skips
     * the bridge module's own definition.
     */
    function findCallSites(
      file: string,
    ): Array<{ file: string; lineNumber: number; body: string }> {
      const src = readFileSync(file, "utf-8");
      const hits: Array<{ file: string; lineNumber: number; body: string }> = [];

      if (
        file.endsWith("composio-skill-bridge.ts") ||
        file.endsWith("composio-skill-bridge.contract.ts")
      ) {
        return hits;
      }

      const re = /\brunComposioTool\s*\(/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(src)) !== null) {
        const start = match.index + match[0].length;
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

    it("at least one call site exists (sanity)", () => {
      const files = listTsFiles(SERVER_SRC);
      const allHits = files.flatMap(findCallSites);
      // 6 skills + 1 job = 7 expected at L2-A10 close time.
      expect(allHits.length).toBeGreaterThanOrEqual(6);
    });

    it("no call site passes literal-empty userId (\"\" / '' / null / undefined)", () => {
      const files = listTsFiles(SERVER_SRC);
      const allHits = files.flatMap(findCallSites);

      const suspicious: string[] = [];
      for (const hit of allHits) {
        // We only flag LITERAL empty values, not nullable variable
        // references — those are checked by the type system and the
        // caller-side resolver. This catches drift like a fresh skill
        // copy-pasting `userId: ""` from old docs.
        const literalEmptyRe =
          /\buserId\s*:\s*(?:""|''|null|undefined)\s*[,}\n]/;
        if (literalEmptyRe.test(hit.body)) {
          suspicious.push(
            `${hit.file}:${hit.lineNumber} — runComposioTool() passes a literal-empty userId.\n` +
              `Body: ${hit.body.slice(0, 300)}`,
          );
        }
      }

      if (suspicious.length > 0) {
        throw new Error(
          `Per-user routing invariant at risk — ${suspicious.length} call site(s):\n\n` +
            suspicious.join("\n\n"),
        );
      }
    });
  });
});
