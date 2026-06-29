# Using other agents on the same device (ACP client)

Copse can drive an external [ACP](https://agentclientprotocol.com/) agent that
runs **locally on the same machine** — Gemini CLI, Codex, Cline, OpenCode,
Copilot CLI, or anything else that speaks the Agent Client Protocol over stdio.
Copse acts as the **ACP client**: it spawns the agent, hands it your workspace,
and renders its activity in the normal chat UI. The external agent runs its own
model loop (and brings its own auth), while Copse keeps ownership of the
workspace and the approval UX.

> Status: this is the first slice of the client role (issue #264, Track 1).
> Terminals and cross-turn session resume are not here yet — see
> [Limitations](#limitations).

## How it works

- Each configured agent appears in the model picker under **ACP agents** as
  `acp:<id>`. Selecting it routes the turn to the external agent instead of the
  built-in loop.
- The agent's `session/update` stream is translated into the same chat chunks
  the built-in agent uses, so text and tool calls render normally.
- Copse backs the agent's client callbacks with its own machinery:
  - **`fs/read_text_file`** → a workspace-scoped read (paths are sandboxed to the
    open folder).
  - **`fs/write_text_file`** → the **diff-approval queue**. The agent's write is
    shown to you as a diff and is **blocked until you approve or reject it** —
    nothing hits disk without your say-so.
  - **`session/request_permission`** → the normal approval dialog.
- Aborting the turn sends `session/cancel` and tears the agent process down.

## Configure an agent

### Settings panel (recommended)

Open **Settings → General → ACP agents**. From there you can:

- **Detect installed agents** — scans your device (PATH + running processes) for
  known ACP agents and adds any it finds with one click.
- **Add an agent** — fill in id, title, command, arguments (one per line),
  environment (`KEY=value` per line), and an enabled toggle.
- **Edit / remove** existing agents.

Changes are saved immediately; reopen the model dropdown to see them.

### Detect from the command line

Prefer the terminal? Run the standalone detector, which prints what's installed
plus a ready-to-paste config block:

```sh
npm run detect:acp     # or: node scripts/detect-acp-agents.mts
```

### The underlying setting

Both the panel and the detector write the `registeredAcpAgents` setting. You can
also edit it directly (e.g. from the app DevTools console with
`window.api.settings.set('registeredAcpAgents', [...])`). Each entry matches the
`AcpAgentConfig` shape:

| Field     | Required | Notes                                                              |
| --------- | -------- | ------------------------------------------------------------------ |
| `id`      | yes      | Lowercase slug (`a-z`, `0-9`, `-`). The model value is `acp:<id>`. |
| `title`   | yes      | Shown in the model picker.                                         |
| `command` | yes      | Executable to spawn (absolute path or on `PATH`).                  |
| `args`    | no       | Arguments passed to the command.                                   |
| `env`     | no       | Extra environment variables for the agent process.                 |
| `enabled` | yes      | Only enabled agents appear in the picker.                          |

Example value:

```json
[
  {
    "id": "gemini-cli",
    "title": "Gemini CLI",
    "command": "gemini",
    "args": ["--experimental-acp"],
    "env": { "GEMINI_API_KEY": "..." },
    "enabled": true
  }
]
```

Once saved, pick **Gemini CLI** from the model dropdown (under **ACP agents**)
and chat as usual. Open a folder first — the agent needs a workspace to act in.

### A note on secrets

The spawned agent runs its own model loop, so Copse **scrubs its own cloud LLM
provider keys** (Anthropic/OpenAI/OpenRouter/…) from the agent's environment.
The agent must bring its own credentials: pass them explicitly through `env`
(as in the example above), or rely on the agent's own login/config. Non-LLM tool
tokens such as `GITHUB_TOKEN` are passed through.

## Limitations

This first slice intentionally leaves the following for follow-ups (issue #264):

- **No terminals.** `terminal/*` requests are not backed yet.
- **No session resume.** Each turn spawns a fresh agent process and a fresh ACP
  session. Prior conversation is replayed into the prompt as a compact preamble
  so follow-ups keep context, but the agent has no durable session memory yet.
- **Text only on input.** Image attachments are dropped before the prompt is
  sent (the agent receives the text blocks).
- **No MCP forwarding.** Your configured MCP servers are not yet forwarded to the
  external agent.

## See also

- [`docs/plans/acp-client-support.md`](plans/acp-client-support.md) — the design
  notes and phased rollout.
- [Agent Client Protocol](https://agentclientprotocol.com/) — the protocol spec
  and list of supported agents.
