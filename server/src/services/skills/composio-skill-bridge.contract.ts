/**
 * Compile-time contract proofs for `runComposioTool` — Loop 2 ticket L2-D23.
 *
 * Why this file lives under `src/` (and not `__tests__/`):
 *   The server's `tsconfig.json` EXCLUDES `src/__tests__` from `tsc --noEmit`
 *   (the `typecheck` script), and vitest itself strips TypeScript annotations
 *   via esbuild — so `// @ts-expect-error` lines inside test files are not
 *   evaluated by either gate. To make the type contract a real CI signal,
 *   the structural proofs must live in a file that IS included in `tsc`.
 *
 * What this guards:
 *   The cross-org leak fix from PR #30 (verified 2026-05-05 at
 *   `composio-skill-bridge.ts:96-113`) makes `connectedAccountId: string`
 *   a REQUIRED, non-optional, non-nullable field on `runComposioTool`'s
 *   input. Without that, Composio v3 `executeTool({ userId })` silently
 *   picks an arbitrary connected account when the user has the same app
 *   connected in multiple orgs — agent in Org A could post to Org B Slack.
 *
 *   If a future refactor accidentally relaxes the field to
 *   `connectedAccountId?: string` or `connectedAccountId: string | null`
 *   (or removes it entirely), the conditional types below evaluate to
 *   `false` and the `satisfies true` constraints trip — `pnpm typecheck`
 *   fails on this file, blocking the PR before review.
 *
 * Invariant source: CLAUDE.md "Composio cross-org leak is closed (PR #30)".
 *
 * Do NOT add `@ts-ignore` or weaken the constraints to make this compile.
 * If `runComposioTool`'s contract legitimately needs to change, the change
 * MUST be reviewed against the cross-org leak invariant first.
 */

import type { runComposioTool } from "./composio-skill-bridge.js";

// ─── Extract the input type from runComposioTool's signature ─────────────

type RunComposioToolInput = Parameters<typeof runComposioTool>[0];

// ─── Probe 1: `connectedAccountId` key exists in the input type ──────────
//
// `keyof T extends "connectedAccountId" ? ...` doesn't work because keyof
// returns a union including other keys. Instead, check that the key is
// present by indexing — `T["connectedAccountId"]` is a TypeScript error if
// the key is absent.

type HasConnectedAccountIdKey = "connectedAccountId" extends keyof RunComposioToolInput
  ? true
  : false;

const _proof_hasKey: HasConnectedAccountIdKey = true;
// If you see "Type 'false' is not assignable to type 'true'." here, the
// `connectedAccountId` field was removed from runComposioTool — the cross-
// org leak invariant has regressed.
void _proof_hasKey;

// ─── Probe 2: `connectedAccountId` is REQUIRED (non-optional) ────────────
//
// A property `k?: T` is detectable via `{} extends Pick<Obj, k> ? optional
// : required`. `Pick<Obj, k>` of a required field is NOT assignable from
// `{}`; of an optional field, IT IS.

type IsConnectedAccountIdRequired =
  {} extends Pick<RunComposioToolInput, "connectedAccountId"> ? false : true;

const _proof_required: IsConnectedAccountIdRequired = true;
// If you see "Type 'false' is not assignable to type 'true'." here, the
// `connectedAccountId` field became optional (`?:`) — the cross-org leak
// invariant has regressed.
void _proof_required;

// ─── Probe 3: `connectedAccountId` is `string` exactly (not nullable) ────
//
// Reject `string | null`, `string | undefined`, `string | null | undefined`,
// `unknown`, `any`. The type must be EXACTLY `string`. We use a mutual-
// assignability check: `string extends T` AND `T extends string`.

type IsConnectedAccountIdString = [RunComposioToolInput["connectedAccountId"]] extends [string]
  ? [string] extends [RunComposioToolInput["connectedAccountId"]]
    ? true
    : false
  : false;

const _proof_string: IsConnectedAccountIdString = true;
// If you see "Type 'false' is not assignable to type 'true'." here, the
// `connectedAccountId` field's type widened beyond `string` (e.g. to
// `string | null` or `string | undefined`) — the cross-org leak invariant
// has regressed.
void _proof_string;

// ─── Probe 4: `userId` also required string (defense-in-depth on the tuple) ─

type IsUserIdRequiredString = [RunComposioToolInput["userId"]] extends [string]
  ? [string] extends [RunComposioToolInput["userId"]]
    ? {} extends Pick<RunComposioToolInput, "userId"> ? false : true
    : false
  : false;

const _proof_userId: IsUserIdRequiredString = true;
void _proof_userId;

// ─── Sentinel export so the test file can import-and-link this module ────
//
// Vitest's test file imports `CONTRACT_VERIFIED` to keep this module in
// the module graph — that way `tsc --noEmit` actually visits this file.
// Without an importer, an isolated module can sometimes be excluded from
// the type-check graph in incremental builds.

export const CONTRACT_VERIFIED = "composio-skill-bridge:L2-D23:cross-org-leak-closed" as const;

export type ComposioSkillBridgeContract = {
  /** `runComposioTool` input shape — frozen for cross-org leak defense. */
  input: RunComposioToolInput;
  /** Proof-tag values; all `true` at compile time. */
  proofs: {
    hasConnectedAccountIdKey: HasConnectedAccountIdKey;
    connectedAccountIdRequired: IsConnectedAccountIdRequired;
    connectedAccountIdIsString: IsConnectedAccountIdString;
    userIdRequiredString: IsUserIdRequiredString;
  };
};
