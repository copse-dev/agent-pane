# ACP agent setup (Claude) — and why the old validator failed

This is the practical setup guide for driving an external **ACP** agent from
Copse, focused on Claude. It also explains the two mistakes that make "I have a
Claude token but it won't work" so common.

For the architecture (how Copse acts as the ACP _client_), see
[`acp-agents.md`](./acp-agents.md).

## TL;DR

- **Claude works over ACP today.** Two adapters are already installed and respond
  to the `initialize` handshake: `claude-agent-acp` (Anthropic) and
  `claude-code-acp` (Zed).
- **Cursor works too, natively.** `cursor-agent acp` starts Cursor as an ACP
  server over stdio (a _hidden_ subcommand — not in the top-level `--help` list).
  It completes the `initialize` handshake with `protocolVersion: 1` and
  `authMethods: [cursor_login]`. Add it as a custom agent (see below).
- **Two things break Claude auth:**
  1. **Wrong transport.** ACP is **JSON-RPC over the agent's stdin/stdout**, not
     HTTP on a port. Any validator that scans `lsof` for a listening port and
     POSTs to `http://localhost:PORT` will never connect — the agent opens no
     socket.
  2. **Wrong token type.** A `claude /login` / `claude setup-token` value is an
     **OAuth token** (`sk-ant-oat01-…`). It is **not** an API key and cannot be
     passed as `ANTHROPIC_API_KEY` (that header expects `sk-ant-api…`).

## Which token do you have?

Check what `claude` stored (macOS keychain):

```sh
security find-generic-password -s "Claude Code-credentials" -w \
  | python3 -c 'import sys,json; t=json.load(sys.stdin)["claudeAiOauth"]; print(t["accessToken"][:12]+"…", t.get("subscriptionType"))'
```

| Prefix           | What it is                           | Use as                                            |
| ---------------- | ------------------------------------ | ------------------------------------------------- |
| `sk-ant-oat01-…` | OAuth token (`/login` / setup-token) | `CLAUDE_CODE_OAUTH_TOKEN`, or just stay logged in |
| `sk-ant-api03-…` | Console API key                      | `ANTHROPIC_API_KEY`                               |

If yours is `sk-ant-oat01-…` and you were setting `ANTHROPIC_API_KEY` to it, that
is exactly why it "isn't working." Fix: don't. Use one of the flows below.

## Setup

### Option A — `claude-code-acp` with your existing subscription login (recommended for you)

The Zed adapter advertises `authMethods: [claude-login]` — it reuses the same
credentials the `claude` CLI stores. You are already logged in, so:

```sh
npm install -g @zed-industries/claude-code-acp   # already installed for you
claude /login                                     # only if not already logged in
```

Then add it in Copse: **Settings → Experimental → ACP agents → Claude Code → Add**.
Leave the `env` empty. **Do not** put `ANTHROPIC_API_KEY` there — with an OAuth
subscription the adapter reads the keychain itself, and an `oat` token in
`ANTHROPIC_API_KEY` would break it.

Manual `registeredAcpAgents` entry (equivalent):

```json
{
  "id": "claude-code-acp",
  "title": "Claude Code (ACP)",
  "command": "claude-code-acp",
  "args": [],
  "enabled": true
}
```

### Option B — `claude-agent-acp` with a real API key

The Anthropic adapter advertises `authMethods: []` — it brings its own auth from
the environment. Give it a **console API key** (not an OAuth token):

1. Create a key at <https://console.anthropic.com/settings/keys> (`sk-ant-api…`).
2. Configure the agent with that key in its `env`:

```json
{
  "id": "claude-agent-acp",
  "title": "Claude Agent (ACP)",
  "command": "claude-agent-acp",
  "args": [],
  "env": { "ANTHROPIC_API_KEY": "sk-ant-api03-…" },
  "enabled": true
}
```

> Copse scrubs LLM provider keys (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, …)
> from the _inherited_ environment before spawning any agent (see
> `child-process-env.ts`). So exporting `ANTHROPIC_API_KEY` in your shell is **not
> enough** — it gets stripped. You must pass it explicitly in the agent's `env`,
> which is overlaid last.

### Option C — OAuth token as an env var (headless / CI)

If you want to use the subscription OAuth token without an interactive keychain,
mint one and pass it via `CLAUDE_CODE_OAUTH_TOKEN` (which is _not_ scrubbed):

```sh
claude setup-token   # prints an sk-ant-oat01-… token
```

```json
{
  "id": "claude-code-acp",
  "title": "Claude Code (ACP)",
  "command": "claude-code-acp",
  "args": [],
  "env": { "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-…" },
  "enabled": true
}
```

### Option D — Cursor over native ACP

`cursor-agent` ships a first-class ACP server (`cursor-agent acp`). It uses your
Cursor login (or `CURSOR_API_KEY`), billed to your Cursor account — unrelated to
any Anthropic token.

```sh
cursor-agent login      # once; check with `cursor-agent status`
```

```json
{
  "id": "cursor",
  "title": "Cursor Agent (ACP)",
  "command": "cursor-agent",
  "args": ["acp"],
  "enabled": true
}
```

Leave `env` empty when logged in. `CURSOR_API_KEY` is not scrubbed by
`child-process-env.ts`, so it also passes through if you prefer a key.

## Validate from the CLI

Run the corrected validator (spawns each adapter, does the real stdio
`initialize`, prints capabilities + auth methods):

```sh
node validate-acp.mjs
```

Expected: both Claude adapters print `✓` and `protocolVersion: 1`. Note their
different `authMethods` — that difference is the whole point:

- `claude-agent-acp` → `authMethods: []` → wants an API key in env (Option B).
- `claude-code-acp` → `authMethods: [claude-login]` → wants a `/login` session
  (Option A) or `CLAUDE_CODE_OAUTH_TOKEN` (Option C).

## Common failures

| Symptom                                             | Cause                                                      | Fix                                              |
| --------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| Validator hangs / "could not find port"             | Treating ACP as HTTP/TCP; scanning `lsof`                  | ACP is stdio JSON-RPC — use `validate-acp.mjs`   |
| `401` / `invalid x-api-key` from the agent          | Passed an `sk-ant-oat…` OAuth token as `ANTHROPIC_API_KEY` | Use Option A/C, or a real `sk-ant-api…` key      |
| Works in your shell, fails when launched from Copse | Copse scrubs `ANTHROPIC_*` from inherited env              | Put the key in the agent's `env`, not `~/.zshrc` |
| `spawn … ENOENT`                                    | Adapter not on `PATH`                                      | `npm install -g` the adapter; check `which`      |
| Node warnings / version errors                      | App wants Node ≥ 22; adapters here are under nvm Node 20   | `nvm use 22` (or match `.nvmrc`) before launch   |
