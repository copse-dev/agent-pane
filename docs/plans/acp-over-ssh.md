# ACP agents over SSH

**Status: In progress (Phase 1).** Lets Copse drive an external **ACP agent on
the remote host** of an SSH workspace, instead of blocking ACP entirely there.
The agent process runs where the code lives; Copse stays the ACP *Client* (UI,
approvals, diff queue) locally. Gated behind a single opt-in — `acpOverSshEnabled`
— in Settings → ACP agents.

Builds directly on the SSH-workspace stack that shipped in
[#942](https://github.com/copse-dev/agent-pane/pull/942)
(`docs/plans/ssh-remote-repo.md`) and the ACP client stack
([#264](https://github.com/copse-dev/agent-pane/issues/264),
`docs/plans/acp-client-support.md`). Lifts the limitation recorded in
`docs/acp-agents.md` ("Remoting ACP over SSH is not implemented").

## Why the remote-host orientation (evidence from Zed)

Zed originated ACP and is actively wrestling with exactly this problem, which
makes its issue tracker the best available prior art. Two orientations are
possible, and the evidence points hard at one of them:

1. **Agent local, tunnel its fs/MCP back over SSH.** Zed effectively shipped
   this, and it is where their bugs cluster:
   - [zed#52254](https://github.com/zed-industries/zed/issues/52254) — the
     revealing one. Zed launches the ACP agent **locally** and rewrites the
     agent's MCP server command into an SSH tunnel
     (`"command": "ssh", "args": ["-o","ControlMaster=no", …, "coder@remote", …]`).
     The reporter: *"This would be great if the agent was running locally and
     just communicating over the SSH connection, but it's not"* — and the
     proxying breaks. Their proposed fix: **run the agent on the remote host and
     pass raw MCP config so the agent launches MCP itself, remotely.**
   - [zed#47910](https://github.com/zed-industries/zed/issues/47910) (S1, "many
     users") — ACP-Registry-installed agents silently fail to appear when
     driving a remote Zed Server over SSH / WSL: local/remote install-location
     mismatch.
   - [zed#38392](https://github.com/zed-industries/zed/issues/38392) — local
     proxy **env vars leak** into the remote ACP agent.
2. **Agent on the remote host, stdio over SSH (this plan).** The agent is
   co-located with the code, so its own tools read/write remote files natively
   and its MCP servers launch remotely. This is the direction Zed's community is
   pushing toward.

Zed also confirms the *protocol-native* remote transport (Streamable
HTTP/WebSocket) is still WIP — "every ACP agent currently runs as a local
subprocess." So there is no shipped reference to copy; we take the lessons, not
the code.

Lessons folded into this design:

- **Co-locate the agent with the code.** Don't run it locally and tunnel `fs/*`.
- **Never SSH-proxy the agent's MCP servers.** They launch on the remote host
  from raw config (or are simply not forwarded in v1).
- **Never leak local env to the remote agent.** Explicit allow-list only.

## What already exists (so Phase 1 is small)

The two hard parts are already built:

- **The filesystem seam is remote-aware.** The ACP client callbacks
  (`fs/read_text_file`, `fs/write_text_file` → diff queue) resolve through
  `getActiveWorkspaceFs()` (`src/main/services/workspace-fs/get-workspace-fs.ts`),
  which returns `getSshWorkspaceFs(hostId, remoteRoot)` on an SSH workspace. So
  the agent's writes already land on the **remote** host with Copse's diff
  approval intact — no re-pointing needed.
- **The SSH transport is built.** `SshConnectionManager` + `OpenSshTransport`
  (ControlMaster multiplexed), `sshExecArgs`, `wrapRemoteShellWithPgid`,
  askpass, remote env allow-list, and remote PGID kill all shipped in #942.
- **The ACP transport is injectable.** `AcpTransportFactory`
  (`acp/acp-client.ts`) already swaps the stdio transport; the SSH case is a new
  factory branch.

The **only** blockers were: the explicit `isActiveSshWorkspace()` guard in
`acp-agent-service.ts` (lines 270 / 478) that hard-rejects ACP on SSH, and the
agent process being spawned **locally** with a remote `cwd`.

## Design

### Transport (`src/main/services/acp/acp-ssh-transport.ts`)

A long-lived `ssh` process piping stdio (not the one-shot buffered
`execArgv`). Reuses #942 primitives:

```
ssh <ControlMaster opts> host -- \
  cd <remoteRoot> && setsid sh -c 'printf __COPSE_PGID__=…; exec env <locale> <command> <args>'
```

- **Multiplexed:** the workspace's existing ControlMaster socket is reused, so
  the agent exec adds ~10–30 ms and requires **no re-auth**.
- **Clean stdout:** the PGID marker line is peeled off before the byte stream
  reaches `ndJsonStream` (mirrors `ssh-spawn.ts`'s `attachPgidParser`).
- **Kill:** `setsid` + remote PGID → `dispose` runs a remote process-group kill
  (`terminateProcessTree`), not just a local `ssh` kill (avoids orphaned remote
  agents — the ssh-remote-repo plan's explicit warning).
- **stderr:** piped and logged (local transport `inherit`s it; over SSH we
  capture it — Zed's "agent stderr on stdio" risk).

Both `spawnTransport` (`acp-client.ts`) and `spawnProbeTransport`
(`acp-capability-probe.ts`) delegate to this factory when
`acpSshTarget(config.cwd)` resolves.

### The decisions

**Auth to the remote host** — nothing new. Reuse #942: OpenSSH + ControlMaster +
the askpass bridge + the user's `~/.ssh/config` and `known_hosts`. The agent
transport rides the connection the workspace already opened.

**Auth the agent to its model provider** — the agent authenticates **on the
remote host**, where the code (and the agent binary) live: `claude /login` /
`cursor-agent login` / a token in the remote shell profile, run once on the
host. Copse forwards **only** a locale/term allow-list to the remote agent — it
does **not** forward Copse's local provider keys, the local `process.env`, or
even the agent's Copse-configured `env` secrets. Two reasons: (1) the
"auth-where-the-code-is" model makes local secrets the wrong ones anyway, and
(2) `env KEY=VAL` values are visible in `ps` to other users on a shared remote
host. (Forwarding configured `env` as an explicit per-agent opt-in is a possible
follow-up.) This is the direct application of zed#38392.

**Install the agent binary** — assume-present, with a preflight and clear
guidance. Before the first spawn, Copse checks the agent command resolves on the
remote login-shell PATH (`command -v` over the connection). If it doesn't, the
turn fails with the known agent's own install line (e.g.
`npm install -g @zed-industries/claude-code-acp`) to run **on the remote host**.
Copse does **not** auto-install remotely in v1: the Socket-Firewall supply-chain
wrapper that guards local auto-setup does not extend to the remote host, so
auto-installing there would bypass a security control (and zed#47910 shows how
local/remote install confusion bites).

**Gating (the one toggle)** — `acpOverSshEnabled`, in Settings → ACP agents,
default **off**. It is only meaningful when `sshWorkspaceEnabled` is also on
(you cannot remote an ACP agent without an SSH workspace). When **off** on an
SSH workspace, ACP stays blocked with the existing message; ACP agents are
hidden from the model picker. When **on**, ACP agents spawn on the workspace's
host and appear in the picker.

## Security

- **Blast radius is the remote account**, same as every other tool on an SSH
  workspace (shell, git, fs). The macOS seatbelt is local-only and does not
  apply; the agent runs unsandboxed on the remote host exactly as a remote
  shell command does. Approvals, the diff queue, and permission prompts all
  stay in the **local** main process.
- **No local secrets cross the wire** — locale allow-list only (above).
- **`ssh` classification is untouched** — the transport is injected below
  command routing, so user-authored `ssh` stays hard-external.
- **Host trust** is the user's own `known_hosts` via OpenSSH; no parallel store.

## Phasing

- **Phase 1 (this work).** Toggle + remote transport + flip the guard + preflight
  install check + picker visibility + unit tests. Agent runs remotely; its own
  tools + Copse's diff-queue writes operate on the remote host.
- **Phase 2.** MCP forwarding to the remote agent — launch the user's stdio MCP
  servers **on the remote host** from raw config (never SSH-proxied, per
  zed#52254). Copse's native-tool bridge (http/localhost) needs a **reverse
  tunnel**, which is [#771](https://github.com/copse-dev/agent-pane/issues/771)'s
  scope.
- **Phase 3.** Remote model-detection polish, optional per-agent env forwarding
  opt-in, remote auto-install story (if Socket-Firewall equivalent can be
  extended), terminal (`terminal/*`) parity on the remote host.

## Testing

- Unit: remote command construction (quoting, `cd`/`setsid`/`exec` wrapper,
  locale-only env), the `acpSshTarget` gate (toggle off / on × local / SSH), the
  preflight install-missing error. `FakeSshTransport` (from #942) backs the
  connection manager; the ACP transport factory is injected in tests exactly as
  the local one is.
- Existing `acp-agent-service.test.ts` "ACP on SSH workspaces" block is updated:
  rejects when the toggle is off, proceeds when on.
