# Using other agents on the same device (ACP client)

Copse can drive an external [ACP](https://agentclientprotocol.com/) agent that
runs **locally on the same machine** — or, with opt-in, on the remote host of an
SSH workspace — Gemini CLI, Claude (via an ACP adapter), or anything else that
speaks the Agent Client Protocol over stdio. Copse acts as the **ACP client**:
it spawns the agent, hands it your workspace, and renders its activity in the
normal chat UI. The external agent runs its own model loop (and brings its own
auth), while Copse keeps ownership of the workspace and the approval UX.

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
- Known agents (the Claude, Gemini, and Cursor catalog entries) are **spawned
  under the workspace seatbelt** on macOS when the project sandbox is active
  (issue #590): writes confined to the workspace, home denied except the agent's
  own config dirs, network limited to its declared endpoints (plus loopback for
  the bridge). The confines come from the `KNOWN_ACP_AGENTS` catalog at spawn
  time — no per-config copy — and the config's optional `sandbox` field overrides
  them (an object for custom confines, `false` to opt out). The agent's shell
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

Open **Settings → ACP agents**. It scans your device when you open the tab and
shows a **chip row** — one chip per agent — that hides each agent's details until
you pick it, the same pattern as **Settings → Providers**. A dot marks the agents
you've already added.

- **Known agents** lead the row (Gemini CLI, Claude Agent, Claude Code, Cursor,
  Codex). Select one to see whether it's installed, the **Install** command to get
  it, the **Sign in** command to authenticate it (e.g. `claude setup-token`), and
  an **Add to my agents** button.
- Once added, selecting an agent's chip opens its editor — change its model /
  permission mode, enable/disable it, or **Remove** it.
- The trailing **Add agent** chip is a custom form (id, title, command, args
  one-per-line, `KEY=value` env, enabled) for anything not in the shortlist.

Changes are saved immediately; reopen the model dropdown to see them. **Re-scan
device** refreshes the installed/running status after you install something.

Opening the tab also runs **auto-setup** for curated npm presets (Claude, Codex):
missing adapters can be installed (with an approval), and an already-installed
adapter that is behind the npm registry latest can be upgraded the same way.
Upgrades use the `npm` beside the resolved binary so an nvm/prefix install stays
in that prefix. Cursor is never auto-installed (its installer is not npm).

> Tip: you can **Add** a known agent before installing it — Copse stores the
> config now, and you run the shown Install/Sign in commands when ready.

### When a sign-in lapses

External agents hold their own credentials, and those expire. When a turn fails
because the agent could not authenticate, Copse now says so in the agent's own
terms and offers to fix it: the chat message names the command that signs that
agent in again (`claude /login`, `cursor-agent login`, `codex login`, …), and a
prompt offers to open a shell in the **Shells** pane already running it. Finish
the sign-in there, then re-send your message — Copse cannot complete another
program's login flow for you.

The distinction matters because the commands differ. `claude setup-token` mints a
long-lived token for an agent that has never been signed in; an OAuth session
that has lapsed is renewed with `claude /login`. Copse tells the two apart from
the failure and names the right one.

Expiry is worth understanding rather than just re-running: an OAuth login
refreshes its own access token in the background, so a _sandboxed_ agent that
cannot reach its provider's token endpoint will keep working until the current
token ages out and then fail with `OAuth access token has expired`. If that
happens repeatedly, check the **Sandbox network audit** card at the end of the
turn for a blocked host and add its domain to that agent's
`sandbox.allowedDomains` override. The Claude presets allow `anthropic.com`,
`claude.ai`, and `claude.com` (the console moved to `platform.claude.com`, which
is where an OAuth login refreshes) for exactly this reason.

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

| Field            | Required | Notes                                                              |
| ---------------- | -------- | ------------------------------------------------------------------ |
| `id`             | yes      | Lowercase slug (`a-z`, `0-9`, `-`). The model value is `acp:<id>`. |
| `title`          | yes      | Shown in the model picker.                                         |
| `command`        | yes      | Executable to spawn (absolute path or on `PATH`).                  |
| `args`           | no       | Arguments passed to the command.                                   |
| `env`            | no       | Extra environment variables for the agent process.                 |
| `permissionMode` | no       | ACP **session mode** to start each session in — see below.         |
| `enabled`        | yes      | Only enabled agents appear in the picker.                          |

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

### Permission mode (relaxing the agent's prompting)

In ACP **client** mode, whether the agent asks for approval is entirely the
_agent's_ own policy — Copse just renders the `session/request_permission`
dialog it sends. ACP exposes that policy as **session modes** (e.g. Claude
Code's `default` / `acceptEdits` / `bypassPermissions` / `plan`). Set
`permissionMode` on the agent config (or pick one in the **Permission mode**
dropdown after **Detect models**) and Copse applies it with `session/set_mode`
right after the session is created — before the first prompt — so the agent's
own prompting is relaxed or tightened for the whole session. The dropdown is
populated from the modes the agent advertises in `session/new`; leave it on
**Agent default** to keep the agent's own behavior. An unknown/stale value
silently degrades to the agent's default rather than failing the turn.

> **Sandboxed Claude presets default to `acceptEdits`.** When a Claude preset
> runs under the workspace seatbelt (issue #590), the seatbelt already contains
> writes to the workspace and scratch dirs and the post-turn audit surfaces
> anything that bypassed the diff queue — so prompt-per-edit adds friction
> without adding safety. Copse therefore defaults those sandboxed sessions to
> `acceptEdits` unless you set `permissionMode` yourself. Unsandboxed agents
> keep their own default prompting. Note that approving a request never lifts
> the seatbelt: a sandboxed agent that asks to touch a genuinely denied path
> (system `/tmp`, network) still fails with `EPERM` even after you approve it.

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
  own memory and background helpers survive between turns. A session idle for
  10 minutes is reaped to free the process; agents that advertise
  `session/resume` (Claude, Codex) restore the same session on the next turn
  without a transcript replay (issue #830). Agents without resume (or a failed
  resume), and config changes that force a new session, still get a one-shot
  history preamble.
- **Text only on input.** Image attachments are dropped before the prompt is
  sent (the agent receives the text blocks).
- **Native-tool bridge is http-only.** Agents that support only stdio MCP
  servers don't get Copse's bridged tools this turn — a stdio shim is a
  possible follow-up (#602). Skills and todo/plan tools are not bridged.
- **Sandboxing is macOS-only and catalog-scoped.** Known presets (Claude,
  Gemini, Codex, Cursor) ship a catalog `sandbox` entry; custom agents spawn
  unsandboxed unless you add `sandbox` (`allowedDomains`, `homeDirs`) to their
  `registeredAcpAgents` entry, or set `sandbox: false` to opt a catalog agent
  out (#590).
- **SSH workspaces are opt-in.** Off by default, ACP agents stay hidden from the
  chat model picker and are rejected at session open on an SSH remote. Turn on
  **Settings → Experimental → ACP agents → Run ACP agents over SSH** to spawn the
  agent on the **remote host** (stdio over the existing ControlMaster connection)
  instead of blocking ACP. The agent binary must be installed and authenticated
  on that host; Copse does not forward local credentials. See
  [`docs/plans/acp-over-ssh.md`](plans/acp-over-ssh.md).

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
- [`docs/plans/acp-over-ssh.md`](plans/acp-over-ssh.md) — opt-in ACP agents on
  SSH workspaces (Phase 1: remote spawn over ControlMaster stdio).
- [Agent Client Protocol](https://agentclientprotocol.com/) — the protocol spec
  and list of supported agents.
