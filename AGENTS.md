# AGENTS.md

## Cursor Cloud specific instructions

`agent-pane` is a single product: an Electron desktop app (an AI coding assistant). There is no
backend service — the app's main process talks directly to LLM providers. The standard scripts
live in `package.json` (`dev`, `build`, `start`, `typecheck`, `lint`, `format:check`, `test`,
`test:e2e`, `check`); CI (`.github/workflows/ci.yml`) runs the full `check` + `build` + `test:e2e`
sequence. Prefer those rather than reinventing commands.

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
`OPENAI_API_KEY` set (and `AGENT_WINDOW_MOCK_LLM` unset), the app falls back to `MockLLMProvider`
(`src/shared/llm/mock-provider.ts`), which echoes `Mock response to: <message>` and issues one
`list_dir` tool call on the first turn — enough to drive the full agent loop end-to-end. Set
`AGENT_WINDOW_MOCK_LLM=1` to force the mock even when keys are present.

### Before committing

Agents should run **`npm run check`** before creating a commit. That runs typecheck, ESLint,
Prettier, and unit tests (`npm test`) — the same fast gates CI runs before build/e2e. If you
changed renderer UI or e2e fixtures, also run **`npm run build && npm run test:e2e`** locally
(macOS/Linux paths for seeded `electron-store` data must match `src/main/app-init.ts`).

### App data / state

Persistent state (projects, threads, selected model, workspace root) lives in an `electron-store`
JSON named `config.json` under the app userData directory (`agent-pane` in
`src/main/app-init.ts`): on macOS
`~/Library/Application Support/agent-pane/`, on Linux `~/.config/agent-pane/`, on Windows
`%APPDATA%/agent-pane/`. The "Open Folder" button uses a native dialog; to open a workspace
without driving that dialog, pre-seed `config.json` with a `projects` entry and `activeProjectId`
before launching.

### Tests

- `npm test` runs Node's test runner over `src/**/*.test.ts` (esbuild-bundled into `dist-test/`).
- `npm run test:e2e` is WebdriverIO + `@wdio/electron-service` and needs a display. It passes under
  `npm run test:e2e` on this headless VM (WDIO auto-starts Xvfb on Linux).

### Visual validation (tool UI / screenshots)

Use WebdriverIO Electron e2e — do not hand-drive VNC unless debugging layout.

1. `npm run build`
2. Seed `~/.config/agent-pane/config.json` before launch (see `tests/e2e/helpers/seed-config.ts`):
   - `projects` + `activeProjectId` pointing at repo root
   - optional `threads:<projectId>` with pre-built `toolCalls` to exercise grouping without a real model
3. Launch with mock LLM: `AGENT_WINDOW_MOCK_LLM=1 ANTHROPIC_API_KEY= OPENAI_API_KEY=`
4. Run: `npm run test:e2e -- --spec tests/e2e/tool-display.e2e.ts`
5. Screenshots land in `tests/e2e/screenshots/`:
   - `tool-display-collapsed.png` — grouped label (`Reading files ×2`) + failed tool outside group
   - `tool-display-group-expanded.png` — nested human names (`Read file`, `List directory`)
   - `tool-display-live-mock.png` — live mock turn shows `List directory` (not `list_dir`)

Assertions to mirror: `.tool-card-group .tool-name` = group label; `.tool-count` = `×N`;
failed tools stay `.tool-card[data-status=error]` with individual `getToolDisplayName` labels.
Unit coverage for grouping logic: `src/shared/tools/tool-display.test.ts`.
