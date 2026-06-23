# AGENTS.md

## Cursor Cloud specific instructions

`copse-panel` (branded **Copse**) is a single product: an Electron desktop app (an AI coding assistant). There is no
backend service — the app's main process talks directly to LLM providers. The standard scripts
live in `package.json` (`dev`, `build`, `start`, `typecheck`, `lint`, `format:check`, `test`,
`test:e2e`, `check`); CI (`.github/workflows/ci.yml`) runs the full `check` + `build` + `test:e2e`
sequence. Prefer those rather than reinventing commands.

### Node version (>=22.18 required)

This repo pins Node via `.nvmrc` (`22.18.0`) and `package.json` `engines` (`>=22.18`). The build/check
tooling under `scripts/*.mts` relies on Node's native TypeScript type-stripping, which older 22.x
releases lack. **The Cloud VM default `node` may be older than this** (e.g. `/exec-daemon/node` at
`22.14`), in which case `npm run check` fails at `check:dead-code` with
`TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".mts"`. The cloud environment config
(`.cursor/environment.json` → `.cursor/cloud-setup.sh`) installs and defaults Node to `.nvmrc` so fresh
agents start correct. If you still land on an older node, switch before running anything:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm install; nvm use   # reads .nvmrc
# nvm's `use` may not stick if an older node shadows PATH; if `node -v` is still wrong, prepend it:
export PATH="$HOME/.nvm/versions/node/v$(cat .nvmrc)/bin:$PATH"
```

### Running the app (headless VNC notes)

This is a GUI Electron app. The Cloud VM exposes a VNC desktop on `DISPLAY=:1`, so launch with
that display set (e.g. `DISPLAY=:1 npm run dev`). Key gotchas discovered during setup:

- **First `npm run dev` can crash once with a `SyntaxError` at `dist/main/index.js`.** `scripts/dev.mts`
  relaunches Electron from an `esbuild` `onEnd` hook for each of its three build contexts, so the
  very first launch can race the bundle write when `dist/` is empty and read a half-written file.
  It is transient: the watcher rebuilds and relaunches with a complete bundle. To avoid it entirely,
  run `npm run build` once before `npm run dev` (so `dist/` already holds a valid bundle), or just
  restart `npm run dev`.
- **GPU errors are benign.** The headless GPU stack logs `Exiting GPU process due to errors during
initialization` / `bus.cc ... Failed to connect to the bus`. The app still runs and renders. Add
  `--disable-gpu` (e.g. `DISPLAY=:1 npx electron --disable-gpu dist/main/index.js`) to silence the
  GPU noise; it is optional.
- **VNC idle screen-blanker.** After ~10s without a _real_ X input event the VNC desktop blanks to a
  black screen / spinning cube / clock overlay that hides the app window — this is NOT an app crash
  (the Electron process keeps running). Synthetic pointer warps (`xdotool mousemove_relative`) do
  NOT reset it, but real key events do. For clean screen recordings, run a keep-awake loop of real
  key events, e.g. `while true; do DISPLAY=:1 xdotool key F15; sleep 0.5; done` (F15 is unbound and
  does not interfere with typing).

### LLM provider / mock

No real model key is required to exercise core functionality. With neither `ANTHROPIC_API_KEY` nor
`OPENAI_API_KEY` set (and `COPSE_PANEL_MOCK_LLM` unset), the app falls back to `MockLLMProvider`
(`src/shared/llm/mock-provider.ts`), which echoes `Mock response to: <message>` and issues one
`list_dir` tool call on the first turn — enough to drive the full agent loop end-to-end. Set
`COPSE_PANEL_MOCK_LLM=1` to force the mock even when keys are present.

### Before committing

Before opening a PR, rebase onto **`origin/main`** — GitHub PR CI tests the merge of base into head, not your branch tip alone.

Agents should run **`npm run check`** before creating a commit. That runs typecheck, ESLint,
Prettier, the dead-code guard (`check:dead-code` — fails on `src/**/*.ts` files that nothing in
the build graph imports), and unit tests (`npm test`) — the same fast gates CI runs before
build/e2e. If a file is intentionally unreferenced, add it to `ALLOWED_UNLINKED` in
`scripts/check-dead-code.mts` with a reason rather than leaving it to be flagged. If you
changed renderer UI or e2e fixtures, also run **`npm run build && npm run test:e2e`** locally
(macOS/Linux paths for seeded `electron-store` data must match `src/main/app-init.ts`).

### Visual changes require evals

Any change that affects what a user can see in the Electron app must include a focused visual eval
unless the change is demonstrably invisible (for example, pure data plumbing with unchanged DOM).
This includes edits to renderer components, styles, markdown rendering, tool cards, terminal/diff
surfaces, screenshots fixtures, and visual copy/layout states. The eval should be a WebdriverIO
Electron e2e spec that seeds the app into the target state, asserts the relevant DOM behavior, and
saves screenshots for visual inspection. Use `.cursor/skills/screenshot-validate/SKILL.md` for
DOM/layout changes and `.cursor/skills/agent-run-eval/SKILL.md` only when the visual change depends
on an agent/tool loop. Do not rely on `npm run check`, a build, or manual VNC inspection alone as
proof for a visual change.

For appearance/layout taste — design-token usage, action-bar spacing, the sticky-footer-in-scroll
gotcha, and other hard-won UI conventions — read and extend [`docs/ui-taste.md`](docs/ui-taste.md).

### App data / state

Persistent state (projects, threads, selected model, workspace root) lives in an `electron-store`
JSON named `config.json` under the app userData directory (`copse-panel` in
`src/main/app-init.ts`): on macOS
`~/Library/Application Support/copse-panel/`, on Linux `~/.config/copse-panel/`, on Windows
`%APPDATA%/copse-panel/`. The "Open Folder" button uses a native dialog; to open a workspace
without driving that dialog, pre-seed `config.json` with a `projects` entry and `activeProjectId`
before launching.

### Shell / tool permissions across platforms

Shell command auto-run is gated by a single pure decision function,
`decideShellPermission` (`src/main/services/permission-policy.ts`), called from
`permission-gate.ts`. The OS sandbox is **macOS-only**; other platforms rely on
static analysis plus an optional classifier. This is intentional, not a fallback
ambiguity — the per-platform behavior is:

| Situation                                                        | Sandbox-contained command                                                                                                                                                                                                             | External command (network, `gh`, `git push`, `~/...`)                                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS, ASRT sandbox active**                                   | Auto-runs **inside** the seatbelt sandbox. The classifier is not consulted; seatbelt is the real boundary.                                                                                                                            | Prompts first, then runs **outside** the sandbox. If a sandbox-contained command later fails (e.g. Playwright), `shell-tool` offers a retry-unsandboxed prompt. |
| **macOS sandbox init failure / Linux / Windows (no OS sandbox)** | Auto-runs **only** if the optional LM Studio safety classifier returns `scope: "sandbox"` with confidence ≥ `lmStudioSafetyConfidenceThreshold` (default `0.85`); otherwise prompts. With the classifier off/unavailable, it prompts. | Always prompts (static analysis flags `external` before the classifier is consulted).                                                                           |
| **Auto-run disabled in Settings** (`autoRunSandboxCommands` off) | Prompts.                                                                                                                                                                                                                              | Prompts.                                                                                                                                                        |

Key components:

- `permission-policy.ts` — `decideShellPermission` (pure; the table above),
  `shellRequiresOutsideSandbox`, MCP-tool decisions, and the prompt-body
  formatters that explain _why_ a command is being prompted.
- `shell-scope.ts` — static `analyzeShellCommand` heuristic (`sandbox` vs
  `external`), with human-readable `reasons`.
- `safety-classifier.ts` — optional LM Studio classifier (`classifyShellScope`),
  used **only** when the OS sandbox is unavailable; returns `null` when disabled
  or unreachable.
- `project-sandbox/` — macOS ASRT integration. `isProjectSandboxEnabled()`
  returns `false` on any non-`darwin` platform regardless of the stored flag, so
  non-macOS code paths never assume a sandbox boundary exists.

Tests pinning the documented matrix: `permission-platform.test.ts` (per-platform
decisions) and `permission-gate.test.ts` (gate wiring + MCP decisions).

### Tests

- `npm test` runs Node's test runner over `src/**/*.test.ts` (esbuild-bundled into `dist-test/`).
- `npm run test:e2e` is WebdriverIO + `@wdio/electron-service` and needs a display. It passes under
  `npm run test:e2e` on this headless VM (WDIO auto-starts Xvfb on Linux).

### Visual validation (tool UI / screenshots)

Use WebdriverIO Electron e2e — do not hand-drive VNC unless debugging layout. For every visual
change, add or update the smallest focused spec that exercises the changed state and captures at
least one screenshot that reviewers can inspect.

1. `npm run build`
2. Seed `~/.config/copse-panel/config.json` before launch (see `tests/e2e/helpers/seed-config.ts`):
   - `projects` + `activeProjectId` pointing at repo root
   - optional `threads:<projectId>` with pre-built `toolCalls` to exercise grouping without a real model
3. Launch with mock LLM: `COPSE_PANEL_MOCK_LLM=1 ANTHROPIC_API_KEY= OPENAI_API_KEY=`
4. Run: `npm run test:e2e -- --spec tests/e2e/tool-display.e2e.ts`
5. Screenshots land in `tests/e2e/screenshots/`:
   - `tool-display-collapsed.png` — grouped label (`Reading files ×2`) + failed tool outside group
   - `tool-display-group-expanded.png` — nested human names (`Read file`, `List directory`)
   - `tool-display-live-mock.png` — live mock turn shows `List directory` (not `list_dir`)

Assertions to mirror: `.tool-card-group .tool-name` = group label; `.tool-count` = `×N`;
failed tools stay `.tool-card[data-status=error]` with individual `getToolDisplayName` labels.
Unit coverage for grouping logic: `src/shared/tools/tool-display.test.ts`.

### Markdown rendering

Conversation messages, subagent timelines, and file preview use the hand-rolled renderer in
`src/renderer/markdown/`. Design invariants, regression tests, and e2e fixtures are documented in
[`src/renderer/markdown/README.md`](src/renderer/markdown/README.md).

After markdown or list-indent changes, run `npm run build && npm run test:e2e:markdown`.
