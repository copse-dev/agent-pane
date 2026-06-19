## Summary

agent-pane should be a first-class MCP **host**: users can connect external MCP servers, expose their tools (and eventually resources/prompts) to the agent loop, manage configuration through the UI, and operate with the same security and UX expectations as built-in tools.

There is already a minimal MCP integration — stdio transport, tools-only, manual `mcp.json` in userData, per-call approval — but it is not sufficient for day-to-day use or parity with other MCP hosts (Cursor, Claude Desktop, VS Code, etc.).

---

## Problem / motivation

Developers increasingly rely on MCP servers for GitHub, databases, browsers, cloud APIs, and custom internal tools. Without robust MCP support, agent-pane cannot:

- Reuse existing MCP server configs (`.cursor/mcp.json`, `~/.cursor/mcp.json`)
- Connect to remote HTTP MCP servers (GitHub Copilot MCP, enterprise gateways)
- Surface MCP tool schemas correctly to the LLM (today parameters are `z.unknown()`)
- Manage servers without hand-editing JSON in `~/.config/agent-pane/mcp.json`
- See connection status, logs, or which tools are available
- Trust that MCP failures are handled gracefully (startup errors are console-only today)

The README already advertises MCP alongside built-in tools, but the implementation is an MVP.

---

## Current baseline (as of `src/main/services/mcp-registry.ts`)

| Area | Current behavior |
|------|------------------|
| **Config** | `{userData}/mcp.json` with `{ servers: [{ name, command, args, env? }] }` — non-standard shape |
| **Transport** | Stdio only (`StdioClientTransport`) |
| **Primitives** | Tools only (`listTools` → `callTool`) |
| **Registration** | Once at app startup; tools named `mcp__{server}__{tool}` |
| **Schema** | `parameters: z.unknown()` — MCP JSON Schema not forwarded to LLM |
| **Permissions** | Every MCP tool call prompts via approval dialog (`type: 'mcp'`) |
| **UI** | No settings section; no status indicator; fallback tool display names |
| **Lifecycle** | `shutdownMcpServers()` on quit; no reconnect, hot-reload, or per-project config |
| **Tests** | None for MCP |

Relevant integration points:

- Tool registry: `src/main/services/tool-registry.ts`
- Permission gate: `src/main/services/permission-gate.ts`, `permission-policy.ts`
- Agent loop: `src/shared/agent/run-agent-loop.ts` (provider-agnostic; MCP tools flow through registry)
- Approval UI: `src/renderer/views/approval-dialog.ts`

---

## Goals

1. **Config compatibility** — Support the de-facto `mcpServers` JSON format used by Cursor and Claude Desktop.
2. **Multiple transports** — Stdio (local subprocess) and Streamable HTTP (remote servers).
3. **Correct tool schemas** — Pass MCP tool `inputSchema` through to LLM providers as JSON Schema.
4. **Manageable UX** — Settings UI to add/edit/remove servers, view status, and reload without restarting the app.
5. **Security model** — Granular approval (per-server, per-tool, remember choice), secret handling, clear audit trail in conversation UI.
6. **Reliability** — Graceful startup failures, reconnection, abort/cancel in-flight MCP calls, structured error messages to the model.
7. **Observability** — Connection status, tool count, stderr/log capture for debugging.
8. **Test coverage** — Unit tests for config parsing, permission policy, schema mapping; e2e with a mock MCP server.

---

## Non-goals (initial release)

These can be follow-up issues:

- **Sampling** (server-initiated LLM calls) — complex; requires user consent flows per MCP spec
- **Elicitation** (server asks user for input mid-tool-call)
- **Roots** (client advertises filesystem boundaries to server)
- **Resource subscriptions** (push updates)
- **MCP Registry/marketplace** integration
- **OAuth 2.1** for HTTP servers (may be required for some enterprise servers — track as phase 2)

---

## Requirements

### 1. Configuration

#### 1.1 Config file locations and precedence

Support multiple config sources, merged with clear precedence (highest wins for duplicate server names):

| Priority | Location | Scope |
|----------|----------|-------|
| 1 | `<workspace>/.cursor/mcp.json` | Per-project |
| 2 | `<workspace>/.mcp.json` | Per-project (Claude Code convention) |
| 3 | `~/.cursor/mcp.json` | Global |
| 4 | `{userData}/mcp.json` | Global (agent-pane legacy; migrate format) |

**Acceptance:** Opening a project with `.cursor/mcp.json` automatically loads its servers. Switching projects reloads MCP servers for the new workspace.

#### 1.2 Config schema

Adopt the standard top-level `mcpServers` object:

```json
{
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${env:GITHUB_PERSONAL_ACCESS_TOKEN}"
      }
    },
    "remote-api": {
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:MY_API_KEY}"
      }
    }
  }
}
```

**Stdio server fields:** `command`, `args?`, `env?`, `cwd?` (optional working directory)

**HTTP server fields:** `url`, `headers?`, `type?: "http"` (optional explicit marker)

**Env var interpolation:**

- `${env:VAR_NAME}` — Cursor-style (required)
- `${VAR_NAME}` — Claude Desktop-style (nice-to-have for copy-paste compatibility)
- Never persist resolved secrets back to disk when saving from UI

**Migration:** On first load, if legacy `{userData}/mcp.json` uses `{ servers: [...] }`, convert to `mcpServers` format (or read both during transition).

#### 1.3 Per-server enable/disable

Each server entry should support an optional `"disabled": true` flag so users can keep config without spawning the process.

---

### 2. Transports

#### 2.1 Stdio (required)

- Spawn subprocess via `@modelcontextprotocol/sdk` `StdioClientTransport`
- Inherit `process.env`, overlay server `env`
- Set `cwd` to workspace root when configured (or server-specific `cwd`)
- Kill subprocess on app quit and on server disable/remove
- Capture stderr for diagnostics (surface in Settings → MCP logs panel)

#### 2.2 Streamable HTTP (required)

- Use SDK `StreamableHTTPClientTransport` (or equivalent in `@modelcontextprotocol/sdk` ^1.12)
- Support `url` + optional `headers` from config
- Handle session lifecycle (`Mcp-Session-Id` if server is stateful)
- Respect abort signals when user cancels agent run

#### 2.3 Transport selection logic

```
if config.url → HTTP transport
else if config.command → stdio transport
else → config error (surfaced in UI)
```

**Out of scope for v1:** deprecated HTTP+SSE-only transport (unless trivial via SDK); document workaround.

---

### 3. MCP primitives exposed to the agent

#### 3.1 Tools (required — extend current behavior)

For each tool from `tools/list`:

1. Register in `ToolRegistry` as `mcp__{serverName}__{toolName}`
2. **Forward `inputSchema`** from MCP as LLM tool parameters (not `z.unknown()`)
   - Validate args against schema before `callTool` when possible
   - Fall back to passthrough if schema is missing or invalid
3. Map `callTool` results to agent string output:
   - Concatenate `text` content blocks (current behavior)
   - Also handle `image`, `resource` link types where present (structured content → markdown or JSON summary)
   - Surface `isError: true` tool results as tool errors in the conversation UI
4. Honor MCP tool annotations when available (`readOnlyHint`, `destructiveHint`, `openWorldHint`) for permission defaults (see §5)

#### 3.2 Resources (phase 1.5 or v2 — specify now for design)

MCP resources are read-only context the model/host can fetch. Minimum viable approach:

- **Option A (agent tool):** Register a built-in `read_mcp_resource` tool the model can call with `{ server, uri }`
- **Option B (user UI):** Resource browser in sidebar; user @-mentions a resource into the prompt
- **Option C (auto-inject):** Server advertises "important" resources in system prompt (fragile)

**Recommendation:** Option A for v1 of resources — smallest change to agent loop.

Requirements when implemented:

- `resources/list`, `resources/read`
- URI shown in tool card; content truncated like `read_file`
- Same approval model as tools if resource is external

#### 3.3 Prompts (optional / v2)

- `prompts/list`, `prompts/get`
- Expose in UI similar to skills picker (`/prompt-name` or MCP section in command palette)
- Insert resolved prompt messages into the user turn

---

### 4. Lifecycle and runtime behavior

#### 4.1 Startup

Current flow in `src/main/index.ts`:

```
createRegistry() → loadMcpServers(registry) → agent IPC ready
```

Required changes:

1. Parse and merge configs from all sources
2. Connect to each enabled server in parallel (with timeout, e.g. 30s per server)
3. Register tools into the shared `ToolRegistry`
4. Record per-server status: `{ name, status: 'connected' | 'error' | 'disabled', toolCount, error?, transport }`
5. **Do not block app launch** on MCP failures — built-in tools must work even if all MCP servers fail

#### 4.2 Hot reload

Trigger reload when:

- User saves MCP settings in UI
- Workspace project changes (different `.cursor/mcp.json`)
- User clicks "Reconnect" on a failed server

Reload steps:

1. Unregister all `mcp__*` tools from registry
2. Close existing MCP clients
3. Re-read config and reconnect

#### 4.3 Agent run integration

- MCP tools appear in `registry.toLLMTools()` alongside built-in tools
- Account for MCP tool schema size in context budget (`toolSchemaReserveTokens` in `run-agent-loop.ts`) — many MCP servers export 20+ tools with large schemas
- Consider **tool filtering**: setting to enable/disable MCP tools per server for a thread, or cap visible MCP tools when over token budget
- `AbortSignal` from agent abort must cancel in-flight `callTool` requests

#### 4.4 Shutdown

- Keep `shutdownMcpServers()` on `before-quit`
- Ensure orphaned stdio child processes are killed (including on reload)

---

### 5. Security and permissions

MCP servers can access networks, secrets, and systems outside the workspace. This must be treated as **trusted-code execution with user consent**.

#### 5.1 Default approval policy

Current: every `mcp__*` call prompts. Improve to:

| Condition | Default behavior |
|-----------|------------------|
| Tool has `readOnlyHint: true` | Auto-allow (configurable) |
| Tool has `destructiveHint: true` | Always prompt |
| Server marked `trusted: true` in config | Auto-allow all tools (explicit opt-in) |
| First call to unknown tool | Prompt with "Remember for this server" checkbox |
| User rejected | Return `User rejected the {tool} tool call.` (existing pattern) |

Persist remembered approvals in `{userData}/mcp-approvals.json` (server + tool granularity).

#### 5.2 Approval dialog improvements

Current dialog (`approval-dialog.ts`) shows raw JSON. Enhance for MCP:

- Title: `MCP tool: {server}/{tool}` (already via `mcpToolLabel`)
- Body: formatted args (syntax-highlighted JSON or key-value table)
- Show server description if available
- Show annotation hints: "Read-only", "Destructive", "May access network"
- Optional: "Always allow tools from this server" / "Always allow this tool"

#### 5.3 Secrets

- Never log env vars or HTTP headers at info level
- Settings UI uses password inputs for env values
- Prefer `${env:VAR}` references over inline secrets in saved config
- Document that project-level `.cursor/mcp.json` with secrets should be gitignored

#### 5.4 Process isolation

- Stdio MCP servers run as child processes (same user privileges as agent-pane)
- Document security implications in user-facing docs
- Future: optional sandbox wrapper for stdio servers (non-goal for v1)

---

### 6. UI / UX

#### 6.1 Settings → MCP section (new)

Add a **"MCP Servers"** section to `settings-dialog.ts` (alongside General, Local models, Appearance):

- List configured servers with status badge (connected / error / disabled)
- Tool count per server
- Actions: Add server, Edit, Disable, Reconnect, Remove
- Add-server wizard:
  - Type: Local (stdio) vs Remote (HTTP)
  - Fields matching config schema
  - "Test connection" button → runs handshake, lists tools, shows errors
- Link to open config file in editor
- Toggle: "Use project MCP config" (default on)

#### 6.2 Conversation tool display

Extend `src/shared/tools/tool-display.ts`:

- MCP tools grouped under **"MCP tools"** or per-server groups (`GitHub ×3`)
- Display name: humanize tool name, not full `mcp__github__create_issue`
- Show server badge/icon in tool card header
- Failed MCP tools show server error text from `isError` results

#### 6.3 Status indicator

- Footer or context panel: "MCP: 3 servers, 24 tools" with warning if any server errored
- Click → opens MCP settings

#### 6.4 Empty / error states

- No MCP config: "No MCP servers configured. Add servers in Settings or create `.cursor/mcp.json`."
- Server failed: show actionable error (command not found, auth failed, timeout)

---

### 7. LLM provider compatibility

MCP tool schemas must work across providers:

| Provider | Consideration |
|----------|---------------|
| Anthropic | Native tool_use; strict JSON Schema |
| OpenAI | function calling; schema subset |
| LM Studio / local | May have smaller context; may need schema simplification or tool subset |

Requirements:

- Strip or coerce JSON Schema features unsupported by a provider (document limitations)
- Truncate very long tool descriptions
- Log warning when MCP tool count exceeds a threshold (e.g. >30 tools)

---

### 8. Architecture / implementation sketch

```
src/main/services/
  mcp-registry.ts          → expand: config merge, transports, status, reload
  mcp-config.ts            → parse/validate mcpServers, env interpolation, migration
  mcp-client.ts            → per-server Client wrapper (connect, listTools, callTool, close)
  mcp-permissions.ts       → approval policy, remembered grants
  mcp-schema.ts            → MCP inputSchema → LLMTool parameters mapping

src/renderer/views/
  mcp-settings.ts          → Settings UI section
  approval-dialog.ts       → MCP-specific formatting

src/shared/tools/
  tool-display.ts          → MCP grouping and labels

src/shared/types/
  mcp.ts                   → McpServerConfig, McpServerStatus, IPC types
```

**IPC additions** (extend `src/shared/types/ipc.ts`):

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `mcp:list` | invoke | Return server statuses + tool names |
| `mcp:reload` | invoke | Hot-reload all servers |
| `mcp:test` | invoke | Test single server config |
| `mcp:status_changed` | event | Push status updates to renderer |

Keep MCP logic in **main process** only (subprocess spawn, HTTP, secrets).

---

### 9. Testing

#### 9.1 Unit tests

- `mcp-config.test.ts` — parse stdio/HTTP configs, env interpolation, merge precedence, legacy migration
- `mcp-schema.test.ts` — inputSchema → OpenAPI3 JSON Schema mapping
- `mcp-permissions.test.ts` — readOnly auto-allow, destructive prompt, remembered approvals
- `permission-gate.test.ts` — extend with MCP cases
- `tool-display.test.ts` — MCP grouping and labels

#### 9.2 Integration / e2e

- Mock MCP server using `@modelcontextprotocol/sdk` server side over stdio (fixture in `tests/fixtures/mock-mcp-server.mts`)
- Seed config pointing at mock server
- Playwright test: agent run triggers MCP tool → approval dialog → tool card shows human name
- Test: MCP server fails to start → app still launches, built-in tools work

---

### 10. Documentation

- README section: MCP setup, config examples, security notes
- Example `.cursor/mcp.json.example` in repo (no secrets)
- AGENTS.md: how to run e2e with mock MCP server
- Document compatibility with Cursor/Claude Desktop configs

---

## Acceptance criteria (definition of done)

- [ ] User can add a stdio MCP server via Settings and see its tools without editing JSON manually
- [ ] User can add a Streamable HTTP MCP server with bearer auth headers
- [ ] Project `.cursor/mcp.json` is loaded when a workspace is open
- [ ] MCP tool JSON Schema is passed to the LLM (verified via provider request fixture or mock)
- [ ] MCP tool calls respect approval policy (prompt / remember / auto for read-only)
- [ ] MCP tool results and errors render correctly in conversation UI
- [ ] Failed MCP server does not prevent app or agent from working
- [ ] User can reload MCP servers without restarting the app
- [ ] `npm run check` passes including new unit tests
- [ ] E2e test covers at least one MCP tool call end-to-end with mock server

---

## Open questions

1. **Tool naming length** — Cursor errors when `server+tool` names exceed ~60 chars. Should we hash long names or truncate?
2. **Context budget** — With 5 servers × 10 tools, schema tokens may dominate. Ship tool subsetting in v1 or v2?
3. **Project vs global config UI** — Should Settings edit global only, with read-only view of project overrides?
4. **Built-in vs MCP overlap** — If both `git_*` built-ins and GitHub MCP exist, do we dedupe or expose both?
5. **OAuth HTTP servers** — Required for some enterprise MCP endpoints; scope for follow-up issue?
6. **Legacy config** — How long to support `{userData}/mcp.json` `{ servers: [] }` format?

---

## Suggested implementation phases

| Phase | Scope |
|-------|-------|
| **Phase 1** | Config parser (`mcpServers`), stdio + HTTP transports, schema forwarding, hot reload, basic Settings list/status |
| **Phase 2** | Approval policy (remember, annotations), improved tool display, stderr logging |
| **Phase 3** | Resources via `read_mcp_resource` tool, project config auto-reload on workspace change |
| **Phase 4** | Prompts picker, OAuth HTTP, tool subsetting for context limits |

---

## References

- [MCP Specification](https://modelcontextprotocol.io/specification/2025-11-25/index)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (already dependency `@modelcontextprotocol/sdk`)
- Existing code: `src/main/services/mcp-registry.ts`, `src/main/services/permission-gate.ts`
- Cursor config: `~/.cursor/mcp.json`, `.cursor/mcp.json`
