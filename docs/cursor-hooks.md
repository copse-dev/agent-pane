# Cursor hooks support in Copse

[Cursor hooks](https://cursor.com/docs/hooks) are user-provided scripts registered in a
`hooks.json` file that the agent spawns at points in its loop. Each hook is a process
that receives a JSON payload on **stdin**, may print a JSON response on **stdout**, and
can observe, block, or annotate the action that triggered it.

This document records the Cursor hooks contract, what Copse honours today, and what
remains for fuller parity. It is the hooks counterpart to
[`docs/cursor-plugins.md`](./cursor-plugins.md).

## On-disk layout

```
~/.cursor/hooks.json        # user hooks — always honoured
<workspace>/.cursor/hooks.json  # project hooks — only when the workspace is trusted
```

Example `hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "beforeShellExecution": [{ "command": "./hooks/audit.sh" }],
    "beforeMCPExecution": [{ "command": "node hooks/mcp-guard.js" }],
    "beforeReadFile": [{ "command": "./hooks/redact.sh" }]
  }
}
```

`command` is a shell command spawned with the directory of the `hooks.json` as its
working directory, so relative paths resolve against the config.

## Hook events and I/O

Each hook receives a base payload — `conversation_id`, `generation_id`,
`hook_event_name`, `workspace_roots` — plus event-specific fields.

| Event                  | stdin (event fields)      | stdout                                   | Copse                   |
| ---------------------- | ------------------------- | ---------------------------------------- | ----------------------- |
| `beforeShellExecution` | `command`, `cwd`          | `{ permission: "allow"\|"deny"\|"ask" }` | ✅ honoured             |
| `beforeMCPExecution`   | `tool_name`, `tool_input` | `{ permission: "allow"\|"deny"\|"ask" }` | ✅ honoured             |
| `beforeReadFile`       | `file_path`, `content`    | `{ permission: "allow"\|"deny" }`        | ✅ honoured (path only) |
| `beforeSubmitPrompt`   | `prompt`, `attachments`   | `{ continue: boolean }`                  | ❌ not wired            |
| `afterFileEdit`        | `file_path`, `edits`      | none (notification)                      | ❌ not wired            |
| `stop`                 | `status`                  | none (notification)                      | ❌ not wired            |

Permission responses may also carry `agentMessage` / `userMessage`. Copse logs the
`agentMessage` from a denying hook; surfacing it into the conversation is future work.

## What Copse supports

| Capability                   | Status        | Notes                                                                                     |
| ---------------------------- | ------------- | ----------------------------------------------------------------------------------------- |
| **Permission hooks**         | Supported     | `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile` run in the permission gate |
| **User hooks**               | Supported     | `~/.cursor/hooks.json`, always honoured                                                   |
| **Project hooks**            | Supported     | `<root>/.cursor/hooks.json`, only when the workspace is trusted (#100)                    |
| **Hook discovery / list**    | Supported     | `hooks:list` IPC returns `CursorHookSummary[]` for diagnostics                            |
| **Lifecycle hooks**          | Not supported | `beforeSubmitPrompt`, `afterFileEdit`, `stop` need agent-loop / write-path wiring         |
| **`beforeReadFile` content** | Partial       | Hook sees the path but not the file contents (read happens after the gate)                |
| **Content rewriting**        | Not supported | Hooks can block but not yet mutate prompts, read output, or edits                         |
| **Plugin-contributed hooks** | Not supported | Marketplace plugins do not declare hooks in current `plugin.json` examples                |
| **Settings UI**              | Not supported | Toggle exists in storage (`cursorHooksEnabled`); no dedicated Settings section yet        |

### Enablement

Hooks are **off by default**. Honouring a hook spawns a user/project script on the
agent's hot path, so it is gated behind the `cursorHooksEnabled` security setting. When
disabled the gate skips discovery entirely (no overhead).

### Implementation

Discovery, parsing, and the stdio runner live in
[`src/main/services/cursor-hooks.ts`](../src/main/services/cursor-hooks.ts):

- `listCursorHooks()` — discovered hooks for the current context (diagnostics / `hooks:list`)
- `runPermissionHooks(event, payload, opts)` — spawn the hooks for an event and reduce
  their responses to a single decision

The permission gate ([`permission-gate.ts`](../src/main/services/permission-gate.ts))
maps a tool call to its hook event and consults `runPermissionHooks` before its own
logic. Hooks can only **tighten** the gate: a `deny` blocks the call, but an `allow`
still flows through Copse's normal prompting — a hook can never auto-approve something
Copse would otherwise ask about.

### Reliability and trust

- **Fail open.** A missing config, crash, timeout (5s), or unparseable response is
  treated as `allow`, so a broken hook never silently wedges the agent.
- **No LLM secrets.** Hook processes inherit `envForRendererChildProcess()` — the same
  scrubbed environment as `run_shell`, so provider API keys never reach hook scripts.
- **Output is capped** at 1 MB to bound a runaway hook.

| Source                        | Trust                                                         |
| ----------------------------- | ------------------------------------------------------------- |
| `~/.cursor/hooks.json` (user) | Trusted — the user authored it                                |
| `<root>/.cursor/hooks.json`   | Requires workspace trust (#100); skipped for untrusted clones |

## Gaps and future work

1. **Lifecycle hooks** — wire `beforeSubmitPrompt` (compose path), `afterFileEdit`
   (diff queue / write tools), and `stop` (end of an agent run).
2. **Surface `agentMessage`** — feed a denying hook's message back into the conversation
   instead of only logging it.
3. **`beforeReadFile` content** — pass file contents and honour content rewrites/redaction.
4. **Settings UI** — expose `cursorHooksEnabled` and discovered hooks (event, command,
   scope) alongside the plugins list.
5. **Plugin-contributed hooks** — if Cursor adds a `hooks` slot to `plugin.json`, load
   them via the shared `cursor-plugins` discovery module.

## Related files

- `src/main/services/cursor-hooks.ts` — discovery, parsing, and the stdio runner
- `src/main/services/permission-gate.ts` — maps tool calls to permission hooks
- `src/shared/types/cursor-hooks.ts` — `CursorHookEvent` / `CursorHookSummary`
- `src/main/services/child-process-env.ts` — secret-scrubbed env for hook processes
- `docs/cursor-plugins.md` — sibling exploration of Cursor plugin support
- `docs/supply-chain-security.md` — trust boundaries for executed code
