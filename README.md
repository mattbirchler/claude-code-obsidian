# Claude Code Sync

An Obsidian plugin that mirrors every [Claude Code](https://claude.com/claude-code) session on your machine into your vault as Markdown notes. Point it at your `~/.claude/projects` folder once, and every session you have with Claude Code — past and future — shows up as a readable, searchable, linkable note. Set it and forget it.

## What a synced note looks like

Each session becomes one note, named `<date> <session title>.md`, filed under a folder named for the project it belongs to. A note looks roughly like this:

```markdown
---
session: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
project: "claude-code-obsidian"
cwd: "/Users/matt/Apps/claude-code-obsidian"
date: 2026-07-07
updated: "2026-07-07T16:46:00.000Z"
source: claude-code
---

# Add MIT license and release workflow

## You · 16:04

Add a LICENSE file and a GitHub Actions release workflow.

## Claude · 16:05

Done — here's the license file and the workflow.

> [!tool]- Write LICENSE
> {
>   "file_path": "/Users/matt/Apps/claude-code-obsidian/LICENSE",
>   "content": "MIT License..."
> }
```

Tool calls and Claude's thinking are folded into collapsed callouts (`> [!tool]-` and `> [!thinking]-`) so the conversation stays readable — expand them when you want the detail.

**Notes are a read-only mirror.** They're regenerated whenever the source session changes, so any edits you make directly in a synced note get overwritten on the next sync. If you want to add your own commentary, do it in a separate note and link to the synced one.

## Install

### BRAT (recommended for now)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin from the Obsidian community plugin directory.
2. In BRAT, add the beta plugin `mattbirchler/claude-code-obsidian`.
3. Enable "Claude Code Sync" in Obsidian's Community Plugins settings.

### Manual install

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/mattbirchler/claude-code-obsidian/releases/latest).
2. Copy both files into `<vault>/.obsidian/plugins/claude-code-sync/`.
3. Reload Obsidian and enable "Claude Code Sync" in Community Plugins settings.

Submission to the Obsidian community plugin directory is planned; until then, use one of the two methods above.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Source path | `~/.claude/projects` | Where Claude Code stores its session files. `~` expands to your home folder. |
| Target folder | `Claude Code` | Vault folder the session notes are written into. |
| Sync interval (minutes) | `30` | How often to sync automatically. `0` means manual only. |
| Include tool calls | On | Show what Claude did (edits, commands) as collapsed callouts. |
| Include thinking | On | Show Claude's internal reasoning as collapsed callouts. |

You can also trigger a sync any time from the ribbon icon or the "Sync now" command.

## How it works

Claude Code Sync reads Claude Code's session transcripts (`~/.claude/projects/**/*.jsonl`) straight off disk and renders them into Markdown notes in your vault — nothing leaves your machine, there's no account, and no network requests are made. It syncs automatically on Obsidian launch and on the interval you set, plus on demand.

Because notes are generated from the source transcripts, they're a mirror, not a place to write: editing a synced note directly will be overwritten the next time that session changes. Subagent (sidechain) transcripts and internal system noise are filtered out, and sessions with no real content are skipped entirely.

This plugin requires the [Claude Code](https://claude.com/claude-code) CLI to have actually been used on your machine — that's what writes the session files it reads. It's desktop-only (it needs Node's filesystem APIs), so it won't run on Obsidian mobile.

## Development

```bash
npm install
npm run dev     # watch build
npm test        # run the test suite (vitest)
npm run build   # production build
```

## License

MIT — see [LICENSE](LICENSE).
