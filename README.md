<p align="center">
  <img src="assets/icons/rose/icon-dock-512.png" alt="Copse" width="96" height="96">
</p>

# Copse

**An open-source AI coding assistant that lives alongside your code.**

Copse brings agent chat, an editor, terminal, git tools, and a browser into one desktop app. Ask it to understand a codebase, make a change, run tests, or investigate a problem while you follow its work and stay in control of what it can do.

Copse has no hosted backend of its own. Connect your preferred cloud provider directly, use a local model, or combine the two.

<p align="center">
  <a href="https://github.com/copse-dev/agent-pane"><strong>View on GitHub</strong></a>
  ·
  <a href="https://copse.dev/">Website</a>
  ·
  <a href="https://github.com/copse-dev/agent-pane/issues">Issues</a>
</p>

![Copse showing a project, agent conversation, and editor](site/screenshots/chat-layout-three-pane.png)

> Copse is currently distributed from source. The supported app target is macOS 26 or newer on Apple Silicon and Intel Macs. Linux and Windows can be used for source development, but are not supported release targets yet.

## Why Copse?

- **Everything in one workspace.** Chat with an agent beside a Monaco editor, terminal, file explorer, git changes, and an in-app browser.
- **Bring the models you want.** Use Anthropic, OpenAI, OpenRouter, and other hosted providers, or connect local models through LM Studio, Ollama, llama.cpp, Jan, vLLM, and OpenAI-compatible endpoints.
- **See the work, not just the answer.** Tool activity, diffs, commands, subagents, and failures stay visible in the conversation.
- **Keep meaningful control.** Inspect every file edit in the Changes pane; edits that cannot be applied safely wait for your approval. Actions that need access beyond the project sandbox ask first. Copse sends requests directly to the provider you select and does not add its own cloud service in the middle.
- **Extend the agent.** Add reusable skills, MCP servers, custom tools, hooks, and compatible ACP coding agents. Copse can also reuse supported skills and MCP servers from your existing Cursor setup.
- **Work your way.** Attach files, editor selections, or screen recordings; search code by meaning; fork conversations; queue follow-up messages; and hand exploration to subagents.

## Get started

You need [Node.js](https://nodejs.org/) 24 or newer, and on macOS the Xcode command-line tools (`xcode-select --install`) so the bundled terminal's native module can compile. Everything else is provisioned for you: `make` enables Corepack, which supplies the pinned `pnpm@10.34.5` from `packageManager`. Both `nvm use` and `fnm use` select the exact LTS release pinned in `.nvmrc`.

```bash
git clone https://github.com/copse-dev/agent-pane.git
cd agent-pane
make run
```

`make run` checks your Node version, installs dependencies, builds `dist/`, and launches the app. It is idempotent and cheap to repeat: dependency inputs, build inputs, and the complete build output tree are content-addressed, so running it again after a branch switch or `git pull` does the minimum work needed without trusting filesystem timestamps. Run `make` on its own for the full target list.

`make run` builds once and starts. While actively editing the app, `pnpm run dev` (or `make run-dev`) is still the loop you want — it rebuilds and relaunches Electron on save, against its own persistent `~/.copse-dev` profile so it never shares threads or settings with the app `make run` launches:

```bash
corepack enable
pnpm install
pnpm run dev
```

pnpm uses a content-addressable store with `package-import-method=auto` (clone on
APFS, then hardlink, then copy) so additional git worktrees reuse package bytes.
Electron’s extracted app bundle and the vendored gortex binary are shared under
`~/.copse/cache/electron-dist/` and `~/.copse/cache/gortex/`. Each worktree still
needs its own install — `make run` or `pnpm install` — to link `node_modules` and
those caches.

Then:

1. Open a project folder.
2. Choose a model during setup. You can enter a provider API key, scan your environment for an existing key, or connect a local model server.
3. Start with a concrete request such as “explain how authentication works,” “fix the failing tests,” or “add this feature and show me the diff.”

API keys entered in Copse are encrypted with the operating system's secure storage when it is available. Environment-only keys are not written to Copse's settings. See [Privacy and data flow](docs/privacy-data-flow.md) and [Provider data policies](docs/provider-data-policies.md) before choosing a hosted provider.

## What’s included

| Area       | Highlights                                                                           |
| ---------- | ------------------------------------------------------------------------------------ |
| Agent      | Multi-turn chat, plans, tool calls, message queueing, thread forks, and subagents    |
| Code       | Monaco editing, file, selection and video attachments, diffs, and semantic search    |
| Workspace  | Integrated terminal, git status and changes, file explorer, and web browser          |
| Models     | Direct cloud providers, OpenRouter, local servers, and ACP coding agents             |
| Extensions | Skills, Cursor-compatible hooks and plugin sources, MCP, and JavaScript custom tools |
| Control    | Edit review, permission prompts, macOS project sandboxing, and per-tool approvals    |

## User guide

Install, first run, approvals, and the project sandbox:
**[docs/user/](docs/user/README.md)**.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). No paid model key is required to explore the development build: connect a local model, or launch with `COPSE_PANEL_MOCK_LLM=1 pnpm run dev` to opt into the built-in mock agent.

Before submitting a change, run:

```bash
pnpm run check
```

Changes to the Electron UI should also be built and covered by a focused end-to-end visual test. See [AGENTS.md](AGENTS.md) and the [testing strategy](docs/testing-strategy.md) for the full contributor workflow.

<details>
<summary><strong>Common development commands</strong></summary>

| Command             | Purpose                                                      |
| ------------------- | ------------------------------------------------------------ |
| `make run`          | Sync deps, rebuild if source changed, then launch the app    |
| `make build`        | Rebuild `dist/` if source changed (deps first)               |
| `make deps`         | Sync dependencies to their content fingerprint               |
| `make clean`        | Remove `dist/` and the dev-sync fingerprints                 |
| `pnpm run dev`      | Build in watch mode and launch Electron                      |
| `pnpm run build`    | Create the application bundle in `dist/`                     |
| `pnpm start`        | Launch an existing build                                     |
| `pnpm test`         | Run unit and component tests                                 |
| `pnpm run test:e2e` | Run Electron end-to-end tests                                |
| `pnpm run check`    | Run typecheck, lint, formatting, dead-code checks, and tests |

</details>

<details>
<summary><strong>Install troubleshooting</strong></summary>

Copse's postinstall prepares native Electron dependencies and downloads the bundled semantic-search engine. Project [`.npmrc`](.npmrc) sets `ignore-scripts=false`. An inherited `npm_config_ignore_scripts=true` still wins over `.npmrc` — `make deps` forces scripts on for that reason.

If `electron-rebuild` fails because a Homebrew Python cannot import
`distutils`, use the Python supplied with Xcode's command-line tools:

```bash
PYTHON=/usr/bin/python3 pnpm install
```

To install without scripts and finish natives manually:

```bash
pnpm install --config.ignore-scripts=true
SKIP_ELECTRON_REBUILD=1 node scripts/postinstall-native.mts
```

Or run the native setup alone after a normal install:

```bash
SKIP_ELECTRON_REBUILD=1 node scripts/postinstall-native.mts
```

Use `SKIP_GORTEX_FETCH=1` if you intentionally do not want the bundled semantic-search binary.

`make run` provisions pnpm and every bundled dependency, but it does not install Node or a C++ toolchain, so those gaps surface as raw tool errors rather than a friendly message:

- A `node-gyp` or `clang` error during install means the Xcode command-line tools are missing — `xcode-select --install`.
- `node is not installed`, or a version below 24, means Node itself needs installing or selecting. `nvm use` and `fnm use` both pick up the `.nvmrc` pin, and `make run` sources nvm automatically when it is present.
- An `EACCES` from `corepack enable` means your `node` lives somewhere unwritable (typically a `/usr/local` package install). Run `corepack enable` once with `sudo`, or switch to an nvm-managed Node.

If `make run` returns straight away without opening a window, another Copse instance already holds the single-instance lock and was focused instead. Quit it and re-run.

</details>

## Learn more

- [User guide](docs/user/README.md)
- [Support and known issues](SUPPORT.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Privacy and data flow](docs/privacy-data-flow.md)
- [Provider retention and training policies](docs/provider-data-policies.md)
- [Profiles, multiple profiles, and API-key portability](docs/profiles.md)
- [Backup and recovery](docs/recovery.md)
- [MCP example configuration](mcp.json.example)
- [Custom tools](docs/custom-tools.md)
- [Skills and feature packs](docs/plugins.md)
- [ACP agent setup](docs/acp-setup-guide.md)
- [Screen recording support](docs/video-frames.md)
- [Conversation storage format](docs/thread-store-format.md)
- [Changelog and releases](CHANGELOG.md)

## License

Copyright © 2026 Jonathan Kingston.

Copse is free software, available under the [GNU Affero General Public License
version 3](LICENSE). You may use, study, modify, and redistribute it. If you
distribute a modified version, or make one available to users over a network,
you must make the complete corresponding source available under the same
license.

Copse relicensed from Apache-2.0 to AGPL-3.0-only on 6 September 2026. Releases
up to and including `0.1.0-beta.8` were published under the Apache License 2.0,
and that grant remains in force for those versions. Everything from the
relicensing commit onward is AGPL-3.0-only.

Third-party components keep their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
