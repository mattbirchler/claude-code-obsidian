import { describe, it, expect } from "vitest";
import { SyncEngine, SyncState, VaultAdapter } from "../src/sync";
import type { SessionFile } from "../src/discovery";

class FakeVault implements VaultAdapter {
  files = new Map<string, string>();
  folders = new Set<string>();
  renames: Array<[string, string]> = [];

  exists(path: string): boolean {
    return this.files.has(path) || this.folders.has(path);
  }
  async createFolder(path: string): Promise<void> {
    this.folders.add(path);
  }
  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async rename(oldPath: string, newPath: string): Promise<void> {
    const content = this.files.get(oldPath);
    if (content !== undefined) {
      this.files.delete(oldPath);
      this.files.set(newPath, content);
    }
    this.renames.push([oldPath, newPath]);
  }
}

const SETTINGS = { targetFolder: "Claude Code", includeTools: true, includeThinking: true };

const sessionJsonl = (title: string | null) =>
  [
    title ? JSON.stringify({ type: "ai-title", aiTitle: title }) : null,
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-06T18:04:11Z",
      cwd: "/Users/u/code/myproj",
      message: { role: "user", content: "hello" },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-06T18:05:00Z",
      cwd: "/Users/u/code/myproj",
      message: { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    }),
  ]
    .filter(Boolean)
    .join("\n");

const file = (over: Partial<SessionFile> = {}): SessionFile => ({
  path: "/src/proj/abc-123.jsonl",
  sessionId: "abc-123",
  projectFolder: "-Users-u-code-myproj",
  mtimeMs: 1000,
  ...over,
});

describe("SyncEngine.run", () => {
  it("writes a new note and creates folders", async () => {
    const vault = new FakeVault();
    const engine = new SyncEngine(vault, () => sessionJsonl("Fix the bug"));
    const state: SyncState = {};
    const result = await engine.run([file()], SETTINGS, state);

    expect(result).toMatchObject({ synced: 1, skipped: 0, errors: [] });
    const notePath = "Claude Code/myproj/2026-07-06 Fix the bug.md";
    expect(vault.folders.has("Claude Code")).toBe(true);
    expect(vault.folders.has("Claude Code/myproj")).toBe(true);
    expect(vault.files.get(notePath)).toContain("# Fix the bug");
    expect(state["/src/proj/abc-123.jsonl"]).toEqual({ mtimeMs: 1000, notePath });
  });

  it("skips files whose mtime has not advanced", async () => {
    const vault = new FakeVault();
    const engine = new SyncEngine(vault, () => sessionJsonl("Fix the bug"));
    const state: SyncState = {
      "/src/proj/abc-123.jsonl": { mtimeMs: 1000, notePath: "x.md" },
    };
    const result = await engine.run([file({ mtimeMs: 1000 })], SETTINGS, state);
    expect(result).toMatchObject({ synced: 0, skipped: 1 });
    expect(vault.files.size).toBe(0);
  });

  it("records empty sessions without writing a note", async () => {
    const vault = new FakeVault();
    const onlyUser = JSON.stringify({
      type: "user",
      message: { role: "user", content: "hi" },
    });
    const engine = new SyncEngine(vault, () => onlyUser);
    const state: SyncState = {};
    const result = await engine.run([file()], SETTINGS, state);
    expect(result).toMatchObject({ synced: 0, skipped: 1 });
    expect(vault.files.size).toBe(0);
    expect(state["/src/proj/abc-123.jsonl"].mtimeMs).toBe(1000);
  });

  it("renames the note when a title appears later", async () => {
    const vault = new FakeVault();
    let jsonl = sessionJsonl(null); // no title yet -> UUID filename
    const engine = new SyncEngine(vault, () => jsonl);
    const state: SyncState = {};
    await engine.run([file({ mtimeMs: 1000 })], SETTINGS, state);
    expect(vault.files.has("Claude Code/myproj/abc-123.md")).toBe(true);

    jsonl = sessionJsonl("Fix the bug"); // title arrived
    await engine.run([file({ mtimeMs: 2000 })], SETTINGS, state);
    const newPath = "Claude Code/myproj/2026-07-06 Fix the bug.md";
    expect(vault.renames).toEqual([["Claude Code/myproj/abc-123.md", newPath]]);
    expect(vault.files.has("Claude Code/myproj/abc-123.md")).toBe(false);
    expect(vault.files.get(newPath)).toContain("# Fix the bug");
  });

  it("suffixes the filename when another session already claimed it", async () => {
    const vault = new FakeVault();
    const engine = new SyncEngine(vault, () => sessionJsonl("Fix the bug"));
    const state: SyncState = {
      "/src/proj/other.jsonl": {
        mtimeMs: 500,
        notePath: "Claude Code/myproj/2026-07-06 Fix the bug.md",
      },
    };
    await engine.run([file()], SETTINGS, state);
    expect(
      vault.files.has("Claude Code/myproj/2026-07-06 Fix the bug (abc-123).md")
    ).toBe(true);
  });

  it("suffixes the filename when an untracked vault note occupies the target path", async () => {
    const vault = new FakeVault();
    const notePath = "Claude Code/myproj/2026-07-06 Fix the bug.md";
    vault.files.set(notePath, "sentinel: pre-existing user note");
    const engine = new SyncEngine(vault, () => sessionJsonl("Fix the bug"));
    const state: SyncState = {};
    const result = await engine.run([file()], SETTINGS, state);

    expect(result).toMatchObject({ synced: 1, skipped: 0, errors: [] });
    expect(vault.files.get(notePath)).toBe("sentinel: pre-existing user note");
    const suffixedPath = "Claude Code/myproj/2026-07-06 Fix the bug (abc-123).md";
    expect(vault.files.has(suffixedPath)).toBe(true);
    expect(vault.files.get(suffixedPath)).toContain("# Fix the bug");
  });

  it("re-syncing the same session over its own existing note keeps the same path with no suffix", async () => {
    const vault = new FakeVault();
    const notePath = "Claude Code/myproj/2026-07-06 Fix the bug.md";
    const engine = new SyncEngine(vault, () => sessionJsonl("Fix the bug"));
    const state: SyncState = {
      "/src/proj/abc-123.jsonl": { mtimeMs: 1000, notePath },
    };
    vault.files.set(notePath, "old content");

    const result = await engine.run([file({ mtimeMs: 2000 })], SETTINGS, state);
    expect(result).toMatchObject({ synced: 1, skipped: 0, errors: [] });
    expect(vault.files.has(notePath)).toBe(true);
    expect(vault.files.get(notePath)).toContain("# Fix the bug");
    expect(vault.files.has("Claude Code/myproj/2026-07-06 Fix the bug (abc-123).md")).toBe(false);
  });

  it("continues past per-file errors and reports them", async () => {
    const vault = new FakeVault();
    const engine = new SyncEngine(vault, (path) => {
      if (path.includes("bad")) throw new Error("EACCES");
      return sessionJsonl("Good one");
    });
    const state: SyncState = {};
    const result = await engine.run(
      [file({ path: "/src/proj/bad.jsonl", sessionId: "bad" }), file()],
      SETTINGS,
      state
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("bad.jsonl");
    expect(result.synced).toBe(1);
  });
});
