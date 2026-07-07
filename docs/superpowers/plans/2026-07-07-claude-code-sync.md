# Claude Code Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Obsidian desktop plugin that mirrors every Claude Code session (`~/.claude/projects/**/*.jsonl`) into the vault as read-only Markdown notes, synced on launch and on a configurable interval.

**Architecture:** Pure-function core (`parser`, `renderer`, `naming` — no Obsidian imports, fully unit-tested with vitest) fed by a Node-`fs` `discovery` module, orchestrated by a `SyncEngine` that talks to the vault only through a small `VaultAdapter` interface (tested against an in-memory fake). `main.ts` wires the engine to the real Obsidian API, settings, ribbon/command, and interval.

**Tech Stack:** TypeScript, esbuild (Obsidian sample-plugin toolchain), vitest, Node `fs`/`os`/`path`, Obsidian Plugin API.

**Spec:** `docs/superpowers/specs/2026-07-07-claude-code-sync-design.md` — read it before starting.

## Global Constraints

- Desktop only: `"isDesktopOnly": true` in `manifest.json`.
- Wide distribution: nothing hardcoded to one machine or OS. `~` expanded via `os.homedir()`; filename sanitization covers macOS/Linux and Windows rules.
- All vault writes go through the Vault API (via `VaultAdapter`), never raw `fs`. Raw `fs` is read-only, for the source `.jsonl` files.
- Parser guards every field access; malformed lines and unknown line types are skipped silently, never fatal.
- Notes are a read-only mirror: fully regenerated on every sync of a changed file.
- `parser.ts`, `renderer.ts`, `naming.ts`, `sync.ts`, `discovery.ts` must not import from the `obsidian` package (they must run under vitest).
- Tool callout bodies truncate at 1,000 characters; filenames truncate at 80 characters.
- Plugin id: `claude-code-sync`. Settings defaults: source `~/.claude/projects`, target folder `Claude Code`, interval 5 minutes (0 = manual only), tool calls on, thinking on.

---

### Task 1: Scaffold the plugin project

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `manifest.json`, `versions.json`, `.gitignore`, `src/main.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a building TypeScript project. `npm run build` emits `main.js`; `npm test` runs vitest. Later tasks add files under `src/` and `tests/`.

- [ ] **Step 1: Write the project files**

`package.json`:

```json
{
  "name": "claude-code-sync",
  "version": "0.1.0",
  "description": "Mirror Claude Code sessions into your Obsidian vault as Markdown.",
  "main": "main.js",
  "scripts": {
    "build": "tsc -noEmit -skipLibCheck && node esbuild.config.mjs production",
    "dev": "node esbuild.config.mjs",
    "test": "TZ=UTC vitest run"
  },
  "keywords": ["obsidian", "claude-code"],
  "license": "MIT",
  "devDependencies": {
    "@types/node": "^20.11.0",
    "builtin-modules": "^3.3.0",
    "esbuild": "^0.21.0",
    "obsidian": "latest",
    "tslib": "^2.6.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "module": "ESNext",
    "target": "ES2020",
    "moduleResolution": "Bundler",
    "noImplicitAny": true,
    "strict": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "lib": ["DOM", "ES2020"],
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

`esbuild.config.mjs`:

```js
import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  outfile: "main.js",
});

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
```

`manifest.json`:

```json
{
  "id": "claude-code-sync",
  "name": "Claude Code Sync",
  "version": "0.1.0",
  "minAppVersion": "1.5.0",
  "description": "Mirror Claude Code sessions into your vault as Markdown notes.",
  "author": "Matt Birchler",
  "authorUrl": "https://birchtree.me",
  "isDesktopOnly": true
}
```

`versions.json`:

```json
{
  "0.1.0": "1.5.0"
}
```

`.gitignore`:

```
node_modules/
main.js
*.map
```

`src/main.ts` (minimal, replaced in Task 7):

```ts
import { Plugin } from "obsidian";

export default class ClaudeCodeSyncPlugin extends Plugin {
  async onload() {
    console.log("Claude Code Sync loaded");
  }
}
```

- [ ] **Step 2: Install and build**

Run: `npm install && npm run build`
Expected: exits 0, `main.js` exists in the repo root.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json tsconfig.json esbuild.config.mjs manifest.json versions.json .gitignore src/main.ts
git commit -m "feat: scaffold Obsidian plugin project"
```

---

### Task 2: Parser — JSONL to Session model

**Files:**
- Create: `src/parser.ts`
- Test: `tests/parser.test.ts`

**Interfaces:**
- Consumes: nothing (pure module, no imports beyond types).
- Produces:
  - `interface ToolCall { name: string; input: unknown }`
  - `interface Turn { role: "user" | "assistant"; timestamp: string | null; text: string; thinking: string[]; tools: ToolCall[] }`
  - `interface Session { id: string; title: string | null; project: string | null; cwd: string | null; startedAt: string | null; updatedAt: string | null; turns: Turn[] }`
  - `function parseSession(jsonl: string, sessionId: string, fallbackProject: string): Session`
  - `function hasConversation(session: Session): boolean` — true iff at least one user turn AND one assistant turn.

- [ ] **Step 1: Write the failing tests**

`tests/parser.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/parser.test.ts`
Expected: FAIL — cannot resolve `../src/parser`.

- [ ] **Step 3: Write the implementation**

`src/parser.ts`:

```ts
export interface ToolCall {
  name: string;
  input: unknown;
}

export interface Turn {
  role: "user" | "assistant";
  timestamp: string | null;
  text: string;
  thinking: string[];
  tools: ToolCall[];
}

export interface Session {
  id: string;
  title: string | null;
  project: string | null;
  cwd: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  turns: Turn[];
}

const SYSTEM_NOISE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

export function parseSession(jsonl: string, sessionId: string, fallbackProject: string): Session {
  const session: Session = {
    id: sessionId,
    title: null,
    project: fallbackProject || null,
    cwd: null,
    startedAt: null,
    updatedAt: null,
    turns: [],
  };
  let summaryTitle: string | null = null;

  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue; // malformed line (possibly a torn mid-write read): skip, never fatal
    }
    if (!obj || typeof obj !== "object") continue;
    const rec = obj as Record<string, unknown>;

    if (rec.type === "ai-title" && typeof rec.aiTitle === "string") {
      session.title = rec.aiTitle;
      continue;
    }
    if (rec.type === "summary" && typeof rec.summary === "string") {
      summaryTitle = summaryTitle ?? rec.summary;
      continue;
    }
    if (rec.type !== "user" && rec.type !== "assistant") continue; // unknown types fail soft
    if (rec.isSidechain === true) continue; // subagent transcripts are not the user's conversation

    if (typeof rec.cwd === "string" && rec.cwd && !session.cwd) {
      session.cwd = rec.cwd;
      const base = basename(rec.cwd);
      if (base) session.project = base;
    }

    const turn = toTurn(rec);
    if (!turn) continue;
    if (turn.timestamp) {
      if (!session.startedAt) session.startedAt = turn.timestamp;
      session.updatedAt = turn.timestamp;
    }
    session.turns.push(turn);
  }

  if (!session.title && summaryTitle) session.title = summaryTitle;
  return session;
}

export function hasConversation(session: Session): boolean {
  return (
    session.turns.some((t) => t.role === "user") &&
    session.turns.some((t) => t.role === "assistant")
  );
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function toTurn(rec: Record<string, unknown>): Turn | null {
  const msg = rec.message;
  if (!msg || typeof msg !== "object") return null;
  const content = (msg as Record<string, unknown>).content;

  const turn: Turn = {
    role: rec.type as "user" | "assistant",
    timestamp: typeof rec.timestamp === "string" ? rec.timestamp : null,
    text: "",
    thinking: [],
    tools: [],
  };

  const texts: string[] = [];
  if (typeof content === "string") {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        texts.push(b.text);
      } else if (b.type === "thinking" && typeof b.thinking === "string") {
        turn.thinking.push(b.thinking);
      } else if (b.type === "tool_use") {
        turn.tools.push({ name: typeof b.name === "string" ? b.name : "tool", input: b.input });
      }
      // tool_result and unknown block types: skipped (tool acks, not conversation)
    }
  } else {
    return null;
  }

  turn.text = texts.join("\n\n").replace(SYSTEM_NOISE, "").trim();
  if (!turn.text && turn.thinking.length === 0 && turn.tools.length === 0) return null;
  return turn;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/parser.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/parser.ts tests/parser.test.ts
git commit -m "feat: parse Claude Code session JSONL into Session model"
```

---

### Task 3: Naming — filenames safe on every platform

**Files:**
- Create: `src/naming.ts`
- Test: `tests/naming.test.ts`

**Interfaces:**
- Consumes: `Session` from `src/parser.ts`.
- Produces:
  - `function sanitizeName(name: string): string` — strips characters illegal on macOS/Linux/Windows, collapses whitespace, strips trailing dots/spaces, truncates to 80 chars, returns `""` for Windows-reserved names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) or empty results.
  - `function noteBaseName(session: Session): string` — `"YYYY-MM-DD <sanitized title>"`, falling back to the session UUID when there is no usable title. No `.md` extension.

- [ ] **Step 1: Write the failing tests**

`tests/naming.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/naming.test.ts`
Expected: FAIL — cannot resolve `../src/naming`.

- [ ] **Step 3: Write the implementation**

`src/naming.ts`:

```ts
import type { Session } from "./parser";

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_LENGTH = 80;

export function sanitizeName(name: string): string {
  let out = name.replace(ILLEGAL, " ").replace(/\s+/g, " ").trim();
  out = out.replace(/[. ]+$/g, "");
  if (out.length > MAX_LENGTH) out = out.slice(0, MAX_LENGTH).trimEnd();
  if (!out || RESERVED.test(out)) return "";
  return out;
}

export function noteBaseName(session: Session): string {
  const title = session.title ? sanitizeName(session.title) : "";
  if (!title) return session.id;
  const datePrefix = session.startedAt ? `${session.startedAt.slice(0, 10)} ` : "";
  return `${datePrefix}${title}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/naming.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/naming.ts tests/naming.test.ts
git commit -m "feat: cross-platform note filename generation"
```

---

### Task 4: Renderer — Session to Markdown

**Files:**
- Create: `src/renderer.ts`
- Test: `tests/renderer.test.ts`

**Interfaces:**
- Consumes: `Session`, `Turn`, `ToolCall` from `src/parser.ts`.
- Produces:
  - `interface RenderOptions { includeTools: boolean; includeThinking: boolean }`
  - `function renderSession(session: Session, opts: RenderOptions): string` — full note body: YAML frontmatter, H1 title, `## You / ## Claude` turn sections, collapsed `[!thinking]-` and `[!tool]-` callouts.

Note: `npm test` runs with `TZ=UTC` (set in Task 1's package.json), so turn times render deterministically in tests. At runtime the user's local timezone is used — that is intentional.

- [ ] **Step 1: Write the failing tests**

`tests/renderer.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TZ=UTC npx vitest run tests/renderer.test.ts`
Expected: FAIL — cannot resolve `../src/renderer`.

- [ ] **Step 3: Write the implementation**

`src/renderer.ts`:

```ts
import type { Session, ToolCall, Turn } from "./parser";

export interface RenderOptions {
  includeTools: boolean;
  includeThinking: boolean;
}

const TOOL_BODY_LIMIT = 1000;
const HINT_KEYS = ["file_path", "path", "command", "pattern", "url"];

export function renderSession(session: Session, opts: RenderOptions): string {
  const parts: string[] = [frontmatter(session), `# ${heading(session)}`];
  for (const turn of session.turns) {
    const rendered = renderTurn(turn, opts);
    if (rendered) parts.push(rendered);
  }
  return parts.join("\n\n") + "\n";
}

function heading(session: Session): string {
  return session.title ?? `Session ${session.id.slice(0, 8)}`;
}

function frontmatter(session: Session): string {
  const lines = ["---", `session: ${JSON.stringify(session.id)}`];
  if (session.project) lines.push(`project: ${JSON.stringify(session.project)}`);
  if (session.cwd) lines.push(`cwd: ${JSON.stringify(session.cwd)}`);
  if (session.startedAt) lines.push(`date: ${session.startedAt.slice(0, 10)}`);
  if (session.updatedAt) lines.push(`updated: ${JSON.stringify(session.updatedAt)}`);
  lines.push("source: claude-code", "---");
  return lines.join("\n");
}

function renderTurn(turn: Turn, opts: RenderOptions): string {
  const speaker = turn.role === "user" ? "You" : "Claude";
  const time = turn.timestamp ? formatTime(turn.timestamp) : "";
  const parts: string[] = [`## ${speaker}${time ? ` · ${time}` : ""}`];
  if (opts.includeThinking) {
    for (const t of turn.thinking) parts.push(callout("thinking", "Thinking", t));
  }
  if (turn.text) parts.push(turn.text);
  if (opts.includeTools) {
    for (const tool of turn.tools) parts.push(toolCallout(tool));
  }
  if (parts.length === 1 && !turn.text) return parts[0];
  return parts.join("\n\n");
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function callout(kind: string, title: string, body: string): string {
  const quoted = body.split("\n").map((l) => `> ${l}`).join("\n");
  return `> [!${kind}]- ${title}\n${quoted}`;
}

function toolCallout(tool: ToolCall): string {
  const input =
    tool.input && typeof tool.input === "object" ? (tool.input as Record<string, unknown>) : {};
  const hint = firstString(input, HINT_KEYS);
  const title = hint ? `${tool.name} ${hint.replace(/\s+/g, " ").slice(0, 80)}` : tool.name;
  let body: string;
  try {
    body = JSON.stringify(tool.input, null, 2) ?? "";
  } catch {
    body = String(tool.input);
  }
  if (body.length > TOOL_BODY_LIMIT) body = body.slice(0, TOOL_BODY_LIMIT) + " …";
  return callout("tool", title, body);
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TZ=UTC npx vitest run tests/renderer.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer.ts tests/renderer.test.ts
git commit -m "feat: render sessions as Markdown notes with callouts"
```

---

### Task 5: Discovery — find session files on disk

**Files:**
- Create: `src/discovery.ts`
- Test: `tests/discovery.test.ts`

**Interfaces:**
- Consumes: Node `fs`, `path` (read-only fs access is allowed here — this is the source side, not the vault).
- Produces:
  - `interface SessionFile { path: string; sessionId: string; projectFolder: string; mtimeMs: number }`
  - `function expandHome(p: string, homedir: string): string`
  - `function findSessionFiles(sourcePath: string, homedir: string): SessionFile[]` — enumerates `<source>/<projectFolder>/*.jsonl`; returns `[]` when the source doesn't exist; never throws.

- [ ] **Step 1: Write the failing tests**

`tests/discovery.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/discovery.test.ts`
Expected: FAIL — cannot resolve `../src/discovery`.

- [ ] **Step 3: Write the implementation**

`src/discovery.ts`:

```ts
import * as fs from "fs";
import * as path from "path";

export interface SessionFile {
  path: string;
  sessionId: string;
  projectFolder: string;
  mtimeMs: number;
}

export function expandHome(p: string, homedir: string): string {
  if (p === "~") return homedir;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(homedir, p.slice(2));
  return p;
}

export function findSessionFiles(sourcePath: string, homedir: string): SessionFile[] {
  const root = expandHome(sourcePath.trim(), homedir);
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: SessionFile[] = [];
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = path.join(root, dir.name);
    let entries: string[];
    try {
      entries = fs.readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const filePath = path.join(dirPath, name);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        out.push({
          path: filePath,
          sessionId: name.slice(0, -".jsonl".length),
          projectFolder: dir.name,
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        continue;
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/discovery.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/discovery.ts tests/discovery.test.ts
git commit -m "feat: discover Claude Code session files on disk"
```

---

### Task 6: SyncEngine — orchestration against a VaultAdapter

**Files:**
- Create: `src/sync.ts`
- Test: `tests/sync.test.ts`

**Interfaces:**
- Consumes: `SessionFile` (discovery), `parseSession`/`hasConversation` (parser), `renderSession` (renderer), `noteBaseName`/`sanitizeName` (naming).
- Produces:
  - `interface VaultAdapter { exists(path: string): boolean; createFolder(path: string): Promise<void>; write(path: string, content: string): Promise<void>; rename(oldPath: string, newPath: string): Promise<void> }`
  - `interface FileState { mtimeMs: number; notePath: string }` and `type SyncState = Record<string, FileState>` (keyed by source file path)
  - `interface SyncSettings { targetFolder: string; includeTools: boolean; includeThinking: boolean }`
  - `interface SyncResult { synced: number; skipped: number; errors: string[] }`
  - `class SyncEngine { constructor(vault: VaultAdapter, readFile: (path: string) => string); run(files: SessionFile[], settings: SyncSettings, state: SyncState): Promise<SyncResult> }` — `run` mutates `state` in place; the caller persists it.

- [ ] **Step 1: Write the failing tests**

`tests/sync.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sync.test.ts`
Expected: FAIL — cannot resolve `../src/sync`.

- [ ] **Step 3: Write the implementation**

`src/sync.ts`:

```ts
import type { SessionFile } from "./discovery";
import { hasConversation, parseSession } from "./parser";
import { renderSession } from "./renderer";
import { noteBaseName, sanitizeName } from "./naming";

export interface VaultAdapter {
  exists(path: string): boolean;
  createFolder(path: string): Promise<void>;
  write(path: string, content: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

export interface FileState {
  mtimeMs: number;
  notePath: string;
}

export type SyncState = Record<string, FileState>;

export interface SyncSettings {
  targetFolder: string;
  includeTools: boolean;
  includeThinking: boolean;
}

export interface SyncResult {
  synced: number;
  skipped: number;
  errors: string[];
}

export class SyncEngine {
  constructor(
    private vault: VaultAdapter,
    private readFile: (path: string) => string
  ) {}

  async run(files: SessionFile[], settings: SyncSettings, state: SyncState): Promise<SyncResult> {
    const result: SyncResult = { synced: 0, skipped: 0, errors: [] };

    for (const file of files) {
      try {
        const prev = state[file.path];
        if (prev && prev.mtimeMs >= file.mtimeMs) {
          result.skipped++;
          continue;
        }

        const session = parseSession(this.readFile(file.path), file.sessionId, file.projectFolder);
        if (!hasConversation(session)) {
          // remember the mtime so we don't reparse it every pass, but write nothing
          state[file.path] = { mtimeMs: file.mtimeMs, notePath: prev?.notePath ?? "" };
          result.skipped++;
          continue;
        }

        const projectName = sanitizeName(session.project ?? "") || file.projectFolder;
        const folder = `${settings.targetFolder}/${projectName}`;
        let notePath = `${folder}/${noteBaseName(session)}.md`;
        notePath = resolveCollision(notePath, file.path, session.id, state);

        await this.ensureFolder(settings.targetFolder);
        await this.ensureFolder(folder);

        if (prev?.notePath && prev.notePath !== notePath && this.vault.exists(prev.notePath)) {
          await this.vault.rename(prev.notePath, notePath);
        }
        await this.vault.write(notePath, renderSession(session, settings));

        state[file.path] = { mtimeMs: file.mtimeMs, notePath };
        result.synced++;
      } catch (e) {
        result.errors.push(`${file.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return result;
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!this.vault.exists(path)) await this.vault.createFolder(path);
  }
}

function resolveCollision(
  notePath: string,
  sourcePath: string,
  sessionId: string,
  state: SyncState
): string {
  const taken = Object.entries(state).some(
    ([src, st]) => src !== sourcePath && st.notePath === notePath
  );
  if (!taken) return notePath;
  return notePath.replace(/\.md$/, ` (${sessionId.slice(0, 8)}).md`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sync.test.ts`
Expected: PASS (6 tests). Then run the whole suite: `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/sync.ts tests/sync.test.ts
git commit -m "feat: sync engine with mtime state, renames, and per-file error isolation"
```

---

### Task 7: Settings + main.ts wiring

**Files:**
- Create: `src/settings.ts`
- Modify: `src/main.ts` (replace the Task 1 stub entirely)

**Interfaces:**
- Consumes: `SyncEngine`, `VaultAdapter`, `SyncState` (sync); `findSessionFiles` (discovery); Obsidian API (`Plugin`, `PluginSettingTab`, `Setting`, `Notice`, `TFile`, `normalizePath`).
- Produces:
  - `interface ClaudeCodeSyncSettings { sourcePath: string; targetFolder: string; intervalMinutes: number; includeTools: boolean; includeThinking: boolean }`
  - `const DEFAULT_SETTINGS: ClaudeCodeSyncSettings`
  - `class ClaudeCodeSyncSettingTab extends PluginSettingTab`
  - `default class ClaudeCodeSyncPlugin extends Plugin` with `settings`, `state`, `syncAll()`, `applyInterval()`, `savePersisted()`.

No unit tests for this task (it is all Obsidian API glue); verification is `npm run build` plus the manual dev-vault check in Task 8.

- [ ] **Step 1: Write src/settings.ts**

```ts
import { App, PluginSettingTab, Setting } from "obsidian";
import type ClaudeCodeSyncPlugin from "./main";

export interface ClaudeCodeSyncSettings {
  sourcePath: string;
  targetFolder: string;
  intervalMinutes: number;
  includeTools: boolean;
  includeThinking: boolean;
}

export const DEFAULT_SETTINGS: ClaudeCodeSyncSettings = {
  sourcePath: "~/.claude/projects",
  targetFolder: "Claude Code",
  intervalMinutes: 5,
  includeTools: true,
  includeThinking: true,
};

export class ClaudeCodeSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ClaudeCodeSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Source path")
      .setDesc("Where Claude Code stores its sessions. ~ expands to your home folder.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.sourcePath)
          .setValue(this.plugin.settings.sourcePath)
          .onChange(async (value) => {
            this.plugin.settings.sourcePath = value.trim() || DEFAULT_SETTINGS.sourcePath;
            await this.plugin.savePersisted();
          })
      );

    new Setting(containerEl)
      .setName("Target folder")
      .setDesc("Vault folder the session notes are written into.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.targetFolder)
          .setValue(this.plugin.settings.targetFolder)
          .onChange(async (value) => {
            this.plugin.settings.targetFolder =
              value.trim().replace(/\/+$/, "") || DEFAULT_SETTINGS.targetFolder;
            await this.plugin.savePersisted();
          })
      );

    new Setting(containerEl)
      .setName("Sync interval (minutes)")
      .setDesc("How often to sync automatically. 0 means manual only.")
      .addText((text) =>
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.intervalMinutes))
          .onChange(async (value) => {
            const n = Number(value);
            this.plugin.settings.intervalMinutes = Number.isFinite(n) && n >= 0 ? n : 5;
            await this.plugin.savePersisted();
            this.plugin.applyInterval();
          })
      );

    new Setting(containerEl)
      .setName("Include tool calls")
      .setDesc("Show what Claude did (edits, commands) as collapsed callouts.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeTools).onChange(async (value) => {
          this.plugin.settings.includeTools = value;
          await this.plugin.savePersisted();
        })
      );

    new Setting(containerEl)
      .setName("Include thinking")
      .setDesc("Show Claude's internal reasoning as collapsed callouts.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeThinking).onChange(async (value) => {
          this.plugin.settings.includeThinking = value;
          await this.plugin.savePersisted();
        })
      );
  }
}
```

- [ ] **Step 2: Replace src/main.ts**

```ts
import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import * as fs from "fs";
import * as os from "os";
import {
  ClaudeCodeSyncSettings,
  ClaudeCodeSyncSettingTab,
  DEFAULT_SETTINGS,
} from "./settings";
import { findSessionFiles } from "./discovery";
import { SyncEngine, SyncState, VaultAdapter } from "./sync";

interface PersistedData {
  settings: ClaudeCodeSyncSettings;
  state: SyncState;
}

export default class ClaudeCodeSyncPlugin extends Plugin {
  settings: ClaudeCodeSyncSettings = { ...DEFAULT_SETTINGS };
  state: SyncState = {};
  private syncing = false;
  private intervalId: number | null = null;

  async onload() {
    await this.loadPersisted();
    this.addRibbonIcon("refresh-cw", "Sync Claude Code sessions", () => this.syncAll());
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.syncAll() });
    this.addSettingTab(new ClaudeCodeSyncSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      void this.syncAll();
      this.applyInterval();
    });
  }

  applyInterval() {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.settings.intervalMinutes > 0) {
      this.intervalId = window.setInterval(
        () => void this.syncAll(),
        this.settings.intervalMinutes * 60_000
      );
      this.registerInterval(this.intervalId);
    }
  }

  async syncAll() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const files = findSessionFiles(this.settings.sourcePath, os.homedir());
      const engine = new SyncEngine(this.vaultAdapter(), (p) => fs.readFileSync(p, "utf8"));
      const result = await engine.run(files, this.settings, this.state);
      await this.savePersisted();
      if (result.errors.length > 0) {
        console.error("Claude Code Sync errors:", result.errors);
        new Notice(`Claude Code Sync: ${result.errors.length} session(s) failed to sync.`);
      } else if (result.synced > 0) {
        new Notice(`Claude Code Sync: updated ${result.synced} note(s).`);
      }
    } finally {
      this.syncing = false;
    }
  }

  private vaultAdapter(): VaultAdapter {
    const vault = this.app.vault;
    return {
      exists: (p) => vault.getAbstractFileByPath(normalizePath(p)) !== null,
      createFolder: async (p) => {
        await vault.createFolder(normalizePath(p));
      },
      write: async (p, content) => {
        const norm = normalizePath(p);
        const existing = vault.getAbstractFileByPath(norm);
        if (existing instanceof TFile) await vault.modify(existing, content);
        else await vault.create(norm, content);
      },
      rename: async (oldPath, newPath) => {
        const file = vault.getAbstractFileByPath(normalizePath(oldPath));
        if (file instanceof TFile) {
          await this.app.fileManager.renameFile(file, normalizePath(newPath));
        }
      },
    };
  }

  async loadPersisted() {
    const data = (await this.loadData()) as Partial<PersistedData> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
    this.state = data?.state ?? {};
  }

  async savePersisted() {
    const data: PersistedData = { settings: this.settings, state: this.state };
    await this.saveData(data);
  }
}
```

- [ ] **Step 3: Build and run the full test suite**

Run: `npm run build && npm test`
Expected: build exits 0 producing `main.js`; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/settings.ts src/main.ts
git commit -m "feat: wire sync engine into plugin with settings, ribbon, command, and interval"
```

---

### Task 8: End-to-end verification in a dev vault (Obsidian CLI)

**Files:** none created in the repo.

**Interfaces:**
- Consumes: the built `main.js` + `manifest.json`, and the official Obsidian CLI (Obsidian 1.12+, shipped Feb 2026 — a remote control for the running app).
- Produces: confirmation the plugin works end-to-end. One-time CLI setup requires Matt; after that the loop is scriptable.

- [ ] **Step 1: One-time CLI setup (Matt, manual)**

Ask Matt to: open Obsidian (1.12.7+ installer) → Settings → General → toggle **Command line interface** on and follow the registration prompt. Verify from the terminal:

```bash
which obsidian && obsidian vaults
```

Expected: the `obsidian` binary resolves and the vault list prints. If Matt prefers not to enable the CLI, fall back to the manual checklist in Step 5 for everything.

- [ ] **Step 2: Install the plugin into a dev vault**

```bash
VAULT=~/ObsidianDevVault   # or an existing test vault from `obsidian vaults`
mkdir -p "$VAULT/.obsidian/plugins/claude-code-sync"
npm run build
cp main.js manifest.json "$VAULT/.obsidian/plugins/claude-code-sync/"
```

First enable needs the GUI once (community plugins must be trusted per vault): Matt opens the dev vault and enables "Claude Code Sync". After that, iteration is CLI-only.

- [ ] **Step 3: Drive a sync from the terminal and check for errors**

```bash
obsidian plugin:reload id=claude-code-sync   # picks up a fresh build
obsidian eval code="app.commands.executeCommandById('claude-code-sync:sync-now')"
sleep 5
obsidian dev:errors                          # expect: no errors from claude-code-sync
```

- [ ] **Step 4: Read a synced note back through the CLI**

```bash
obsidian eval code="app.vault.getFolderByPath('Claude Code')?.children.map(c => c.path).join('\n')"
obsidian read path="Claude Code/<project>/<a note from the listing>.md"
```

Expected: one subfolder per project; the note shows frontmatter (`session`, `project`, `date`, `source: claude-code`), `## You / ## Claude` headings, `[!tool]-`/`[!thinking]-` callouts, no `<system-reminder>` noise. Also verify the rewrite path: `touch` one source `.jsonl`, re-run the Step 3 sync, confirm the note's `updated` field changed.

- [ ] **Step 5: Ask Matt to eyeball rendering in the app**

The visual half that the CLI can't judge:
1. Frontmatter renders as properties; callouts are collapsed and expandable.
2. Toggle "Include thinking" off in settings, `touch` a session file, run "Sync now" — the regenerated note omits thinking.
3. The ribbon icon and command palette entry both trigger a sync.

- [ ] **Step 6: Fix anything that surfaced, then commit fixes**

Any bug found here gets a regression test in the matching test file before the fix where feasible (parser/renderer/naming/sync bugs are all unit-testable).

---

### Task 9: README, license, release workflow

**Files:**
- Create: `LICENSE`, `.github/workflows/release.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: the finished plugin.
- Produces: a repo ready for BRAT installs and, later, community directory submission. Release flow: `git tag 0.1.0 && git push --tags` → GitHub Actions attaches `main.js` + `manifest.json` to a release.

- [ ] **Step 1: Write the license**

`LICENSE`: the standard MIT license text, `Copyright (c) 2026 Matt Birchler`.

- [ ] **Step 2: Write the release workflow**

`.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags: ["*"]

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm ci
      - run: npm test
      - run: npm run build
      - name: Create release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh release create "${{ github.ref_name }}" main.js manifest.json \
            --title "${{ github.ref_name }}" --generate-notes
```

- [ ] **Step 3: Rewrite README.md**

Replace the placeholder README with real content covering, in this order:
- One-paragraph pitch: every Claude Code session mirrored into your vault as Markdown, set-and-forget.
- What a synced note looks like (short example snippet with frontmatter, You/Claude headings, a collapsed tool callout).
- Install via BRAT (add `mattbirchler/claude-code-obsidian` in BRAT) and manual install (copy `main.js` + `manifest.json` from the latest release into `<vault>/.obsidian/plugins/claude-code-sync/`).
- Settings table (the five settings, defaults, what they do).
- "How it works" section: reads `~/.claude/projects` locally, no network, notes are a read-only mirror regenerated on change, desktop only.
- Development section: `npm install`, `npm run dev`, `npm test`.

- [ ] **Step 4: Verify workflow syntax and commit**

Run: `npm test && npm run build` one final time.

```bash
git add LICENSE .github/workflows/release.yml README.md
git commit -m "docs: README, MIT license, and tag-triggered release workflow"
git push
```

- [ ] **Step 5: Tag the first release**

Only after Matt confirms Task 8 verification passed:

```bash
git tag 0.1.0
git push --tags
```

Then check `gh run watch` for the release workflow and confirm the release has `main.js` and `manifest.json` attached.
