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

### App data / state

Persistent state (projects, threads, selected model, workspace root) lives in an `electron-store`
JSON at `~/.config/agent-pane/config.json` (the app sets its userData dir to `agent-pane` in
`src/main/app-init.ts`). The "Open Folder" button uses a native GTK dialog; to open a workspace
without driving that dialog, pre-seed `config.json` with a `projects` entry and `activeProjectId`
before launching.

### Tests

- `npm test` runs Node's test runner over `src/**/*.test.ts` (esbuild-bundled into `dist-test/`).
- `npm run test:e2e` is Playwright + Electron and needs a display. It passes under
  `xvfb-run -a npx playwright test` on this headless VM.
