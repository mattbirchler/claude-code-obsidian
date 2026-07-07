import { describe, it, expect } from "vitest";
import { renderSession, RenderOptions } from "../src/renderer";
import type { Session, Turn } from "../src/parser";

const ALL: RenderOptions = { includeTools: true, includeThinking: true };

const turn = (over: Partial<Turn>): Turn => ({
  role: "user",
  timestamp: null,
  text: "",
  thinking: [],
  tools: [],
  ...over,
});

const session = (over: Partial<Session>): Session => ({
  id: "1a805d0c-97df-4f50-9307-819dd548ea1a",
  title: "Add retry to TTS call",
  project: "quickreads",
  cwd: "/Users/matt/Apps/quickreads",
  startedAt: "2026-07-06T18:04:11Z",
  updatedAt: "2026-07-06T18:05:30Z",
  turns: [],
  ...over,
});

describe("renderSession", () => {
  it("renders frontmatter with quoted values and the H1 title", () => {
    const md = renderSession(session({}), ALL);
    expect(md).toContain('session: "1a805d0c-97df-4f50-9307-819dd548ea1a"');
    expect(md).toContain('project: "quickreads"');
    expect(md).toContain('cwd: "/Users/matt/Apps/quickreads"');
    expect(md).toContain("date: 2026-07-06");
    expect(md).toContain('updated: "2026-07-06T18:05:30Z"');
    expect(md).toContain("source: claude-code");
    expect(md).toContain("# Add retry to TTS call");
    expect(md.startsWith("---\n")).toBe(true);
  });

  it("omits null frontmatter fields and falls back to a UUID-based H1", () => {
    const md = renderSession(
      session({ title: null, project: null, cwd: null, startedAt: null, updatedAt: null }),
      ALL
    );
    expect(md).not.toContain("project:");
    expect(md).not.toContain("cwd:");
    expect(md).toContain("# Session 1a805d0c");
  });

  it("renders speaker headings with times (UTC in tests)", () => {
    const md = renderSession(
      session({
        turns: [
          turn({ role: "user", text: "hi", timestamp: "2026-07-06T18:04:11Z" }),
          turn({ role: "assistant", text: "hello", timestamp: "2026-07-06T18:05:30Z" }),
        ],
      }),
      ALL
    );
    expect(md).toContain("## You · 18:04\n\nhi");
    expect(md).toContain("## Claude · 18:05\n\nhello");
  });

  it("renders tool calls as collapsed callouts with a path hint", () => {
    const md = renderSession(
      session({
        turns: [turn({ role: "assistant", tools: [{ name: "Edit", input: { file_path: "src/tts.ts", old: "a" } }] })],
      }),
      ALL
    );
    expect(md).toContain("> [!tool]- Edit src/tts.ts");
    expect(md).toContain('> {');
  });

  it("truncates tool bodies at 1000 characters", () => {
    const md = renderSession(
      session({
        turns: [turn({ role: "assistant", tools: [{ name: "Write", input: { content: "x".repeat(5000) } }] })],
      }),
      ALL
    );
    const body = md.split("[!tool]-")[1];
    expect(body.length).toBeLessThan(1200);
    expect(md).toContain("…");
  });

  it("renders thinking as collapsed callouts and respects both toggles", () => {
    const s = session({
      turns: [
        turn({
          role: "assistant",
          text: "answer",
          thinking: ["deep\nthought"],
          tools: [{ name: "Bash", input: { command: "ls" } }],
        }),
      ],
    });
    const withAll = renderSession(s, ALL);
    expect(withAll).toContain("> [!thinking]- Thinking\n> deep\n> thought");
    const without = renderSession(s, { includeTools: false, includeThinking: false });
    expect(without).not.toContain("[!thinking]-");
    expect(without).not.toContain("[!tool]-");
    expect(without).toContain("answer");
  });
});
