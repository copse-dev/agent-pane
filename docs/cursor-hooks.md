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
    "beforeShellExecution": [{ "command": "./hooks/audit.sh", "failClosed": true }],
    "beforeMCPExecution": [{ "command": "node hooks/mcp-guard.js" }],
    "beforeReadFile": [{ "command": "./hooks/redact.sh" }]
  }
}
```

`command` is a shell command spawned with the directory of the `hooks.json` as its
working directory, so relative paths resolve against the config. A hook may set
`"failClosed": true` to make a crash / timeout / invalid JSON **block** the action
instead of failing open (see Reliability and trust below).

## Hook events and I/O

Each hook receives a base payload — `conversation_id`, `generation_id`,
`hook_event_name`, `workspace_roots` — plus event-specific fields. Every
agent-session event also carries the **model identity** of the model actually
running the turn: `model` (slug), `model_id`, and `model_params` (Cursor's
`{ id, value }[]` array — e.g. `context_window` / `max_output_tokens`), matching
the vendor contract (B4).

| Event                  | stdin (event fields)                                 | stdout                                   | Copse         |
| ---------------------- | ---------------------------------------------------- | ---------------------------------------- | ------------- |
| `beforeShellExecution` | `command`, `cwd`                                     | `{ permission: "allow"\|"deny"\|"ask" }` | ✅ honoured   |
| `beforeMCPExecution`   | `tool_name`, `tool_input`                            | `{ permission: "allow"\|"deny"\|"ask" }` | ✅ honoured   |
| `beforeReadFile`       | `file_path`, `content`                               | `{ permission: "allow"\|"deny" }`        | ✅ honoured   |
| `beforeSubmitPrompt`   | `prompt`, `attachments`                              | `{ continue: boolean }`                  | ✅ wired (B1) |
| `afterFileEdit`        | `file_path`, `edits`                                 | none (notification)                      | ✅ wired (B2) |
| `stop`                 | `status`                                             | none (notification)                      | ✅ wired (B3) |
| `afterShellExecution`  | `command`, `output`, `duration`                      | none (notification)                      | ✅ wired (D2) |
| `afterMCPExecution`    | `tool_name`, `tool_input`, `result_json`, `duration` | none (notification)                      | ✅ wired (D2) |

The real `conversation_id` (thread id) and `generation_id` (turn id) come from
the active run (B4); they are empty strings only when a hook fires outside any
agent turn.

Permission responses may also carry `agentMessage` / `userMessage`. A denying
hook's `agentMessage` is now **surfaced to the agent** as the tool-result reason
(B4) — a message-bearing `deny` fails the call with that reason so the model sees
why. A hook `ask` **escalates to Copse's approval prompt** (the same prompt a
policy `ask` uses): approving lets the call proceed, declining blocks it. A hook
still can only _tighten_ the gate — an `allow` never auto-approves something
Copse would otherwise prompt about.

`beforeReadFile` receives the file **content** on stdin (B4), so a redaction /
secret-detection hook can inspect the bytes and `deny`. Cursor's `beforeReadFile`
response is `allow` / `deny` only — there is no content-rewrite field in the
vendor contract — so "redaction" is expressed as _deny on inspection_, not by
returning modified content.

## What Copse supports

| Capability                    | Status        | Notes                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Permission hooks**          | Supported     | `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile` run in the permission gate                                                                                                                                                                                                                                              |
| **User hooks**                | Supported     | `~/.cursor/hooks.json`, always honoured                                                                                                                                                                                                                                                                                                |
| **Project hooks**             | Supported     | `<root>/.cursor/hooks.json`, only when the workspace is trusted (#100)                                                                                                                                                                                                                                                                 |
| **Hook discovery / list**     | Supported     | `hooks:list` IPC returns hooks + validation warnings for the Sources panel                                                                                                                                                                                                                                                             |
| **Lifecycle hooks**           | Supported     | `beforeSubmitPrompt` (B1), `afterFileEdit` (B2), `stop` (B3), `afterShellExecution` / `afterMCPExecution` (D2) are wired; every declared Cursor event now fires                                                                                                                                                                        |
| **Post-tool observation**     | Supported     | `afterShellExecution` / `afterMCPExecution` (D2) fire **detached** after each shell / MCP tool result — payload flavors of the one canonical `afterToolUse` event (the tool name picks the flavor, like the permission gates map onto `toolGate`). Notification-only; the output snapshot is capped before it reaches the hook's stdin |
| **`beforeReadFile` content**  | Supported     | The hook receives the file contents on stdin (B4) so it can inspect and `deny` (redaction = deny-on-inspection; Cursor has no content-rewrite response)                                                                                                                                                                                |
| **Model identity in payload** | Supported     | `model` / `model_id` / `model_params` on every agent-session event (B4), sourced from the model actually running                                                                                                                                                                                                                       |
| **`agentMessage` / `ask`**    | Supported     | A denying hook's `agentMessage` reaches the agent as the tool-result reason; a hook `ask` escalates to Copse's approval prompt (B4)                                                                                                                                                                                                    |
| **Content rewriting**         | Not supported | Hooks can block but not yet mutate prompts, read output, or edits (`updated_input` is H1)                                                                                                                                                                                                                                              |
| **Plugin-contributed hooks**  | Not supported | Marketplace plugins do not declare hooks in current `plugin.json` examples                                                                                                                                                                                                                                                             |
| **Settings UI**               | Supported     | Settings → Sources → Hooks: `cursorHooksEnabled` toggle, discovered hooks, per-entry validation warnings, per-hook runtime error state (first failure per session)                                                                                                                                                                     |

### Enablement

Hooks are **off by default**. Honouring a hook spawns a user/project script on the
agent's hot path, so it is gated behind the `cursorHooksEnabled` security setting
(Settings → Sources → Hooks). When disabled the gate skips discovery entirely (no
overhead); the Sources panel still lists discovered hooks so authoring problems are
visible before enabling.

### Implementation

Cursor is a **dialect adapter** (A2 of the hooks platform,
[`docs/plans/hooks-and-feature-packs.md`](plans/hooks-and-feature-packs.md), decision 8:
"dialect by source path"). Discovery, parsing, matchers, wire marshalling in both
directions, and the per-event exit-code table all live in
[`src/main/services/hooks/cursor-adapter.ts`](../src/main/services/hooks/cursor-adapter.ts):

- `listCursorHooks()` — discovered hooks for the current context (diagnostics / `hooks:list`)
- `cursorToolGateHooks(payload, opts)` — the Cursor command hooks matching a tool gate,
  as canonical `CommandHook`s (their `onFailure` set from `failClosed`)
- `cursorAdapter` — the `DialectAdapter` the shared runner delegates to (marshalling +
  the exit-code table)

The shared process spawn (stdin marshalling, stdout/stderr capture, timeout, output cap)
lives in [`hook-spawn.ts`](../src/main/services/hooks/hook-spawn.ts); the host runner in
[`command-hook-runner.ts`](../src/main/services/hooks/command-hook-runner.ts) spawns each
hook and applies its dialect's failure semantics.

The permission gate ([`permission-gate.ts`](../src/main/services/security/permission-gate.ts))
maps a tool call onto the canonical `toolGate` event and calls
`runToolGateHooks` ([`tool-gate.ts`](../src/main/services/hooks/tool-gate.ts)), which fires
the hooks through the registry → runner → adapter seam. Hooks can only **tighten** the gate:
a `deny` blocks the call, but an `allow` still flows through Copse's normal prompting — a
hook can never auto-approve something Copse would otherwise ask about.

### Reliability and trust

- **Fail open by default, `failClosed` honoured.** A missing config, crash, timeout (5s),
  or unparseable response is treated as `allow`, so a broken hook never silently wedges
  the agent. But Cursor's per-hook `failClosed: true` (`{ "command": …, "failClosed": true }`)
  reverses that for **that** hook: a crash / timeout / invalid JSON **blocks** the action
  instead — the vendor contract for imported security hooks (decision 9). The Cursor
  adapter reports the failure + the hook's resolved `onFailure`; the runner turns it into
  a deny (`failClosed`) or a no-op (the default).
- **No LLM secrets.** Hook processes inherit `envForRendererChildProcess()` — the same
  scrubbed environment as `run_shell`, so provider _LLM_ API keys never reach hook
  scripts. Note this is **not** an empty environment: non-LLM tool tokens that the agent
  uses (for example `GITHUB_TOKEN`) are still present — see the Security section below.
- **Output is capped** at 1 MB to bound a runaway hook.

| Source                        | Trust                                                         |
| ----------------------------- | ------------------------------------------------------------- |
| `~/.cursor/hooks.json` (user) | Trusted — the user authored it                                |
| `<root>/.cursor/hooks.json`   | Requires workspace trust (#100); skipped for untrusted clones |

## Security

Enabling Cursor hooks hands real, local execution authority to whoever authored the
`hooks.json`. Read this before turning the feature on.

**Enabling `cursorHooksEnabled` and trusting a workspace grants that repo's
`.cursor/hooks.json` arbitrary local code execution on every gated tool call.** Each
matching hook `command` is spawned through a shell (`shell: true`) on the agent's hot
path, with the directory of the `hooks.json` as its working directory. A trusted repo's
hooks run with the same authority as any other process you launch — they are **not**
confined to the agent's project sandbox.

Concretely, "trusting a workspace" with hooks enabled also means:

- **Arbitrary code on every tool call.** Any tool call that maps to a hook event
  (`beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`) spawns the repo's
  hook command first. A cloned or third-party repo can ship a `hooks.json` that runs
  whatever it likes, repeatedly, for the lifetime of the session.
- **Runs outside the sandbox.** Hook commands are ordinary child processes; they are not
  subject to the project sandbox that constrains agent shell/file tools. They can read
  and write anywhere your user account can.
- **Tool tokens are in the environment.** Hook processes inherit the scrubbed
  `envForRendererChildProcess()` environment. That strips _LLM provider_ keys, but
  **non-LLM tool tokens used by the agent (e.g. `GITHUB_TOKEN`) remain in `env`** and are
  therefore readable by a hook script.
- **Fail open — can tighten, never relied on to block.** Hooks fail open by design
  (timeout, crash, non-JSON, or oversized output → treated as `allow`). A hook can
  _tighten_ Copse's permission gate (a `deny` blocks a call), but it can never be relied
  upon to block: do not treat a `deny`-returning hook as a security control, because any
  failure path silently degrades to `allow`.

**Mitigations and guidance:**

- The feature is **off by default**. Leave it off unless you specifically need it.
- Only enable it for workspaces you would already trust to run arbitrary code on your
  machine — the same bar as running the repo's build scripts or `npm install`.
- Project hooks are only honoured when the workspace is trusted (#100); untrusted clones
  are skipped entirely. Trust is the gate — granting it is the consent.
- When a **project-supplied** hook command runs for the first time in a session, Copse
  logs a one-time warning naming the command, so it is auditable in the logs.

This is the same trust boundary described in
[`docs/supply-chain-security.md`](./supply-chain-security.md): trusting a workspace means
trusting the code it can cause to run.

## Gaps and future work

1. **Content rewriting** — `updated_input` on tool gates (rewrite the proposed tool
   input, re-running policy analysis) is Phase H1, not yet wired.
2. **Hook cards** — deny/ask decisions and hook executions surface today through the
   existing text / approval-prompt channels; the dedicated right-aligned hook-card
   UI family is Phase G1. `userMessage` on a plain deny (no approval prompt) waits
   for that card surface.
3. **Claude `SessionStart` model** — the wire payload type carries the running model
   (`AgentSessionInfo`), but Claude's optional `model` on `sessionStart` needs the
   `sessionStart` fire site, which is Phase H4; Cursor agent-session events carry
   model identity now (B4).
4. **Plugin-contributed hooks** — if Cursor adds a `hooks` slot to `plugin.json`, load
   them via the shared `cursor-plugins` discovery module.

## Related files

- `src/main/services/hooks/cursor-adapter.ts` — Cursor dialect adapter: discovery, parsing
  (incl. `failClosed`), matchers, wire marshalling, exit-code table
- `src/main/services/hooks/claude-adapter.ts` — Claude Code PreToolUse dialect adapter (#639)
- `src/main/services/hooks/hook-spawn.ts` — shared process spawn + stdout/stderr capture
- `src/main/services/hooks/command-hook-runner.ts` — host runner; applies dialect failure semantics
- `src/main/services/hooks/tool-gate.ts` — maps tool calls onto the canonical `toolGate` event
- `src/main/services/security/permission-gate.ts` — calls the tool-gate hooks
- `src/shared/types/cursor-hooks.ts` — `CursorHookEvent` / `CursorHookSummary`
- `src/shared/types/hooks.ts` — shared `HookSummary` for Sources / `hooks:list`
- `src/main/services/exec/child-process-env.ts` — secret-scrubbed env for hook processes
- `docs/claude-hooks.md` — Claude Code hooks contract
- `docs/cursor-plugins.md` — sibling exploration of Cursor plugin support
- `docs/supply-chain-security.md` — trust boundaries for executed code
