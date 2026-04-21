import { describe, expect, it } from "vitest";
import { parseFounderNotes } from "./OneOnOneDrawer";

describe("parseFounderNotes", () => {
  it("returns empty array for empty string", () => {
    expect(parseFounderNotes("")).toEqual([]);
  });

  it("returns empty array when no founder_note blocks exist", () => {
    expect(parseFounderNotes("You are a helpful assistant.")).toEqual([]);
  });

  it("parses a single founder_note block", () => {
    const template = `Base prompt.\n<founder_note added="2026-04-19T10:00:00.000Z">\nFocus on Acme onboarding.\n</founder_note>`;
    const notes = parseFounderNotes(template);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toBe("Focus on Acme onboarding.");
    expect(notes[0]?.added).toEqual(new Date("2026-04-19T10:00:00.000Z"));
  });

  it("parses multiple founder_note blocks and returns newest first", () => {
    const template = [
      "<founder_note added=\"2026-04-01T00:00:00.000Z\">",
      "First note.",
      "</founder_note>",
      "<founder_note added=\"2026-04-19T00:00:00.000Z\">",
      "Second note.",
      "</founder_note>",
    ].join("\n");

    const notes = parseFounderNotes(template);
    expect(notes).toHaveLength(2);
    // Newest first
    expect(notes[0]?.body).toBe("Second note.");
    expect(notes[1]?.body).toBe("First note.");
  });

  it("handles multiline note bodies", () => {
    const template = `<founder_note added="2026-04-19T00:00:00.000Z">\nLine one.\nLine two.\n</founder_note>`;
    const notes = parseFounderNotes(template);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toBe("Line one.\nLine two.");
  });

  it("returns empty array for malformed XML gracefully", () => {
    // No closing tag
    const broken = `<founder_note added="2026-04-19T00:00:00.000Z">Unclosed note`;
    expect(parseFounderNotes(broken)).toEqual([]);
  });

  it("skips blocks with invalid timestamps", () => {
    const template = `<founder_note added="not-a-date">\nSome note.\n</founder_note>`;
    expect(parseFounderNotes(template)).toEqual([]);
  });

  it("skips blocks with empty body", () => {
    const template = `<founder_note added="2026-04-19T00:00:00.000Z">\n\n\n</founder_note>`;
    expect(parseFounderNotes(template)).toEqual([]);
  });
});
