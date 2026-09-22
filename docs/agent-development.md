# Agent development environment

Operational reference for running, seeding, and validating Copse. The rules that apply to every
change stay in [`AGENTS.md`](../AGENTS.md); this guide holds environment-specific mechanics that are
useful only when that workflow needs them.

## Task brief and completion evidence

Before implementation, record a short brief in the owning issue or task:

- the user problem and observable acceptance examples;
- scope, exclusions, and the current base revision;
- risk and applicable contracts, especially permissions, persistence, auth/billing, and CI/release controls;
- the smallest validation that can establish the outcome, plus required broader gates.

Use the [product definition of done](product-definition-of-done-audit.md#definition-of-done).
At handoff, state what changed, the exact checks and results (or immutable run links), independent
review evidence when it exists, and anything unverified. Link remaining work instead of closing an
issue based only on a related implementation. The PR template asks for the same evidence; do not
paste an entire task transcript into it.

Keep a small active queue with an accountable owner for each commitment. Historical plans remain
design references. The [Shipping quality roadmap](plans/sdlc-improvement-roadmap.md) is tracked in
[#1373](https://github.com/copse-dev/agent-pane/issues/1373); task-evidence adoption remains open in
[#2718](https://github.com/copse-dev/agent-pane/issues/2718) until five completed changes demonstrate
the convention. These records do not establish or change branch-review requirements.

## Runtime and standard scripts

Copse is an Electron desktop app with no backend service. `make run` is the normal entry point: it
runs `check-node`, content-addresses dependency and build inputs, verifies the complete `dist/` tree,
and then starts the app. It is safe to repeat and does the minimum work needed even after branch
switches or edits with preserved mtimes. `make build` stops after syncing the build, and `make clean`
drops `dist/` and the dev-sync fingerprints.

The standard scripts live in `package.json`; use `dev`, `build`, `start`, `typecheck`, `lint`,
`format:check`, `test`, `test:e2e`, and `check` rather than recreating their behavior. Reach for
`dev` over `make run` when you want watch mode rather than a single build.

The repo pins the Node 24 LTS release in `.nvmrc` and requires Node `>=24` plus
pnpm (`packageManager`: `pnpm@10.34.5`; enable with `corepack enable`). Both nvm
and fnm read `.nvmrc`. Tooling under `scripts/*.mts` uses native TypeScript type
stripping.

Installs use pnpm’s default isolated linker with `package-import-method=auto`
(`.npmrc`: prefer clone, then hardlink, then copy) so packages are symlinked
through `node_modules/.pnpm` while store bytes are shared when the filesystem
allows. Agent-prepared worktrees route Corepack, the pnpm store, Electron downloads and extracted
runtime, and gortex through fixed directories under `~/.copse/cache/`. The read-only
`preflight_worktree` reports the current project's package-manager and declared setup readiness.
Pass its `planFingerprint` to one approved `prepare_worktree` call to install locked dependencies
and run the setup declared in `.copse/worktree-preparation.json`. This repository declares its
Electron/ChromeDriver/native/gortex steps there; other projects need none of those artifacts.
Python projects with `pyproject.toml` and `uv.lock` automatically use locked uv workspace sync;
they need an installed compatible Python and uv, but no Copse declaration. Preflight leaves the
project and shared caches read-only, using disposable scratch for manager bookkeeping.
See [project worktree preparation](plans/project-worktree-preparation.md).

Cursor Cloud setup normally installs the pinned version through `.cursor/cloud-setup.sh`. If an
older executable still shadows it, activate the repo version:

```bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install
nvm use
export PATH="$HOME/.nvm/versions/node/v$(cat .nvmrc)/bin:$PATH"
```

With fnm, run `fnm install && fnm use` from the repository root instead.

Confirm with `node -v` before debugging a tooling failure.

## Container engines on macOS

Container-backed development scripts use a small engine boundary instead of assuming
the Docker CLI. `COPSE_CONTAINER_ENGINE` accepts `auto`, `apple`, or `docker`:

- `auto` (the default) prefers a ready Apple container service on an Apple silicon
  Mac, then falls back to Docker before starting any build or container.
- `apple` requires Apple silicon, macOS 26 or newer, the signed
  [Apple container](https://apple.github.io/container/documentation/) package, and a
  running service (`container system start`). It never silently falls back.
- `docker` requires a reachable Docker daemon and preserves the previous commands.

The autonomy regression is portable across those engines:

```bash
COPSE_CONTAINER_ENGINE=apple pnpm run eval:autonomy
COPSE_CONTAINER_ENGINE=docker pnpm run eval:autonomy
```

For a model server bound to loopback, Apple container resolves
`host.container.internal`; create Apple's localhost DNS entry once as documented by
the project:

```bash
sudo container system dns create host.container.internal --localhost 203.0.113.113
```

The Apple mapping preserves the read-only root, dropped capabilities, resource
limits, tmpfs work areas, and artifact mount. It uses an `nproc` ulimit in place of
Docker's PID-limit flag because Apple container does not expose a direct equivalent.
Do not treat Apple container's `--internal` network as an egress security boundary;
the runtime's [host-only network issue](https://github.com/apple/container/issues/2062)
remains open. These development/eval workloads retain the same network access their
Docker versions had.

The shared CI runner image can also run on Apple container without Compose. See
[`ci-runners/README.md`](../ci-runners/README.md#apple-container--apple-silicon-macs)
and `pnpm run runners:apple -- --help`. Linux/cloud fleets, remote e2e hosts, and
third-party benchmark harnesses stay on Docker where they rely on Compose, Docker
sockets, or Linux host provisioning.

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

| Path                                                                                 | Contents                                                                   |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `user-data/config.json`                                                              | projects, `activeProjectId`, workspace root, plugin settings, usage ledger |
| `user-data/settings.json`                                                            | settings, including encrypted API keys                                     |
| `user-data/` (rest)                                                                  | `mcp.json`, `tools/`, browser profiles, `gortex/` semantic index           |
| `workspace/<projectId>/<threadId>/`                                                  | threads, tasks, decision log, deferred approvals                           |
| `worktrees/`                                                                         | Copse-managed Git worktrees                                                |
| `knowledge/`, `long-tasks/`, `roadmap-review/`, `pack-tool-snapshots/`, `hooks.json` | per-feature stores                                                         |

Electron's `userData` used to default to `<appData>/copse-panel` (`~/Library/Application Support/`
on macOS), which split the profile across two unrelated directories. `app-init.ts` now points it at
`~/.copse/user-data/` and migrates a legacy directory across on first launch;
`COPSE_PANEL_USER_DATA` still pins an exact directory and skips migration.

`pnpm run dev` (and `make run-dev`) launches against `~/.copse-dev` instead, so the watch loop keeps
its own persistent threads, settings, and plugins — and its own Electron single-instance lock, which
is what lets a dev build and `make run` be open at the same time. Setting `COPSE_DIR` or
`COPSE_PANEL_USER_DATA` yourself disables that default, including setting `COPSE_DIR=~/.copse` to
reproduce something against the everyday profile.

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
configs. It auto-applies oxfmt and reports type-unaware ESLint findings. A reported rewrite makes
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

Inside a Copse agent session, send local Electron e2e through Copse's `run_shell` host path with the
same wrapper used by `test:e2e`:

```bash
node scripts/run-e2e.mts wdio.conf.ts --spec tests/e2e/example.e2e.ts
```

The direct script form lets the permission gate ask before launching it outside the project sandbox.
Electron and ChromeDriver then have the macOS host temp directories and services they need. The ACP
process's own shell remains nested inside its session sandbox and cannot provide that host access.

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

The test oracle defines screenshot ownership. The CI run remains read-only and attaches changed
renders as an immutable artifact retained for 14 days. After a successful same-repository run, a
trusted follow-up links that evidence from the parent PR. Ordinary runs do not open another PR or
update references. Review the screenshots with the change; an artifact is evidence, not visual
acceptance. The candidate artifact is filtered for noise, drift, and ownership; raw renders remain
in the run's shard artifacts.

CI invokes screenshot freshness checking with `--plan`, which is advisory. A broad regeneration
plan alone does not require `update-screenshots`; reserve that label for an intentional reference
refresh. The standalone `pnpm run check:screenshots` command reports stale references as a local
diagnostic and is not part of `pnpm run check`.

When references intentionally need updating, add `update-screenshots`. It runs the complete e2e
reference set and asks the trusted publisher to open a bot-owned PNG review PR into the source
branch. Review GitHub's image diffs, then merge the accepted references. Remove the label once the
review PR is created to avoid repeating the full refresh. A newer successful source-head run closes
stale review PRs. Do not accept unrelated drift just because CI captured it. You can also download
and commit reviewed PNGs manually. Forks and promotion PRs whose source is an integration branch
always use that manual path. Local filtering is implemented by
`scripts/lib/screenshot-scope.mts`; fixture determinism and tier selection are documented in
[`testing-strategy.md`](testing-strategy.md).
