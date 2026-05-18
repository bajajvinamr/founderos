#!/usr/bin/env node
// Anthropic API HTTP wrapper -- placeholder for future subprocess-bridge use.
// Phase 1 (2026-05-18) ships execute() as an in-process SDK call; the `bin`
// entry exists so the package's `bin` field resolves and remains aligned
// with the sibling openai-api package shape.

console.error("[anthropic-api-runner] in-process adapter -- no subprocess bridge configured");
process.exit(2);
