# Claude Code hooks support in Copse

[Claude Code hooks](https://code.claude.com/docs/en/hooks) are scripts registered under
`hooks` in Claude settings JSON. Copse loads the permission subset (`PreToolUse` command
handlers) so repos that already ship Claude Code policy hooks work without a Cursor-format
`hooks.json`. Tracks issue #639.

This is the Claude counterpart to [`docs/cursor-hooks.md`](./cursor-hooks.md).

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

| Capability                         | Status        | Notes                                                            |
| ---------------------------------- | ------------- | ---------------------------------------------------------------- |
| **`PreToolUse` commands**          | Supported     | Matcher + `type: "command"` handlers; same trust model as Cursor |
| **Exit code 2 deny**               | Supported     | stderr (else stdout) becomes the agent-facing deny reason        |
| **JSON `permissionDecision`**      | Supported     | `allow` / `deny` / `ask`; `defer` mapped to `ask`                |
| **User / project / local**         | Supported     | Project + local require workspace trust (#100)                   |
| **Sources UI**                     | Supported     | Listed alongside Cursor hooks in Settings → Sources              |
| **Prompt / HTTP / agent handlers** | Not supported | Only `type: "command"` (or omitted type)                         |
| **`if` permission-rule filters**   | Not supported | Matcher-only for v1                                              |
| **PostToolUse / lifecycle**        | Not supported | Same gap as Cursor lifecycle hooks                               |

### Enablement

Execution is gated by the same **`cursorHooksEnabled`** setting as Cursor hooks (off by
default). Discovery for Settings → Sources always runs.

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

- `src/main/services/skills/claude-hooks.ts` — discovery, matcher, PreToolUse runner
- `src/main/services/security/permission-gate.ts` — maps tool calls and consults both families
- `src/shared/types/claude-hooks.ts` / `src/shared/types/hooks.ts` — types
- `docs/cursor-hooks.md` — Cursor hooks contract
- `docs/plans/settings-transparency.md` — #639 tracking
