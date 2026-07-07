# Claude Code Sync — Design

**Date:** 2026-07-07
**Status:** Approved

## What this is

An Obsidian plugin that mirrors Claude Code sessions into a vault as Markdown
notes. Claude Code writes every session to disk as JSON Lines under
`~/.claude/projects/`; this plugin reads those files and maintains one note per
session, synced on app launch and on a user-configurable interval. Set it and
forget it.

Intended for wide distribution (community plugin directory), so nothing may be
hardcoded to one machine or OS. Desktop only (`isDesktopOnly: true`) because it
needs Node `fs`.

## Decisions already made (with Matt)

- **Read-only mirror.** Notes are fully regenerated from the `.jsonl` whenever
  the source changes. User edits to synced notes are not preserved; users
  annotate in separate linked notes.
- **Full history.** First sync imports every session ever recorded, not just
  new ones.
- **Tool calls and thinking blocks are both included**, each as collapsed
  callouts, each behind its own settings toggle (both default on).
- **Naming:** `Target folder/<project>/<YYYY-MM-DD> <session title>.md`.
- **Sync engine:** interval + mtime check + full note regenerate. No
  incremental append, no `fs.watch` in v1.

## Architecture

Official Obsidian sample-plugin toolchain: TypeScript, esbuild bundling to
`main.js`. Small focused modules:

| Module | Responsibility |
|---|---|
| `main.ts` | Plugin lifecycle: ribbon icon, "Sync now" command, sync on launch (after `onLayoutReady`), `registerInterval` |
| `settings.ts` | Settings model, defaults, `PluginSettingTab` |
| `discovery.ts` | Locate the projects dir cross-platform, enumerate project folders and session files |
| `parser.ts` | JSONL → `Session` model (pure function) |
| `renderer.ts` | `Session` → Markdown string (pure function) |
| `sync.ts` | Orchestration: mtime state, upsert/rename notes via Vault API, error collection |

Data flow: `discovery` finds files → `sync` decides which changed → `parser`
builds a `Session` → `renderer` produces Markdown → `sync` writes through the
Vault API and records new mtimes.

## Source format (ground-truthed 2026-07-07)

`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, one JSON object per line.
Observed line types: `user`, `assistant`, `ai-title`, `summary`, plus
housekeeping (`mode`, `permission-mode`, `last-prompt`, `attachment`,
`file-history-snapshot`, `system`).

Parsing rules:

- Only `user`, `assistant`, `ai-title`, `summary` are consumed. All other
  types — including unknown future ones — are skipped silently (format drift
  fails soft).
- Malformed lines are skipped, never fatal.
- Every field access is guarded; a message missing an expected field is
  skipped, not thrown on.
- `message.content` may be a string or an array of blocks (`text`,
  `thinking`, `tool_use`, `tool_result`). Handle both.
- **Project name comes from the `cwd` field inside messages** (last path
  segment), because the folder-name encoding is lossy
  (`-Users-matt-Apps-Quick-Reads` cannot reliably decode). Fallback: the
  encoded folder name.
- **Sidechain lines (`isSidechain: true`) are skipped** — they are subagent
  transcripts, not the user's conversation.
- Injected `<system-reminder>` blocks, hook output, and similar harness noise
  inside user messages are stripped.
- Session title comes from the `ai-title` line (`aiTitle` field), falling
  back to a `summary` line, falling back to the session UUID.

## Note format

```markdown
---
session: 1a805d0c-97df-4f50-9307-819dd548ea1a
project: quickreads
cwd: /Users/matt/Apps/Quick Reads
date: 2026-07-06
updated: 2026-07-07T15:28:00Z
source: claude-code
---

# Add retry to TTS call

## You · 18:04
add a retry to the TTS call

## Claude · 18:04
> [!thinking]- Thinking
> The TTS client can fail transiently...

Wrapped the TTS request in a backoff loop.

> [!tool]- Edit src/tts.ts
> +  await retry(() => ttsClient.speak(text))
```

- Tool calls: collapsed `> [!tool]-` callout titled with tool name + key
  input, body truncated to 1,000 characters.
- Thinking: collapsed `> [!thinking]-` callout.
- Sessions with no real user/assistant exchange are skipped entirely (no
  empty warm-up notes).

## Writing and naming

- All vault writes go through the Vault API (`create`/`modify`/
  `createFolder`), never raw `fs`, so Obsidian indexes the notes.
- Path: `<target folder>/<project>/<YYYY-MM-DD> <sanitized title>.md`.
- Title sanitization covers both macOS/Linux and Windows illegal characters
  and Windows reserved names; titles are truncated to 80 characters.
- UUID filename fallback until a title exists; when a title appears later the
  note is renamed via `fileManager.renameFile` (preserves backlinks).
- Filename collisions get a short UUID suffix.

## Sync engine

- `saveData()` persists `{ [sourceFilePath]: { mtimeMs, notePath } }`.
- A sync pass: enumerate files → skip any whose mtime hasn't advanced →
  re-parse and fully rewrite the rest.
- Runs on launch and every N minutes via `registerInterval` (auto-cleaned on
  unload). Concurrent passes are prevented with a simple in-flight flag.
- Failures are per-file: one bad session never aborts the pass. Errors are
  collected and surfaced as a single summary `Notice`.
- Files being written mid-read are tolerated: a torn read produces skipped
  malformed lines, and the next pass (mtime advanced again) corrects the note.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Source path | `~/.claude/projects` | `~` expanded via `os.homedir()`; works on Windows too |
| Target folder | `Claude Code` | Vault-relative |
| Sync interval (minutes) | 5 | 0 = manual only |
| Include tool calls | on | Collapsed callouts |
| Include thinking | on | Collapsed callouts |

## Testing

- `parser.ts` and `renderer.ts` are pure functions, unit-tested with vitest
  against fixture `.jsonl` files: malformed lines, string vs. block content,
  missing titles, sidechains, empty sessions, torn final line.
- `sync.ts`/vault interaction verified manually in a dev vault.

## Distribution

- MIT license, README with BRAT + manual install instructions.
- GitHub Actions release workflow: on tag, build and attach `main.js`,
  `manifest.json` (and `styles.css` if present) to a GitHub release.
- `versions.json` maintained for Obsidian version compatibility.
- Structured to be submission-ready for the community plugin directory.

## Out of scope for v1

- Mobile support, incremental append rendering, `fs.watch` real-time sync,
  per-project include/exclude filters, size caps or day-splitting for huge
  sessions, syncing claude.ai (non-Code) conversations.
