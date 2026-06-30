# ACP Client Support Plan

Status: **In progress.** The protocol core and the first app-wiring slice (model
routing `acp:<id>`, settings-backed agent registry, picker entries, text
streaming, `session/request_permission` → approval, `fs/read_text_file` and
`fs/write_text_file` → workspace + diff-approval queue, `session/cancel` →
abort) have landed. See [`docs/acp-agents.md`](../acp-agents.md) for setup and
the remaining work (terminals, session resume, MCP forwarding, Settings UI) in
issue #264, Track 1 (C2/C3).

## Goal

Add [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) support to agent-pane so the app can act as an **ACP Client** and consume external coding agents (Gemini CLI, Copilot CLI, Cline, OpenCode, etc.) instead of only calling LLM APIs directly via the built-in agent loop.

## Background

Today agent-pane is both **client** and **agent**:

- **Main process** runs `runAgentLoop`, calls `LLMProvider.stream()`, executes tools via `ToolRegistry`, persists `llm-history:{threadId}`.
- **Renderer** is a UI shell driven by `StreamChunk` events over `agent:chunk` IPC.

ACP decouples these roles:

| Role                            | Responsibility                                                        |
| ------------------------------- | --------------------------------------------------------------------- |
| **Client** (agent-pane)         | UI, workspace context, filesystem/terminal access, permission prompts |
| **Agent** (external subprocess) | LLM loop, tool planning/execution, session state                      |

Transport today is **JSON-RPC 2.0 over stdio** (client spawns agent subprocess). Remote HTTP/WebSocket is on the roadmap but not stable yet.

## Relationship to Other Work

- **PR #271** (`jkt/auto/remote-agent-chat-7279`) adds a **Cursor Cloud Agent HTTP/SSE backend** (`remote-agent:*` models). That is complementary but **not ACP**: it uses Cursor's REST API, not JSON-RPC stdio with bidirectional client callbacks (`fs/*`, `terminal/*`, `session/request_permission`).
- ACP and remote Cursor agents can coexist as separate model backends selected in the model picker.

## Architecture Overview

```
Current:
  Renderer → agent:run → agent-service → runAgentLoop → LLMProvider + ToolRegistry

ACP:
  Renderer → agent:run → AcpAgentService → ClientSideConnection (stdio) → External Agent
                                              ↑
                                              └── agent calls back: fs/*, terminal/*, session/request_permission
  External Agent → session/update → adapt → StreamChunk → agent:chunk → Renderer
```

ACP is **not** a drop-in `LLMProvider`. It replaces the entire `agent-service → runAgentLoop → ToolRegistry` path for a given conversation.

## Recommended Strategy

**Option A — Parallel backend (recommended)**

Route by model prefix:

- `acp:<agentId>` → `AcpAgentService`
- everything else → existing `agent-service`

Do **not** wrap ACP in `LLMProvider.stream()` — the external agent owns the loop and needs bidirectional JSON-RPC.

## Proposed Module Layout

```
src/main/services/acp/
  acp-agent-registry.ts      # configured agents (command, args, env)
  acp-connection-manager.ts  # spawn, initialize, lifecycle per agent process
  acp-session-store.ts       # threadId ↔ acpSessionId, agentId, capabilities
  acp-client-handlers.ts     # fs, terminal, permission JSON-RPC handlers
  acp-update-adapter.ts      # session/update → StreamChunk
  acp-agent-service.ts       # runAgent / abortAgent for ACP threads

src/shared/types/acp.ts      # config + session mapping types
```

Use **`@agentclientprotocol/sdk`** (`ClientSideConnection` for stdio). The repo already spawns MCP servers similarly in `src/main/services/mcp-registry.ts`.

## Connection Lifecycle

1. **`initialize`** — negotiate protocol v1, exchange capabilities
2. **`authenticate`** — if agent advertises `authMethods`
3. **`session/new`** or **`session/resume`** — with `cwd` (absolute workspace path) and `mcpServers` from `userData/mcp.json`
4. **`session/prompt`** — user content as ACP `ContentBlock[]`
5. Stream **`session/update`** notifications → adapt to `StreamChunk` → `agent:chunk`
6. Handle agent → client requests: `fs/read_text_file`, `fs/write_text_file`, `terminal/*`, `session/request_permission`
7. **`session/cancel`** on user abort; **`session/close`** on thread delete (if supported)

## Mapping to Existing Code

| Existing                           | ACP reuse                                        |
| ---------------------------------- | ------------------------------------------------ |
| `StreamChunk` + `agent:chunk`      | Primary UI adapter target                        |
| `src/renderer/controller/agent.ts` | Unchanged if chunks stay compatible              |
| `mcp-registry.ts` / `mcp.json`     | Forward as `mcpServers` on session create/resume |
| `approval.ts`                      | Map `session/request_permission`                 |
| `workspace.ts`                     | Back `fs/read_text_file` / path sandboxing       |
| `terminal-service.ts`              | Back `terminal/*` (headless pty sessions)        |
| `model-options.ts`                 | Add "ACP Agents" optgroup                        |

| Current behavior                       | ACP gap                                                           |
| -------------------------------------- | ----------------------------------------------------------------- |
| `llm-history:{threadId}`               | Agent owns history; store `acpSessionId` per thread               |
| `write_file` → diff queue              | Agent calls `fs/write_text_file` directly — need intercept policy |
| Local `ToolRegistry` execution         | Disabled in ACP mode; agent runs its own tools                    |
| `context_trimmed` / subagent `explore` | Partial parity; agent-specific                                    |

## Key Design Decisions

### 1. Write path (diff approval vs direct write)

ACP agents expect `fs/write_text_file` to write immediately. agent-pane's signature UX is diff approval via `diff-queue.ts`.

**Recommended v1:** intercept `fs/write_text_file` → route through `stageDiff()` → block JSON-RPC response until user approves/rejects → write on approve.

Make this configurable per agent if some agents break on delayed writes.

### 2. Native tools in ACP mode

Disable local `ToolRegistry` execution for the parent turn. Forward user MCP servers only; do not double-connect the same MCP server from both agent-pane and the external agent.

### 3. Session persistence

| Store                    | Native mode    | ACP mode                        |
| ------------------------ | -------------- | ------------------------------- |
| `llm-history:{threadId}` | LLM transcript | Unused                          |
| `threads:{projectId}`    | UI state       | UI state                        |
| `acp-session:{threadId}` | N/A            | `acpSessionId` + agent metadata |

Prefer `session/resume` when agent advertises `sessionCapabilities.resume`.

### 4. Content mapping (prompt → ACP)

| agent-pane         | ACP                                                                   |
| ------------------ | --------------------------------------------------------------------- |
| Plain text         | `{ type: 'text', text }`                                              |
| Image attachments  | `{ type: 'image', ... }` if agent supports `promptCapabilities.image` |
| `@file` references | `{ type: 'resource', resource: { uri, text } }` if `embeddedContext`  |

### 5. Protocol version

Target **ACP v1** initially. Isolate adapter behind version check at `initialize`; v2 RFDs change tool call update semantics.

## `session/update` → `StreamChunk` Adapter

| ACP `sessionUpdate`   | `StreamChunk`                                                          |
| --------------------- | ---------------------------------------------------------------------- |
| `agent_message_chunk` | `{ type: 'text', text }`                                               |
| `tool_call`           | `{ type: 'tool_call', toolCall: { id, name: title, args: rawInput } }` |
| `tool_call_update`    | Update tool card status/result                                         |
| `plan`                | New UI (Phase 4)                                                       |
| `thought_chunk`       | Activity indicator or new chunk type                                   |

## Client Capabilities to Advertise

```json
{
  "clientCapabilities": {
    "fs": { "readTextFile": true, "writeTextFile": true },
    "terminal": true
  },
  "clientInfo": { "name": "agent-pane", "title": "Agent Pane", "version": "0.1.0" }
}
```

## Agent Configuration (Settings)

```ts
interface AcpAgentConfig {
  id: string // e.g. "gemini-cli"
  title: string // "Gemini CLI"
  command: string // absolute path or PATH lookup
  args: string[]
  env?: Record<string, string>
  enabled: boolean
  authMethodId?: string
}
```

Model values: `acp:gemini-cli`, `acp:copilot-cli`, etc.

Settings UI: new **ACP Agents** section — add/edit agents, test `initialize`, optional auth flow. Consider [ACP Registry](https://agentclientprotocol.com/get-started/registry) later.

## Routing

In `src/main/index.ts`:

```ts
const model = getSetting('model')
if (model.startsWith('acp:')) {
  await runAcpAgent(threadId, userContent, ...)
} else {
  await runAgent(threadId, userContent, ...) // existing
}
```

## Phased Rollout

### Phase 0 — Spike (1 agent, read-only)

- Add `@agentclientprotocol/sdk`
- Hardcode one agent (e.g. Gemini CLI)
- `initialize` → `session/new` → `session/prompt` → stream text to UI
- **Exit:** text-only Q&A end-to-end

### Phase 1 — MVP client capabilities

- `fs/read_text_file`, `fs/write_text_file` (with diff intercept)
- `session/request_permission` → approval dialog
- `session/cancel` + abort button
- Model routing `acp:*`

### Phase 2 — Terminals + session persistence

- `terminal/*` handlers
- `acp-session:{threadId}` + `session/resume`
- MCP forwarding from `mcp.json`
- Settings UI for agent CRUD

### Phase 3 — Multi-agent + auth

- Agent registry, connection pooling
- `authenticate` / `logout`
- Session config options, usage reporting

### Phase 4 — UX parity

- Plan updates, slash commands, modes
- `session/list` / `session/delete`
- E2E with mock ACP agent subprocess
- ACP Registry integration

### Phase 5 — Remote transport (future)

- Track [Streamable HTTP/WebSocket RFD](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport.md)

## Testing Strategy

| Layer       | Approach                                                       |
| ----------- | -------------------------------------------------------------- |
| Unit        | `acp-update-adapter.test.ts` — fixture JSON → `StreamChunk[]`  |
| Unit        | Client handlers — path sandboxing, diff intercept, permissions |
| Integration | SDK example agent or minimal mock over stdio                   |
| E2E         | Mock agent in WDIO; screenshots for tool cards                 |

## Risks

| Risk                          | Mitigation                                                  |
| ----------------------------- | ----------------------------------------------------------- |
| Write intercept breaks agents | Per-agent policy: direct vs diff approval                   |
| Agent stderr on stdio         | Surface stderr in log panel; strict stdout discipline       |
| Session divergence            | Store `acpSessionId` immediately; prefer `session/resume`   |
| v2 protocol churn             | Version gate at `initialize`                                |
| Subprocess zombies            | Connection manager + idle timeout + `session/close` on quit |

## Success Criteria

1. User selects an ACP agent in the model dropdown and chats (agent brings its own auth).
2. External agent reads workspace files and proposes edits with agent-pane diff approval.
3. Tool calls render with human-readable labels; cancel works mid-turn.
4. Multi-turn threads resume after restart when agent supports it.
5. Native Anthropic/OpenAI/LM Studio path remains unchanged.

## Suggested First PR (Implementation)

1. `@agentclientprotocol/sdk` dependency
2. `acp-connection-manager.ts` + `acp-update-adapter.ts`
3. One hardcoded agent behind `acp:gemini` model
4. Text streaming + `session/cancel` only
5. Feature flag / hidden setting

Defer fs/terminal/permission to the follow-up PR.

## References

- [ACP Introduction](https://agentclientprotocol.com/get-started/introduction)
- [ACP Architecture](https://agentclientprotocol.com/get-started/architecture)
- [Protocol v1 Overview](https://agentclientprotocol.com/protocol/v1/overview)
- [TypeScript SDK](https://agentclientprotocol.com/libraries/typescript)
- [Supported Agents](https://agentclientprotocol.com/get-started/agents)
