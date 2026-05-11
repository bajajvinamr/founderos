/**
 * db-error-matchers.ts — assertion helpers for DB-driver errors.
 *
 * Background: starting with Drizzle 0.44.0, all errors thrown by the underlying
 * DB driver (e.g. `pg`) are wrapped in `DrizzleQueryError` whose `.message` is a
 * fixed `"Failed query: <sql>\nparams: <params>"` string. The original driver
 * error (which carries human-readable text like "duplicate key value violates
 * unique constraint", "foreign key violation", "check constraint ... violated")
 * is preserved on `.cause` (and recursively on `.cause.cause`).
 *
 * Tests asserting on those driver-level error messages must therefore walk the
 * error chain instead of matching `error.message` directly.
 *
 * Usage with `rejects`:
 *   await assertDbErrorMatches(
 *     db.execute(sql`...`),
 *     /duplicate key|unique/i,
 *   );
 */

import { expect } from "vitest";

export function dbErrorMessageMatches(err: unknown, pattern: RegExp): boolean {
  let current: unknown = err;
  // Cap recursion depth to avoid pathological cause loops.
  for (let i = 0; i < 8 && current; i++) {
    if (typeof current === "object" && current !== null) {
      const msg = (current as { message?: unknown }).message;
      if (typeof msg === "string" && pattern.test(msg)) return true;
      current = (current as { cause?: unknown }).cause;
    } else {
      return false;
    }
  }
  return false;
}

/**
 * Assert that the supplied promise rejects with an error whose `.message`, or
 * any `.cause.message` walking up to 8 levels deep, matches `pattern`.
 *
 * Equivalent to `await expect(promise).rejects.toThrow(/pattern/)` but unwraps
 * Drizzle's `DrizzleQueryError` so the underlying pg driver message is reached.
 */
export async function assertDbErrorMatches(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let caught: unknown;
  let threw = false;
  try {
    await promise;
  } catch (err) {
    threw = true;
    caught = err;
  }
  expect(threw, "expected promise to reject but it resolved").toBe(true);
  if (!dbErrorMessageMatches(caught, pattern)) {
    // Build a readable summary of the error chain.
    const chain: string[] = [];
    let current: unknown = caught;
    for (let i = 0; i < 8 && current; i++) {
      if (typeof current === "object" && current !== null) {
        const obj = current as { message?: unknown; code?: unknown; constraint?: unknown; cause?: unknown };
        chain.push(
          `[${i}] ${typeof obj.message === "string" ? obj.message : String(obj.message)}` +
            (obj.code ? ` code=${obj.code}` : "") +
            (obj.constraint ? ` constraint=${obj.constraint}` : ""),
        );
        current = obj.cause;
      } else {
        chain.push(`[${i}] (non-object)`);
        break;
      }
    }
    throw new Error(
      `expected error chain to match ${pattern} but got:\n${chain.join("\n")}`,
    );
  }
}
