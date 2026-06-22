# Copse

Electron desktop app (`copse-panel`): chat with an LLM that can use tools (read/write/search files, shell, git, MCP) against opened project folders. UI includes conversation, file tree, Monaco editor, tool approvals, and a pending-diff queue.

Requires Node ≥ 22.

## Commands

| Command         | Purpose                       |
| --------------- | ----------------------------- |
| `npm run dev`   | Dev build + Electron          |
| `npm run build` | Production bundle to `dist/`  |
| `npm start`     | Run built app                 |
| `npm test`      | Unit tests                    |
| `npm run check` | typecheck, lint, format, test |

your `.gitignore` (this repo already does).

## Shell command permissions

When the macOS project sandbox (seatbelt) is active, sandbox-contained shell commands
auto-run inside that confinement. Commands that look external (network, `gh`, `git push`,
etc.) prompt for approval and run **outside** the sandbox when approved. On other
platforms, Copse uses a **regex heuristic** (`analyzeShellCommand`) plus an optional
local safety model to decide whether to auto-run or prompt — this is a UX hint, not a
security boundary (substitution, encoding, and uncommon tools can bypass it).
Approve external commands explicitly when sandboxing is off.

## Layout

```
src/
  main/          Electron main: window, IPC, agent service, tool registry, workspace, MCP, project sandbox
  preload/       `contextBridge` API exposed to the renderer
  renderer/      DOM UI (views, controllers, styles), Monaco setup
  shared/        Agent loop, reactive store, LLM providers, shared types
scripts/         esbuild dev/build and test runner
```

Path alias `@shared/*` maps to `src/shared/*` (see tsconfig).

## MCP servers

The agent is an MCP (Model Context Protocol) host and ships with no servers
connected. Add them in `.cursor/mcp.json` / `.mcp.json` (project) or
`~/.cursor/mcp.json` (global), using the standard `mcpServers` format (same as
Cursor / Claude Desktop); reference secrets with `${env:VAR}`. See
[`mcp.json.example`](./mcp.json.example) for optional MCP servers. Status, reload, and
approval settings live under **Settings → MCP servers**.

## Semantic search

On supported platforms, `npm install` downloads a bundled `codesearch` binary to
`vendor/codesearch/` (postinstall; skip with `SKIP_CODESEARCH_FETCH=1`). Native tools
(`semantic_search`, `search_codebase` semantic mode) use codesearch or vera on PATH,
preferring a system install over the bundled copy, and keep the index in sync with the
workspace. Index data is stored globally under Copse app data (`codesearch/` inside the
`copse-panel` userData directory), not in the project tree.
