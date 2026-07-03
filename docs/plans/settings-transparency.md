# Settings transparency & Claude parity

Status: **in progress** — transparency panel + project-instruction parity landing now;
the rest tracked as follow-ups (see below).

## Why

Copse silently auto-loads a fair amount of external configuration when a workspace is
opened. Most of it comes from Cursor's conventions, some is bundled, and the user has no
way to see what is active. Two gaps motivated this work:

1. **Transparency** — the user asked "can we expose what settings we're pulling from?".
   Skills, Cursor hooks, and Cursor plugins are all discovered and loaded, but only MCP
   servers were ever surfaced in the UI.
2. **Claude parity** — the discovery paths lean Cursor-first. Where a Claude equivalent is
   cheap (project instruction files), we should read it too so Copse behaves the same
   regardless of which assistant seeded the repo.

## What we actually load today (audit)

| Source                   | Read from                                                                                                                                                                                 | Surfaced before this change?                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Skills**               | user `~/.{cursor,agents,claude}/skills`, project `.{cursor,agents,claude}/skills`, bundled Cursor skills, Cursor plugins `~/.cursor/plugins/{local,cache}`, configured `skillPluginPaths` | Partly — listed in the `/` skill picker, but **without their source**                     |
| **Cursor hooks**         | `~/.cursor/hooks.json` (user, always) and `<root>/.cursor/hooks.json` (project, only when the workspace is trusted). Permission hooks can `deny`/`ask` on tool calls                      | **No** — `listCursorHooks()` + `hooks:list` IPC + preload existed but no view called them |
| **Cursor plugins**       | `~/.cursor/plugins/{local,cache}` (bring skills + MCP)                                                                                                                                    | **No** — same: `listCursorPlugins()` + `plugins:list` wired to preload, never rendered    |
| **MCP servers**          | `.cursor/mcp.json`, `.mcp.json`, `~/.cursor/mcp.json`, plugin `.mcp.json`, curated catalog                                                                                                | **Yes** — Settings → MCP servers, with source path                                        |
| **Project instructions** | `<root>/AGENT.md` **only**                                                                                                                                                                | Implicitly (fed to the prompt), not listed                                                |

### Notably _not_ loaded

- **Cursor rules** — `.cursor/rules/*.mdc` and legacy `.cursorrules` are **never read**.
  The "we import Cursor rules" assumption is inaccurate; we import skills/hooks/plugins/MCP.
- **`CLAUDE.md`** — not read (only `AGENT.md`).
- **Global / user steering** — no `~/AGENTS.md`, no global `CLAUDE.md`, and none of the
  user's Cursor "Rules for AI" (Cursor keeps those in its own app SQLite state, not a
  file, so importing them is a distinct, larger effort). Copse's own `customInstructions`
  setting is the app-native equivalent, but it is not imported from anywhere.

## What is landing now

### 1. Transparency — a "Sources" settings section

A new Settings section that lists, read-only, everything auto-loaded for the current
workspace:

- **Instruction files** being fed to the prompt, with paths.
- **Skills**, each tagged with its source (`project` / `user` / `plugin` / `plugin-path`
  / `bundled`).
- **Cursor hooks**, tagged `user` vs `project`, showing the event and command. Hooks are
  the priority: a project `.cursor/hooks.json` can gate/deny the agent invisibly.
- **Cursor plugins**, with version, root, and whether they contribute skills / MCP.

The backend for skills/hooks/plugins already existed end-to-end (`skills:list`,
`hooks:list`, `plugins:list` over IPC + preload); this is mostly renderer work plus one
new `instructions:list` channel.

### 2. Claude parity — project instruction files

`loadProjectInstructions()` now reads `AGENT.md`, `AGENTS.md`, and `CLAUDE.md` (in that
precedence order), concatenating whichever are present and de-duplicating identical
content (repos commonly symlink `AGENTS.md` → `CLAUDE.md`). The loaded files are exposed
via `loadProjectInstructionSources()` so the Sources panel can show exactly what was fed
to the prompt.

## Follow-ups (not in this change)

- **Cursor rules import** (#636) — read `.cursor/rules/*.mdc` (respecting `alwaysApply` /
  glob scoping) and legacy `.cursorrules` as project instructions, since we advertise
  Cursor compatibility but skip its rules today.
- **Global / user instructions** (#637) — optional load of `~/AGENTS.md` /
  `~/.claude/CLAUDE.md` (plain files, easy) as a lower-precedence layer beneath project
  files.
- **Cursor "Rules for AI" import** (#638) — the user's personal Cursor steering. Bigger: it
  lives in Cursor's SQLite app state, not a file. Needs its own design.
- **Claude Code hooks & settings** (#639) — support `.claude/settings.json` hooks (distinct
  event schema from Cursor's `hooks.json`; needs an adapter) and then broader settings
  (permissions, env) parity.

Landed as PR #635.
