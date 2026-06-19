# agent-pane

Electron desktop app: chat with an LLM that can use tools (read/write/search files, shell, git, MCP) against opened project folders. UI includes conversation, file tree, Monaco editor, tool approvals, and a pending-diff queue.

Requires Node ≥ 22.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev build + Electron |
| `npm run build` | Production bundle to `dist/` |
| `npm start` | Run built app |
| `npm test` | Unit tests |
| `npm run check` | typecheck, lint, format, test |

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
