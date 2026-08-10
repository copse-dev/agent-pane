# Agent development environment

Operational reference for running, seeding, and validating Copse. The rules that apply to every
change stay in [`AGENTS.md`](../AGENTS.md); this guide holds environment-specific mechanics that are
useful only when that workflow needs them.

## Runtime and standard scripts

Copse is an Electron desktop app with no backend service. The standard scripts live in
`package.json`; use `dev`, `build`, `start`, `typecheck`, `lint`, `format:check`, `test`, `test:e2e`,
and `check` rather than recreating their behavior.

The repo pins Node `22.18.0` in `.nvmrc` and requires Node `>=22.18`. Tooling under `scripts/*.mts`
uses native TypeScript type stripping. An older Node 22 can fail at `check:dead-code` with
`ERR_UNKNOWN_FILE_EXTENSION` for `.mts` files.

Cursor Cloud setup normally installs the pinned version through `.cursor/cloud-setup.sh`. If an
older executable still shadows it, activate the repo version:

```bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install
nvm use
export PATH="$HOME/.nvm/versions/node/v$(cat .nvmrc)/bin:$PATH"
```

Confirm with `node -v` before debugging a tooling failure.

## Headless GUI development

The Cloud VM exposes a VNC desktop on `DISPLAY=:1`, so launch the app with
`DISPLAY=:1 npm run dev`. Prefer WebdriverIO for repeatable evidence; use VNC to debug layout or
runtime behavior.

Known environment behavior:

- A first `npm run dev` can transiently read `dist/main/index.js` while the initial bundle is being
  written. Run `npm run build` once first or restart the watcher if it reports a startup syntax error.
- Headless GPU and D-Bus initialization errors are usually benign when the app still renders. An
  explicit Electron launch may use `--disable-gpu` to quiet them.
- The VNC screen blanker can cover a healthy app after roughly ten seconds without a real X input
  event. Pointer warps do not reset it. For a recording, an unbound real key event keeps it awake:

  ```bash
  while true; do DISPLAY=:1 xdotool key F15; sleep 0.5; done
  ```

## Model-free agent runs

No provider key is needed to exercise the core loop. When neither `ANTHROPIC_API_KEY` nor
`OPENAI_API_KEY` is set and `COPSE_PANEL_MOCK_LLM` is unset, Copse falls back to
`MockLLMProvider` (`src/shared/llm/mock-provider.ts`). It echoes the user message and issues one
`list_dir` call on its first turn. Set `COPSE_PANEL_MOCK_LLM=1` to force it when credentials exist.

Development and test builds support two one-shot mock directives in a user message:

- `[[mcp:<tool> {json}]]` selects a tool call.
- `[[mock:delay_ms <n>]]` delays the response.

They are gated behind `__COPSE_TEST_DIRECTIVES__`. `npm run build:release` sets `COPSE_RELEASE=1`,
dead-code eliminates the parser, and fails if a directive marker survives, so packaged apps do not
ship this test language.

For a multi-turn e2e, register an ordered regex-to-tool/text script through
`window.__copseE2e.setMockScript([…])`. Keep the script next to the natural-language prompts in the
spec; `tests/e2e/mock-script-multiturn.e2e.ts` is the reference. Reserve inline directives for
one-shot steering.

## App data and seeded state

Everything Copse persists lives under one root, `~/.copse/` (`COPSE_DIR` moves the whole profile):

| Path                                                                                 | Contents                                                                 |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `user-data/config.json`                                                              | projects, `activeProjectId`, workspace root, pack settings, usage ledger |
| `user-data/settings.json`                                                            | settings, including encrypted API keys                                   |
| `user-data/` (rest)                                                                  | `mcp.json`, `tools/`, browser profiles, `gortex/` semantic index         |
| `workspace/<projectId>/<threadId>/`                                                  | threads, tasks, decision log, deferred approvals                         |
| `worktrees/`                                                                         | Copse-managed Git worktrees                                              |
| `knowledge/`, `long-tasks/`, `roadmap-review/`, `pack-tool-snapshots/`, `hooks.json` | per-feature stores                                                       |

Electron's `userData` used to default to `<appData>/copse-panel` (`~/Library/Application Support/`
on macOS), which split the profile across two unrelated directories. `app-init.ts` now points it at
`~/.copse/user-data/` and migrates a legacy directory across on first launch;
`COPSE_PANEL_USER_DATA` still pins an exact directory and skips migration.

To bypass the native “Open Folder” dialog, pre-seed a `projects` entry and `activeProjectId`.

Chat threads do not live in `config.json`. They use the filesystem-native store at
`~/.copse/workspace/<projectId>/<threadId>/`, with `meta.json`, append-only `events.jsonl`, OKF
`messages/*.md`, and `blobs/*`. `COPSE_WORKSPACE_DIR` overrides just that root. The e2e harness and
unit tests point it at a disposable directory.

Use `writeSeedConfig` in `tests/e2e/helpers/seed-config.ts` to seed e2e state. It translates any
`threads:<projectId>` fixture array into the native thread directories; writing that key directly to
`config.json` no longer works. The thread store is mounted read-only into agent read tools for past
thread references. See [`thread-store-format.md`](thread-store-format.md).

## Focused validation

The post-edit hook runs `scripts/hook-file-check.mts` through the Copse, Cursor, and Claude hook
configs. It auto-applies Prettier and reports type-unaware ESLint findings. A reported rewrite makes
the agent's prior view stale, so re-read that file. Type-aware rules and `tsc` remain part of
`npm run check`.

While iterating, use a path/base-name/glob filter or the test oracle:

```bash
npm test -- thread-store
npm run oracle -- --explain
npm run oracle -- --run unit
npm run oracle -- --run e2e
```

A filter matching zero tests is an error. Trust an oracle subset only at `HIGH` confidence; `LOW`
lists blind spots and `broad` calls for the full tier. Always run `npm run check` before committing.
See [`testing-strategy.md`](testing-strategy.md) for the complete tier and CI policy.

### Remote validation

Prefer the ordinary remote e2e loop when a cloud host is configured:

```bash
npm run e2e:remote -- run --detach
npm run e2e:remote -- wait <run-id>
```

Results land in `.tmp/remote-e2e/runs/<run-id>/`. With `COPSE_CI_REGISTRY`, `e2e:remote up` pulls a
pre-baked image. Use local `test:e2e` for macOS-specific behavior, where no remote host is available,
or when a skill requires an on-machine display. For native GUI behavior or authenticated real-agent
runs, use the isolated workflow in [`remote-agent-demo-debugging.md`](remote-agent-demo-debugging.md).

## Visual validation

Every visible change needs the smallest focused browser or Electron spec that seeds the target
state, asserts its DOM behavior, and saves a screenshot. Do not substitute a manual VNC glance.

A typical Electron fixture flow is:

1. Run `npm run build`.
2. Seed the app through `tests/e2e/helpers/seed-config.ts` with a project and active project id.
3. Launch with `COPSE_PANEL_MOCK_LLM=1 ANTHROPIC_API_KEY= OPENAI_API_KEY=` when the state needs the
   agent loop but not a real model.
4. Run the focused spec, for example
   `npm run test:e2e -- --spec tests/e2e/tool-display-live-mock.e2e.ts`.
5. Inspect the resulting image under `tests/e2e/screenshots/`.

The test oracle defines screenshot ownership. CI writes back only images mapped to the diff (plus
images deliberately committed on the branch). If a real visual change is not mapped, apply the
`update-screenshots` label. The policy is implemented by `scripts/lib/screenshot-scope.mts`; fixture
determinism and tier selection are documented in [`testing-strategy.md`](testing-strategy.md).
