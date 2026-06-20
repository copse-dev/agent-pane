# agent-pane

Electron desktop app: chat with an LLM that can use tools (read/write/search files, shell, git, MCP) against opened project folders. UI includes conversation, file tree, Monaco editor, tool approvals, and a pending-diff queue.

Requires Node ≥ 22.

## Commands

| Command         | Purpose                       |
| --------------- | ----------------------------- |
| `npm run dev`   | Dev build + Electron          |
| `npm run build` | Production bundle to `dist/`  |
| `npm start`     | Run built app                 |
| `npm test`      | Unit tests                    |
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

## MCP servers

The agent is an MCP (Model Context Protocol) **host**: it speaks the protocol but
ships with no servers connected. Add your own to expose external tools (GitHub,
databases, browsers, internal APIs) to the agent.

### Configuration

Servers are read and merged from these locations (earlier wins on duplicate names):

1. `<workspace>/.cursor/mcp.json` (per-project)
2. `<workspace>/.mcp.json` (per-project)
3. `~/.cursor/mcp.json` (global)
4. `<userData>/mcp.json` (global; also accepts the legacy `{ "servers": [...] }` shape)

The format matches Cursor / Claude Desktop — a top-level `mcpServers` object. See
[`mcp.json.example`](./mcp.json.example):

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${env:GITHUB_PERSONAL_ACCESS_TOKEN}" }
    }
  }
}
```

- **Transports:** local subprocess (`command`/`args`) or remote Streamable HTTP (`url`).
- **Secrets:** reference environment variables with `${env:VAR}` (Cursor) or `${VAR}`
  (Claude Desktop). Keep project configs with secrets out of version control.
- **Flags:** `"disabled": true` keeps a definition without starting it;
  `"trusted": true` auto-runs the server's tools without per-call approval.

### Managing servers

Open **Settings → MCP servers** to see connection status and tool counts, reload
servers without restarting the app, and toggle auto-run of read-only tools.

### Approvals

By default every MCP tool call prompts for approval. Read-only tools can be
auto-allowed via a setting, destructive tools always prompt, trusted servers skip
prompts, and the approval dialog offers an "always allow this tool" checkbox.
