import { describe, it, expect } from "vitest";
import { parseSession, hasConversation } from "../src/parser";

const line = (obj: unknown) => JSON.stringify(obj);

const userLine = (content: unknown, extra: Record<string, unknown> = {}) =>
  line({
    type: "user",
    uuid: "u1",
    timestamp: "2026-07-06T18:04:11Z",
    cwd: "/Users/matt/Apps/Quick Reads",
    sessionId: "s1",
    message: { role: "user", content },
    ...extra,
  });

const assistantLine = (content: unknown, extra: Record<string, unknown> = {}) =>
  line({
    type: "assistant",
    uuid: "a1",
    timestamp: "2026-07-06T18:05:30Z",
    cwd: "/Users/matt/Apps/Quick Reads",
    sessionId: "s1",
    message: { role: "assistant", content },
    ...extra,
  });

describe("parseSession", () => {
  it("parses string user content and block assistant content into turns", () => {
    const jsonl = [
      userLine("add a retry to the TTS call"),
      assistantLine([{ type: "text", text: "Done, wrapped it in a backoff loop." }]),
    ].join("\n");
    const s = parseSession(jsonl, "s1", "fallback");
    expect(s.turns).toHaveLength(2);
    expect(s.turns[0]).toMatchObject({ role: "user", text: "add a retry to the TTS call" });
    expect(s.turns[1]).toMatchObject({ role: "assistant", text: "Done, wrapped it in a backoff loop." });
  });

  it("takes title from ai-title, falling back to summary", () => {
    const withBoth = [
      line({ type: "summary", summary: "Summary title" }),
      line({ type: "ai-title", aiTitle: "AI title" }),
    ].join("\n");
    expect(parseSession(withBoth, "s1", "p").title).toBe("AI title");
    const onlySummary = line({ type: "summary", summary: "Summary title" });
    expect(parseSession(onlySummary, "s1", "p").title).toBe("Summary title");
    expect(parseSession(userLine("hi"), "s1", "p").title).toBeNull();
  });

  it("derives project and cwd from the cwd field, not the folder name", () => {
    const s = parseSession(userLine("hi"), "s1", "-Users-matt-Apps-Quick-Reads");
    expect(s.cwd).toBe("/Users/matt/Apps/Quick Reads");
    expect(s.project).toBe("Quick Reads");
  });

  it("falls back to the folder name for project when no cwd exists", () => {
    const noCwd = line({ type: "user", message: { role: "user", content: "hi" } });
    const s = parseSession(noCwd, "s1", "-Users-matt-code-thing");
    expect(s.project).toBe("-Users-matt-code-thing");
  });

  it("skips sidechain lines, housekeeping types, and malformed lines", () => {
    const jsonl = [
      line({ type: "mode", mode: "normal" }),
      line({ type: "file-history-snapshot", snapshot: {} }),
      "{not valid json",
      userLine("real message"),
      userLine("subagent message", { isSidechain: true }),
      assistantLine([{ type: "text", text: "reply" }], { isSidechain: true }),
    ].join("\n");
    const s = parseSession(jsonl, "s1", "p");
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0].text).toBe("real message");
  });

  it("strips system-reminder blocks and drops turns left empty", () => {
    const jsonl = [
      userLine("<system-reminder>injected\nnoise</system-reminder>hello"),
      userLine("<system-reminder>only noise</system-reminder>"),
    ].join("\n");
    const s = parseSession(jsonl, "s1", "p");
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0].text).toBe("hello");
  });

  it("skips lines with isMeta: true", () => {
    const jsonl = [
      userLine("skill injection payload", { isMeta: true }),
      userLine("real message"),
      assistantLine([{ type: "text", text: "reply" }]),
    ].join("\n");
    const s = parseSession(jsonl, "s1", "p");
    expect(s.turns).toHaveLength(2);
    expect(s.turns[0]).toMatchObject({ role: "user", text: "real message" });
    expect(s.turns[1]).toMatchObject({ role: "assistant", text: "reply" });
  });

  it("strips command markup and drops command-only turns", () => {
    const commandOnly = userLine(
      "<command-name>/sync</command-name><command-message>sync</command-message><command-args></command-args>"
    );
    const s = parseSession(commandOnly, "s1", "p");
    expect(s.turns).toHaveLength(0);

    const jsonl = [commandOnly, assistantLine([{ type: "text", text: "reply" }])].join("\n");
    const withReply = parseSession(jsonl, "s1", "p");
    expect(hasConversation(withReply)).toBe(false);
  });

  it("strips local-command-stdout markup", () => {
    const jsonl = userLine("<local-command-stdout>some output</local-command-stdout>real question");
    const s = parseSession(jsonl, "s1", "p");
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0].text).toBe("real question");
  });

  it("captures thinking and tool_use blocks, ignores tool_result", () => {
    const jsonl = [
      assistantLine([
        { type: "thinking", thinking: "Let me consider..." },
        { type: "text", text: "Here is the fix." },
        { type: "tool_use", name: "Edit", input: { file_path: "src/tts.ts" } },
      ]),
      userLine([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
    ].join("\n");
    const s = parseSession(jsonl, "s1", "p");
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0].thinking).toEqual(["Let me consider..."]);
    expect(s.turns[0].tools).toEqual([{ name: "Edit", input: { file_path: "src/tts.ts" } }]);
  });

  it("drops empty thinking blocks", () => {
    const jsonl = assistantLine([
      { type: "thinking", thinking: "" },
      { type: "text", text: "answer" },
    ]);
    const s = parseSession(jsonl, "s1", "p");
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0].thinking).toEqual([]);
    expect(s.turns[0].text).toBe("answer");
  });

  it("tracks startedAt and updatedAt from first and last turns", () => {
    const jsonl = [
      userLine("first"),
      assistantLine([{ type: "text", text: "reply" }]),
    ].join("\n");
    const s = parseSession(jsonl, "s1", "p");
    expect(s.startedAt).toBe("2026-07-06T18:04:11Z");
    expect(s.updatedAt).toBe("2026-07-06T18:05:30Z");
  });
});

describe("hasConversation", () => {
  it("requires at least one user and one assistant turn", () => {
    const both = parseSession(
      [userLine("hi"), assistantLine([{ type: "text", text: "hello" }])].join("\n"),
      "s1", "p"
    );
    const userOnly = parseSession(userLine("hi"), "s1", "p");
    const empty = parseSession(line({ type: "mode", mode: "normal" }), "s1", "p");
    expect(hasConversation(both)).toBe(true);
    expect(hasConversation(userOnly)).toBe(false);
    expect(hasConversation(empty)).toBe(false);
  });
});
