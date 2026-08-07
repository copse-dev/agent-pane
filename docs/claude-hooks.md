# Claude Code hooks support in Copse

[Claude Code hooks](https://code.claude.com/docs/en/hooks) are scripts registered under
`hooks` in Claude settings JSON. Copse loads every event whose canonical fire point
exists — the `PreToolUse` gate plus `SessionStart`, `PostToolUse`, `UserPromptSubmit`,
`Stop`, and `SubagentStop` — so repos that already ship Claude Code hooks work without a
Cursor-format `hooks.json`. Tracks issue #639.

This is the Claude counterpart to [`docs/cursor-hooks.md`](./cursor-hooks.md). For the
dialect-agnostic architecture (registry, canonical events, async/budget/epoch, spine,
sandbox, UI) see [`docs/hooks.md`](./hooks.md).

## On-disk layout

```
~/.claude/settings.json              # user — always honoured
<workspace>/.claude/settings.json    # project — only when the workspace is trusted
<workspace>/.claude/settings.local.json  # local overrides — same trust gate
```

Example settings fragment:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "./hooks/block-rm.sh" }]
      }
    ]
  }
}
```

`command` is spawned with the directory of the settings file as its working directory.

## What Copse supports

| Capability                         | Status        | Notes                                                                                |
| ---------------------------------- | ------------- | ------------------------------------------------------------------------------------ |
| **`PreToolUse` commands**          | Supported     | Matcher + `type: "command"` handlers; same trust model as Cursor                     |
| **Exit code 2 deny**               | Supported     | stderr (else stdout) becomes the agent-facing deny reason                            |
| **JSON `permissionDecision`**      | Supported     | `allow` / `deny` / `ask`; `defer` mapped to `ask`                                    |
| **`SessionStart`**                 | Supported     | Fire-and-forget on a new conversation (source `startup`)                             |
| **`PostToolUse`**                  | Supported     | Detached observation; matcher on the Claude tool name — see below                    |
| **`UserPromptSubmit`**             | Supported     | Blocking: a `block` decision (or exit 2) halts the submit                            |
| **`Stop` / `SubagentStop`**        | Supported     | Detached observation — see below                                                     |
| **User / project / local**         | Supported     | Project + local require workspace trust (#100)                                       |
| **Sources UI**                     | Supported     | Listed alongside Cursor hooks in Settings → Customise                                |
| **Prompt / HTTP / agent handlers** | Not supported | Only `type: "command"` (or omitted type)                                             |
| **`if` permission-rule filters**   | Not supported | Matcher-only for v1                                                                  |
| **`PreCompact`**                   | Not supported | The canonical `compaction` event is typed but has no fire site                       |
| **`SessionEnd` / `Notification`**  | Not supported | No canonical event to hang them on                                                   |
| **Long-tail events**               | Not supported | `PermissionRequest`, `TeammateIdle`, … — reported in Sources, never silently dropped |

### What "block" means for the detached events

`PostToolUse`, `Stop`, and `SubagentStop` fire **detached** — dispatched and never
awaited, so the turn is never held up by a hook. That has a consequence worth being
explicit about: by the time they run, the thing they would block has already happened.
Claude Code lets these hooks return `decision: "block"` (or exit 2) to push text back at
the model — "the tool output was bad, try again", "you stopped with todos open". Copse
cannot un-run a finished tool call or resume a finished turn, so it does the next most
faithful thing: the `reason` / `additionalContext` / exit-2 stderr becomes a
**hook-originated queued message**, budgeted and delivered at the next drain, rather than
being dropped or pretended into a control-flow decision it cannot honour.

`UserPromptSubmit` is the exception — it is blocking, and a `block` decision genuinely
stops the prompt from being submitted, exactly as in Claude Code.

Claude has no `failClosed` flag, so every hook fails **open**: a crash, timeout, or
unparseable response never blocks the agent. Exit 2 is a _decision_, not a failure, and is
honoured on its own path.

### Enablement

Execution is gated by the same **`cursorHooksEnabled`** setting as Cursor hooks (off by
default). Discovery for Settings → Customise always runs.

### Tool mapping

| Copse tool  | Claude `tool_name` | Notes                     |
| ----------- | ------------------ | ------------------------- |
| `run_shell` | `Bash`             | `tool_input.command`      |
| `mcp__*`    | same name          | full args as `tool_input` |
| `read_file` | `Read`             | `tool_input.file_path`    |

Hooks can only **tighten** Copse's permission gate: a deny blocks; allow/ask still flow
through Copse's normal prompting.

## Security

Same trust boundary as Cursor hooks: enabling hooks and trusting a workspace grants that
repo's `.claude/settings.json` (and `.settings.local.json`) arbitrary local code execution
on matching tool calls, outside the project sandbox, with non-LLM tool tokens present in
`env`. Fail-open on crash/timeout/non-JSON. See
[`docs/cursor-hooks.md#security`](./cursor-hooks.md#security) and
[`docs/supply-chain-security.md`](./supply-chain-security.md).

## Related files

- `src/main/services/hooks/claude-adapter.ts` — Claude dialect adapter: discovery, matcher,
  PreToolUse wire marshalling, exit-code table (exit-2 deny)
- `src/main/services/hooks/tool-gate.ts` — maps tool calls onto the canonical `toolGate` event
- `src/main/services/security/permission-gate.ts` — calls the tool-gate hooks (both dialects)
- `src/shared/types/claude-hooks.ts` / `src/shared/types/hooks.ts` — types
- `docs/cursor-hooks.md` — Cursor hooks contract
- `docs/plans/settings-transparency.md` — #639 tracking
