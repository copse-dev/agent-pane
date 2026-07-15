# Using other agents on the same device (ACP client)

Copse can drive an external [ACP](https://agentclientprotocol.com/) agent that
runs **locally on the same machine** — Gemini CLI, Claude (via an ACP adapter),
or anything else that speaks the Agent Client Protocol over stdio. Copse acts as
the **ACP client**: it spawns the agent, hands it your workspace, and renders its
activity in the normal chat UI. The external agent runs its own model loop (and
brings its own auth), while Copse keeps ownership of the workspace and the
approval UX.

> **The agent is a separate program — it is not bundled with Copse.** Copse ships
> only `@agentclientprotocol/sdk` (the client/protocol half). The agent half (the
> thing that wraps Claude/Gemini and speaks ACP) is installed by you, e.g.
> `npm install -g @agentclientprotocol/claude-agent-acp` for Claude, then
> authenticated with its own command (e.g. `claude setup-token`). The Settings
> panel shows the exact install and sign-in commands per agent.

> Status: client role, second slice (issues #264, #605). Terminals are not
> here yet — see [Limitations](#limitations).

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
    shown to you as a diff and is **blocked until you approve or reject it**.
  - **`session/request_permission`** → the normal approval dialog.
- Your configured **MCP servers** (stdio, plus http when the agent supports it)
  are handed to the agent via `session/new`, so it can mount them itself. The
  same trust and enable gating applies as for Copse's own connections.
- A curated, context-free slice of **Copse's own tools** (workspace
  read/search/edit, Git, shell/background commands, GitHub/CI, staged-diff
  visibility, and web/browser) is offered as a per-session localhost MCP server
  (the **native-tool bridge**, issue #602) when the agent supports http MCP
  servers. Calls execute through the same `ToolRegistry` as built-in model runs,
  so the normal path validation, diff queue, permission policy, sandbox escape,
  and approval dialogs apply. Disable with the `acpNativeBridgeEnabled` setting.
- Known agents (the Claude and Gemini catalog entries) are **spawned under the
  workspace seatbelt** on macOS when the project sandbox is active (issue
  #590): writes confined to the workspace, home denied except the agent's own
  config dirs, network limited to its declared endpoints (plus loopback for the
  bridge). The confines come from the `KNOWN_ACP_AGENTS` catalog at spawn time —
  no per-config copy — and the config's optional `sandbox` field overrides them
  (an object for custom confines, `false` to opt out). The agent's shell
  children inherit the same confines, and approval prompts cannot override the
  agent's own shell sandbox. Sandboxed turns steer commands through the bridge's
  `run_shell`: that reuses Copse's native permission decision and can run
  approved external commands outside the agent sandbox. Direct agent-shell
  `git push`/`npm install` still fail inside the sandbox.
- **Sessions persist per thread** (issue #605): follow-up turns reuse the same
  agent process and ACP session, so the agent keeps its own context (no
  transcript replay) and background helpers it spawned keep running between
  turns; their queued updates surface at the start of the next turn. Aborting a
  turn sends `session/cancel` but keeps the session alive; sessions idle for 10
  minutes are torn down.

> **Scope of the write guarantee:** the diff queue only sees writes the agent
> routes through `fs/write_text_file`. Well-behaved adapters (the Claude
> adapters, Gemini CLI) use it for file _edits_ when Copse advertises the
> capability, but every agent keeps its own shell tool — a `sed -i` or
> `echo >` from the agent's shell lands on disk directly, gated only by
> `session/request_permission` (and not even that once you grant an
> "Always allow … execute" remember). Containment and detection of such
> writes are tracked in #590 and #591.

## Configure an agent

### Settings panel (recommended)

Open **Settings → Experimental → ACP agents** (it's opt-in and still evolving). It
scans your device when you open the tab and shows:

- **Known agents** — a shortlist (Gemini CLI, Claude Agent, Claude Code, Cursor,
  Codex) with, for each: whether it's installed, the **Install** command to get it,
  the **Sign in** command to authenticate it (e.g. `claude setup-token`), and an
  **Add** button.
- **Configured agents** — edit / enable / remove what you've added.
- **Add an agent** — a custom form (id, title, command, args one-per-line,
  `KEY=value` env, enabled) for anything not in the shortlist.

Changes are saved immediately; reopen the model dropdown to see them. **Re-scan
device** refreshes the installed/running status after you install something.

> Tip: you can **Add** a known agent before installing it — Copse stores the
> config now, and you run the shown Install/Sign in commands when ready.

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

## Tool parity with native Copse

ACP client mode and the **built-in Copse agent loop** (cloud/local models such as
Fable or Sonnet) do **not** expose the same tool surface today:

| Capability                       | Built-in Copse (native model)                                                               | ACP client (`acp:<id>`)                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Read/search files                | `read_file`, `search_codebase`, `search_code`, … (default) or `explore` subagent (optional) | External agent tools, plus equivalent bridged Copse tools                           |
| Edit files                       | `write_file` / `str_replace` → diff approval when needed                                    | `fs/write_text_file` or bridged edit tools → same queue                             |
| Shell / CLI                      | `run_shell` (structured; prefer dedicated tools for reads)                                  | Bridged `run_shell` / `run_background` (preferred); private shell remains sandboxed |
| Git / GitHub                     | `git_*`, `gh_*`, CI tools                                                                   | Equivalent bridged Copse tools                                                      |
| MCP servers                      | Copse `ToolRegistry` (`mcp__*` tools)                                                       | Forwarded via `session/new` (agent mounts them itself)                              |
| Shared context-free native tools | Copse `ToolRegistry`                                                                        | Native-tool bridge (localhost MCP, approval-gated)                                  |
| Skills, todo/plan tools          | Copse `ToolRegistry`                                                                        | **Not forwarded**                                                                   |

**Default native behavior** (Settings → Local models → _Route reads and searches
through exploration subagents_ **off**) exposes direct read/search tools so native
models behave similarly to typical ACP coding agents instead of hiding those tools
behind `explore` or falling back to `run_shell` (`grep`, `cat`, …).

**`copse --acp`** (server mode) is the opposite direction: Copse exposes its full
native loop to an external ACP _client_.

## Limitations

This first slice intentionally leaves the following for follow-ups (issue #264):

- **No terminals.** `terminal/*` requests are not backed yet.
- **Sessions are per-thread and idle-bounded.** The agent process and its ACP
  session persist across turns in a thread (issue #605), so the agent keeps its
  own memory and background helpers survive between turns — but a session idle
  for 10 minutes is reaped, and a config change or failed turn respawns it; in
  those cases the prior conversation is replayed once as a compact preamble.
- **Text only on input.** Image attachments are dropped before the prompt is
  sent (the agent receives the text blocks).
- **Native-tool bridge is http-only.** Agents that support only stdio MCP
  servers don't get Copse's bridged tools this turn — a stdio shim is a
  possible follow-up (#602). Skills and todo/plan tools are not bridged.
- **Sandboxing is macOS-only and catalog-scoped.** Agents with no
  `KNOWN_ACP_AGENTS` sandbox entry (e.g. Cursor, custom agents) spawn
  unsandboxed; add `sandbox` (`allowedDomains`, `homeDirs`) to their
  `registeredAcpAgents` entry to opt them in, or `sandbox: false` to opt a
  catalog agent out (#590).

## Comparing agents (capability probe)

Not sure what a given agent actually supports? `npm run probe:acp` spawns each
installed agent, runs the `initialize` / `session/new` handshake (no prompt, no
tokens), and writes a support matrix comparing session resume, prompt content
types, MCP transports, modes, models, auth, and any `_meta` each adapter
tunnels. For write routing / permission payloads / mid-turn `_meta` under a real
turn, use `npm run probe:acp:behavior` (issue #832; spends tokens). See
[`docs/acp-capability-probe.md`](acp-capability-probe.md).

## See also

- [`docs/acp-capability-probe.md`](acp-capability-probe.md) — the Tier-1
  capability probe, Tier-2 behavioural probe, and support matrices
  (`npm run probe:acp` / `npm run probe:acp:behavior`).
- [`docs/plans/acp-client-support.md`](plans/acp-client-support.md) — the design
  notes and phased rollout.
- [Agent Client Protocol](https://agentclientprotocol.com/) — the protocol spec
  and list of supported agents.
