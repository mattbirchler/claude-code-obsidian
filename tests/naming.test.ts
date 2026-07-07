import { describe, it, expect } from "vitest";
import { sanitizeName, noteBaseName } from "../src/naming";
import type { Session } from "../src/parser";

const session = (over: Partial<Session>): Session => ({
  id: "1a805d0c-97df-4f50-9307-819dd548ea1a",
  title: null,
  project: null,
  cwd: null,
  startedAt: null,
  updatedAt: null,
  turns: [],
  ...over,
});

describe("sanitizeName", () => {
  it("strips characters illegal on Windows and POSIX", () => {
    expect(sanitizeName('fix: the "big" <bug> / issue?')).toBe("fix the big bug issue");
  });

  it("collapses whitespace and strips trailing dots and spaces", () => {
    expect(sanitizeName("  hello   world... ")).toBe("hello world");
  });

  it("truncates to 80 characters", () => {
    expect(sanitizeName("x".repeat(120))).toHaveLength(80);
  });

  it("does not leave a trailing dot when truncation cuts at a dot", () => {
    expect(sanitizeName("A".repeat(79) + ".B")).toBe("A".repeat(79));
  });

  it("rejects Windows reserved names and empty results", () => {
    expect(sanitizeName("CON")).toBe("");
    expect(sanitizeName("com3")).toBe("");
    expect(sanitizeName("???")).toBe("");
  });
});

describe("noteBaseName", () => {
  it("uses date prefix plus sanitized title", () => {
    const s = session({ title: "Add retry to TTS call", startedAt: "2026-07-06T18:04:11Z" });
    expect(noteBaseName(s)).toBe("2026-07-06 Add retry to TTS call");
  });

  it("omits the date prefix when there is no startedAt", () => {
    expect(noteBaseName(session({ title: "Hello" }))).toBe("Hello");
  });

  it("falls back to the session UUID when title is missing or unusable", () => {
    expect(noteBaseName(session({}))).toBe("1a805d0c-97df-4f50-9307-819dd548ea1a");
    expect(noteBaseName(session({ title: "???" }))).toBe("1a805d0c-97df-4f50-9307-819dd548ea1a");
  });
});
