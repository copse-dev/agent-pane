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

The mock also honors test-only steering directives in the user message — `[[mcp:<tool> {json}]]`
(drive a specific tool call) and `[[mock:delay_ms <n>]]` (stall) — used by e2e specs. These are
gated behind the `__COPSE_TEST_DIRECTIVES__` build constant: `npm run build` (dev/e2e/CI) keeps
them, but `npm run build:release` (used by `pack:mac`/packaging) sets `COPSE_RELEASE=1`, so esbuild
dead-code-eliminates the parser and `build.mts` fails the build if any directive marker survives.
Shipped apps therefore never contain the directive parser.

For multi-turn e2e, specs can register an **ordered mock script** (regex `when` → tool or text
response) via `window.__copseE2e.setMockScript([…])` before submitting natural-language prompts.
Define the script in the spec file next to the prompts it drives (`tests/e2e/mock-script-multiturn.e2e.ts`).
The legacy `[[mcp:…]]` inline directives remain for one-shot tool steering.

### Hooks / feature-pack work

Any change touching agent hooks (`cursor-hooks`, `claude-hooks`, the permission-gate
hook path), loop nudges/steering, auto-continuation, or feature-pack extraction MUST
follow [`docs/plans/hooks-and-feature-packs.md`](docs/plans/hooks-and-feature-packs.md).
Its decisions log is binding: on conflict, update that doc in the same PR — never
silently diverge. Read its "Execution guidance" and "Known implementation traps"
sections before writing code.

### Before committing

Before opening a PR, rebase onto **`origin/main`** — GitHub PR CI tests the merge of base into head, not your branch tip alone.

Agents should run **`npm run check`** before creating a commit. That runs typecheck, ESLint,
Prettier, the dead-code guard (`check:dead-code` — fails on `src/**/*.ts` files that nothing in
the build graph imports), and unit tests (`npm test`) — the same fast gates CI runs before
build/e2e. If a file is intentionally unreferenced, add it to `ALLOWED_UNLINKED` in
`scripts/check-dead-code.mts` with a reason rather than leaving it to be flagged. If you
changed renderer UI or e2e fixtures, also run **`npm run build && npm run test:e2e`** locally
(macOS/Linux paths for seeded `electron-store` data must match `src/main/app-init.ts`).

### Type-safety & lint discipline

Minimise `as` casts, never cast object literals, and never reach for `eslint-disable` /
`@ts-expect-error` to silence a real error. Conventions and the rules behind them:
[`docs/type-safety.md`](docs/type-safety.md).

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

Persistent state (projects, selected model, workspace root, settings) lives in an `electron-store`
JSON named `config.json` under the app userData directory (`copse-panel` in
`src/main/app-init.ts`): on macOS
`~/Library/Application Support/copse-panel/`, on Linux `~/.config/copse-panel/`, on Windows
`%APPDATA%/copse-panel/`. The "Open Folder" button uses a native dialog; to open a workspace
without driving that dialog, pre-seed `config.json` with a `projects` entry and `activeProjectId`
before launching.

**Chat threads are no longer in `config.json`.** They live in the filesystem-native thread store
under `~/.copse/workspace/<projectId>/<threadId>/` (issue #644) — one directory per thread
(`meta.json` + append-only `events.jsonl` spine + OKF `messages/*.md` + `blobs/*`), documented in
[docs/thread-store-format.md](docs/thread-store-format.md). Override the root with
`COPSE_WORKSPACE_DIR` (the e2e harness and unit tests point it at a throwaway dir). To seed threads
for a test, don't write a `threads:<projectId>` key — use `writeSeedConfig`
(`tests/e2e/helpers/seed-config.ts`), which routes any such array into new-format thread dirs. The
store is mounted **read-only** into the agent's read tools so it can `@`-reference past threads.

### Shell / tool permissions across platforms

Shell command auto-run is gated by a single pure decision function,
`decideShellPermission` (`src/main/services/permission-policy.ts`), called from
`permission-gate.ts`. The OS sandbox is **macOS-only**; other platforms rely on
static analysis plus an optional classifier. This is intentional, not a fallback
ambiguity — the per-platform behavior is:

| Situation                                                        | Sandbox-contained command                                                                                                                                                                                                       | Hard-external command (network download, `git push`, install, `~/...`)                                                            | Ambiguous "may reach" command (`gh`, `nc`, `aws`/`gcloud`/`az`, `open <url>`)                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS, ASRT sandbox active**                                   | Auto-runs **inside** the seatbelt sandbox. The classifier is not consulted; seatbelt is the real boundary.                                                                                                                      | Prompts first, then runs **outside** the sandbox.                                                                                 | Auto-runs **inside** the seatbelt sandbox (no upfront prompt). If seatbelt blocks it, `shell-tool` offers a retry-unsandboxed prompt — same as a sandbox-contained command that later fails (e.g. Playwright). If the agent passes `expects_sandbox_block: true`, that same prompt is pulled **forward** — asked before the first attempt instead of after a block. |
| **macOS sandbox init failure / Linux / Windows (no OS sandbox)** | Auto-runs **only** if the optional LM Studio safety classifier returns `scope: "sandbox"` with confidence ≥ `safetySandboxAllowThreshold` (default `0.85`); otherwise prompts. With the classifier off/unavailable, it prompts. | Always prompts (static analysis flags `external` before the classifier is consulted), unless strict-mode hard-deny fires (below). | Always prompts (treated like hard-external when no OS sandbox can contain it).                                                                                                                                                                                                                                                                                      |
| **Auto-run disabled in Settings** (`autoRunSandboxCommands` off) | Prompts.                                                                                                                                                                                                                        | Prompts.                                                                                                                          | Prompts.                                                                                                                                                                                                                                                                                                                                                            |

The ambiguous tier exists because short/overloaded command names (`gh`, `nc`, …)
collide with file paths and arguments (e.g. `grep … src/.../gh-pr-service.ts`).
Rather than prompt on a guess, macOS lets seatbelt — the actual boundary — decide:
the command runs sandboxed and only escalates to an unsandboxed retry if the OS
truly blocks it. Without an OS sandbox there is nothing to contain a misfire, so
these still prompt.

The `safetyExternalDenyThreshold` knob tunes the no-OS-sandbox path around the
default "surface it" behavior:

- **`safetyExternalDenyThreshold`** (default `1` = off) — strict mode. When the
  classifier is at least this confident a command is `external` **and** a
  deterministic destructive signal fires (`dangerousInSandboxReasons`), the
  command is **hard-denied** (`decideShellPermission` returns `action: 'deny'`,
  which `permission-gate` throws on) instead of being surfaced for approval. It
  never denies plain external work — both an external verdict and a destructive
  signal are required. Lower it (e.g. `0.9`) to enable.

When the agent already knows a command needs the network or outside-workspace
files (e.g. `gh`, cloud CLIs), it can pass `expects_sandbox_block: true` on
`run_shell` to request that same unsandboxed approval **up front** instead of
running inside seatbelt, failing partway, and retrying. The hint is honored
**only** for the `ambiguous` tier (`shellExpectedBlockEscalation`): a
hard-`external` command already prompts + runs outside, and a fully-contained
`sandbox` command ignores the hint entirely — it must still earn its escape from
a runner-verified block, never a model self-declaration (issues #103/#104). The
up-front prompt is worded as the agent's _expectation_ (not a confirmed block) so
the user can apply the appropriate scrutiny. Declining runs the command inside the
sandbox without re-prompting on failure.

Key components:

- `permission-policy.ts` — `decideShellPermission` (pure; the table above),
  `shellRequiresOutsideSandbox`, MCP-tool decisions, and the prompt-body
  formatters that explain _why_ a command is being prompted.
- `shell-scope.ts` — static `analyzeShellCommand` heuristic (`sandbox`,
  `ambiguous`, or `external`), with human-readable `reasons`. Fuzzy "may reach"
  matchers are tagged `ambiguous: true`; a command is only `external` when a
  definite escape (hard pattern or outside-workspace path) fires.
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

For _which tier a test belongs in_ — favour unit/component tests, reserve e2e for broad validation
and real-runtime checks (sizing/rendering, Monaco, terminal, webview, main IPC) — read
[`docs/testing-strategy.md`](docs/testing-strategy.md). The per-spec e2e→component migration backlog
is in [`docs/e2e-component-migration.md`](docs/e2e-component-migration.md).

### Visual validation (tool UI / screenshots)

Use WebdriverIO Electron e2e — do not hand-drive VNC unless debugging layout. For every visual
change, add or update the smallest focused spec that exercises the changed state and captures at
least one screenshot that reviewers can inspect.

1. `npm run build`
2. Seed `~/.config/copse-panel/config.json` before launch (see `tests/e2e/helpers/seed-config.ts`):
   - `projects` + `activeProjectId` pointing at repo root
   - optional `threads:<projectId>` with pre-built `toolCalls` to exercise grouping without a real model
3. Launch with mock LLM: `COPSE_PANEL_MOCK_LLM=1 ANTHROPIC_API_KEY= OPENAI_API_KEY=`
4. Run: `npm run test:e2e -- --spec tests/e2e/tool-display-live-mock.e2e.ts`
5. Screenshots land in `tests/e2e/screenshots/`:
   - `tool-display-live-mock.png` — live mock turn shows `List directory` (not `list_dir`)

Assertions to mirror: `.tool-card-group .tool-name` = group label; `.tool-count` = `×N`;
failed tools stay `.tool-card[data-status=error]` with individual `getToolDisplayName` labels.
The seeded tool-card DOM assertions now run without Electron in the component test
`src/renderer/views/tool-display.test.ts`; grouping logic in `src/shared/tools/tool-display.test.ts`.

### Markdown rendering

Conversation messages, subagent timelines, and file preview use the hand-rolled renderer in
`src/renderer/markdown/`. Design invariants, regression tests, and e2e fixtures are documented in
[`src/renderer/markdown/README.md`](src/renderer/markdown/README.md). Table layout taste (wrapping,
no magic column widths) is in [`docs/ui-taste.md`](docs/ui-taste.md).

After markdown or list-indent changes, run `npm run build && npm run test:e2e:markdown`.
