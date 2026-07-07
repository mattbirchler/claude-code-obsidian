import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { expandHome, findSessionFiles } from "../src/discovery";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ccs-test-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("expandHome", () => {
  it("expands ~ and ~/ against the given homedir", () => {
    expect(expandHome("~", "/home/u")).toBe("/home/u");
    expect(expandHome("~/.claude/projects", "/home/u")).toBe(
      path.join("/home/u", ".claude/projects")
    );
  });

  it("leaves absolute paths alone", () => {
    expect(expandHome("/opt/claude", "/home/u")).toBe("/opt/claude");
  });
});

describe("findSessionFiles", () => {
  it("finds .jsonl files across project folders with ids and folder names", () => {
    fs.mkdirSync(path.join(root, "-Users-u-proj-a"));
    fs.mkdirSync(path.join(root, "-Users-u-proj-b"));
    fs.writeFileSync(path.join(root, "-Users-u-proj-a", "abc-123.jsonl"), "{}\n");
    fs.writeFileSync(path.join(root, "-Users-u-proj-b", "def-456.jsonl"), "{}\n");
    fs.writeFileSync(path.join(root, "-Users-u-proj-b", "notes.txt"), "ignore me");
    fs.mkdirSync(path.join(root, "-Users-u-proj-a", "memory")); // non-jsonl dir content

    const files = findSessionFiles(root, "/home/u");
    expect(files).toHaveLength(2);
    const byId = Object.fromEntries(files.map((f) => [f.sessionId, f]));
    expect(byId["abc-123"].projectFolder).toBe("-Users-u-proj-a");
    expect(byId["def-456"].projectFolder).toBe("-Users-u-proj-b");
    expect(byId["abc-123"].mtimeMs).toBeGreaterThan(0);
    expect(fs.existsSync(byId["abc-123"].path)).toBe(true);
  });

  it("returns [] when the source path does not exist", () => {
    expect(findSessionFiles(path.join(root, "nope"), "/home/u")).toEqual([]);
  });

  it("ignores plain files at the top level", () => {
    fs.writeFileSync(path.join(root, "stray.jsonl"), "{}\n");
    expect(findSessionFiles(root, "/home/u")).toEqual([]);
  });
});
