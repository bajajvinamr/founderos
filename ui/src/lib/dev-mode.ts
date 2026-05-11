/**
 * Single source of truth for "is this a dev build" detection.
 *
 * Exists as a separate module so unit tests can mock the result via
 * `vi.mock("./lib/dev-mode")` without juggling Vite's frozen
 * `import.meta.env` (vitest's `vi.stubEnv` only mutates `process.env`).
 *
 * Used by:
 *   - `WorktreeBanner` (P3 Wave 1 OQ-6 — banner hides outside dev)
 */
export function isDevBuild(): boolean {
  return import.meta.env.DEV === true;
}
