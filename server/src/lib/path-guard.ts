/**
 * Path traversal guard.
 *
 * Use `assertResolvedInside(baseDir, candidate)` whenever a code path joins
 * an untrusted segment onto a known base directory and then reads or writes
 * the result. The guard resolves both paths to absolutes and rejects any
 * `candidate` that escapes `baseDir` via `..`, an absolute override, or a
 * sibling directory whose name happens to share a prefix (e.g.
 * `/base-evil` should NOT match `/base`).
 *
 * Intended for CodeQL `js/path-injection` (clusters K/L/M).
 */

import path from "node:path";

/**
 * Resolve `candidate` against `baseDir` and assert the result stays inside
 * `baseDir`. Returns the absolute resolved path on success.
 *
 * Allowed:
 *   - `(/base, "child")`           -> `/base/child`
 *   - `(/base, "child/grandchild") -> `/base/child/grandchild`
 *   - `(/base, ".")`               -> `/base` (equals base)
 *   - `(/base, "child/..")`        -> `/base` (equals base)
 *
 * Rejected (throws):
 *   - `(/base, "../escape")`        -> escapes via `..`
 *   - `(/base, "/abs/escape")`      -> absolute override outside base
 *   - `(/base, "child/../../esc")`  -> escapes via deep `..`
 *   - `(/base, "../base-evil/foo")` -> `/base-evil/foo` shares the `/base` prefix
 *                                       but is NOT inside `/base` (path.sep anchor)
 */
export function assertResolvedInside(baseDir: string, candidate: string): string {
  const absBase = path.resolve(baseDir);
  const absCandidate = path.resolve(absBase, candidate);
  // The `path.sep` anchor is load-bearing: without it `/base-evil` would
  // pass a naive `startsWith("/base")` check.
  if (absCandidate !== absBase && !absCandidate.startsWith(absBase + path.sep)) {
    throw new Error(`path traversal blocked: ${candidate} escapes ${baseDir}`);
  }
  return absCandidate;
}
