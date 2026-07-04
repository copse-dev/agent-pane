<p align="center">
  <img src="assets/icons/wave/icon-dock-512.png" alt="Copse" width="96" height="96">
</p>

# Copse

Electron desktop app (`copse-panel`): an AI coding assistant that chats with LLMs and uses tools against opened project folders. Three-pane UI with agent chat, Monaco editor, terminal, git, semantic search, built-in browser, MCP, and subagents — writes and shell commands wait for your approval.

Requires Node ≥ 22.

## Quick start

```bash
npm install
npm run dev
```

### Hardened npm profiles (`ignore-scripts`)

If your npm is configured with `ignore-scripts=true` (a common supply-chain hardening setting in `~/.npmrc`), `npm install` **skips this project's `postinstall`** — including the step that makes node-pty's `spawn-helper` executable. The published `node-pty` prebuild ships `spawn-helper` as mode `0644`, and nothing in node-pty's own install flow adds the execute bit, so without our `postinstall` the integrated terminal fails to launch with:

```
Failed to start terminal: ... 'terminal:create': Error: posix_spawnp failed.
```

Keep `ignore-scripts` on if you want it — just run the native postinstall once after each install (the chmod runs before the electron rebuild, so you can skip that):

```bash
SKIP_ELECTRON_REBUILD=1 npx tsx scripts/postinstall-native.mts
```

Or let scripts run for a single install without changing your global config:

```bash
npm install --ignore-scripts=false
```

Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` for cloud models, add an `OPENROUTER_API_KEY` (Settings → API Keys) to reach Claude, GPT, Gemini, Llama and more through [OpenRouter](https://openrouter.ai), or configure a local provider in Settings. For cheap/free tiers you can also add a `MISTRAL_API_KEY` (Mistral's free Experiment tier), `GEMINI_API_KEY` (Google's free-tier Gemini Flash models), or `DEEPSEEK_API_KEY` (low-cost DeepSeek) — each appears as its own group in the model picker. Without keys, the app falls back to a built-in mock LLM for development.

### How API keys are stored

API keys entered in **Settings → API Keys** are persisted in the app's `settings.json` (inside the `copse-panel` userData directory). When an OS secure-storage backend is available they are encrypted at rest via Electron's [`safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage) — the macOS Keychain, Windows DPAPI, or a Linux keyring (gnome-keyring / kwallet via libsecret).

If **no keyring is available** — common on a headless or minimal Linux install — `safeStorage` cannot encrypt, so keys are stored as **base64 plaintext** instead (the app logs a one-line warning and keeps working so it is still usable without a keyring). In that case anyone with read access to your profile directory can recover the keys. To get encryption at rest on Linux, install and unlock a keyring such as `gnome-keyring` (with `libsecret`) before launching the app. Prefer not to store a key on disk at all? Provide it via the matching environment variable (e.g. `ANTHROPIC_API_KEY`) instead — env-var keys are never written to `settings.json`.

### Where chat threads are stored

Conversations live in a filesystem-native store under `~/.copse/workspace/<projectId>/<threadId>/` — one directory per thread (a tiny `meta.json`, an append-only `events.jsonl` history, and Markdown message files), not in `config.json`. This makes each thread greppable and lets the agent `@`-reference a past conversation and explore it read-only with its file tools. Set `COPSE_WORKSPACE_DIR` to relocate the store. Format details: [docs/thread-store-format.md](docs/thread-store-format.md).

### Detecting keys from your environment

If you already export provider keys in your shell (e.g. `ANTHROPIC_API_KEY` in `~/.zshrc`), Copse can pick them up for you. This is **opt-in**: click **Scan environment** in first-run setup or under **Settings → General**. Copse reads `process.env` plus a fixed allow-list of your own start-up files (`~/.zshrc`, `~/.bashrc`, `~/.profile`, `~/.config/fish/config.fish`, …), shows a masked preview of any keys it recognises (Anthropic, OpenAI, Cursor, OpenRouter, Mistral, Gemini, DeepSeek, Hugging Face, LM Studio), and lets you import the ones you don't already have configured. Nothing is read until you click Scan, raw secret values never leave the main process, and existing saved keys are never overwritten.

### LM Studio context length resets on restart

LM Studio reloads local models at a small default context length after a reboot, which trips Copse's low-context advisory. Copse reads the loaded context but can't safely reload the model at your machine's maximum — see [`docs/lm-studio-context-persistence.md`](./docs/lm-studio-context-persistence.md) for how to make your chosen context length restart-proof (save a per-model default, or script `lms load --context-length` at login).

## Commands

| Command            | Purpose                                  |
| ------------------ | ---------------------------------------- |
| `npm run dev`      | Dev build + Electron                     |
| `npm run build`    | Production bundle to `dist/`             |
| `npm start`        | Run built app                            |
| `npm test`         | Unit tests                               |
| `npm run test:e2e` | WebdriverIO Electron e2e                 |
| `npm run check`    | typecheck, lint, format, dead-code, test |

## Shell command permissions

On **macOS** with the project sandbox (seatbelt) active, sandbox-contained commands auto-run inside the sandbox; external commands (network, `gh`, `git push`, etc.) prompt and run outside when approved.

On **Linux / Windows** (no OS sandbox), auto-run relies on static analysis plus an optional local safety classifier — a UX hint, not a security boundary. Approve external commands explicitly.

## Layout

```
src/
  main/          Electron main: window, IPC, agent service, tool registry, workspace, MCP, project sandbox
  preload/       `contextBridge` API exposed to the renderer
  renderer/      DOM UI (views, controllers, styles), Monaco setup
  shared/        Agent loop, reactive store, LLM providers, shared types
scripts/         esbuild dev/build and test runner
```

Path alias `@shared/*` maps to `src/shared/*` (see tsconfig).

## MCP servers

The agent is an MCP (Model Context Protocol) host and ships with no servers connected. Add them in `.cursor/mcp.json` / `.mcp.json` (project) or `~/.cursor/mcp.json` (global), using the standard `mcpServers` format (same as Cursor / Claude Desktop); reference secrets with `${env:VAR}`. See [`mcp.json.example`](./mcp.json.example) for optional MCP servers. Status, reload, and approval settings live under **Settings → MCP servers**.

## Custom tools

For a one-off capability that doesn't justify standing up a whole MCP server, drop
an in-process **custom tool** into `<userData>/tools/` (`*.js` / `*.mjs` / `*.cjs`).
Each module default-exports a tool object (or an array, or a factory returning
either):

```js
export default {
  name: 'lookup_user',
  description: 'Look up a user by id',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  async execute({ id }) {
    return `user ${id}`
  },
}
```

They register into the same tool registry as built-in and MCP tools (namespaced
`custom__<name>`) and **always prompt for approval** before running, since they
execute with full Node privilege. They are loaded **only** from the user's trusted
directory — never from the workspace, so a cloned repo can't inject one. See
[`docs/custom-tools.md`](./docs/custom-tools.md).

## Semantic search

On supported platforms, `npm install` downloads bundled search binaries to `vendor/` (postinstall): [`gortex`](https://github.com/zzet/gortex), a daemon-based code-intelligence engine and the preferred backend (skip with `SKIP_GORTEX_FETCH=1`), and `codesearch` as a fallback (skip with `SKIP_CODESEARCH_FETCH=1`). Native tools (`semantic_search`, `search_codebase` semantic mode) probe gortex, then codesearch, then vera — preferring a system install on PATH over the bundled copy — and keep the index in sync with the workspace. Index data is stored globally under Copse app data (`gortex/` or `codesearch/` inside the `copse-panel` userData directory), not in the project tree; gortex additionally runs a per-user daemon (`gortex daemon`) whose sqlite store lives in the same sandboxed HOME.
