# AGENTS.md

`copse-panel` (branded **Copse**) is an Electron desktop AI coding assistant. There is no backend
service; the main process talks directly to LLM providers. This file is the short list of binding
rules. The linked docs hold the detail: read the relevant one before working in that area.

## Commands and environment

- Node **24+** (`.nvmrc`) and **pnpm** via Corepack (`packageManager`). Use the `package.json`
  scripts (`dev`, `build`, `start`, `typecheck`, `lint`, `format:check`, `test`, `test:e2e`,
  `check:local`, `check`) rather than inventing parallel commands.
- `make run` is for a human terminal. An agent inside Copse builds with `make build` and opens the
  branch through `launch_gui_app` with an isolated `COPSE_DIR`
  ([how](docs/agent-development.md#launching-copse-from-a-copse-agent-session)).
- Install layout, shared caches, headless GUI, mock models, app state, choosing a machine and
  validation commands: [`docs/agent-development.md`](docs/agent-development.md).

## Rules that apply before editing

- **Hooks and feature packs.** Changes to agent hooks (`cursor-hooks`, `claude-hooks`, the
  permission-gate hook path), loop nudges/steering, auto-continuation or feature-pack extraction
  MUST follow [`docs/plans/hooks-and-feature-packs.md`](docs/plans/hooks-and-feature-packs.md). Its
  decisions log is binding; update it in the same PR to diverge. Read its "Execution guidance" and
  "Known implementation traps" first.
- **Type safety.** Minimise `as`; never cast object literals; never use `in` with a dynamic key
  (use `Object.hasOwn`); never hide a real error with `eslint-disable` or `@ts-expect-error`; keep
  `eslint-suppressions.json` empty; parse untrusted JSON with
  `safeJsonParse(text, decodeWithSchema(schema))`. Hand-written type predicates are shrink-only and
  an exported one needs a test. See [`docs/type-safety.md`](docs/type-safety.md).
- **Visible changes need visual evidence.** Unless a change is demonstrably invisible (renderer
  components, styles, markdown, tool cards, terminal/diff surfaces, screenshot fixtures, visual copy
  and layout all count as visible), add the smallest focused WebdriverIO spec that reaches the state,
  asserts the DOM and saves a screenshot.
  A build or VNC look is not evidence. Use `.agents/skills/screenshot-validate/`,
  `.agents/skills/agent-run-eval/` (only when the visual needs an agent loop) and
  [`pr-screenshot-review`](.agents/skills/pr-screenshot-review/SKILL.md) for baselines. See
  [`docs/testing-strategy.md`](docs/testing-strategy.md) (tiers and
  [PR stacks](docs/testing-strategy.md#reviewing-a-small-pr-stack-once)) and
  [`docs/ui-taste.md`](docs/ui-taste.md).
- **No test-only product API.** An option, field or flag only tests write is unsupported product
  API. Use a real surface, make the option supported, or inject at a boundary; search the whole repo
  for writers first ([why](docs/testing-strategy.md#tests-must-not-create-product-api)).
- **State.** Every store lives under `~/.copse/` (`COPSE_DIR` moves it). Threads live under
  `workspace/<projectId>/<threadId>/`; seed them with `writeSeedConfig`. See
  [`docs/thread-store-format.md`](docs/thread-store-format.md) and
  [app data](docs/agent-development.md#app-data-and-seeded-state).
- **Shell permissions.** macOS ASRT is the containment boundary; without an OS sandbox, commands
  prompt. Read [`docs/shell-permissions.md`](docs/shell-permissions.md) before changing permission
  policy, scope analysis, sandboxing, escalation or approval copy.
- **Markdown.** Read [`src/renderer/markdown/README.md`](src/renderer/markdown/README.md) before
  markdown or list-indent changes, then run `pnpm run build && pnpm run test:e2e:markdown`.

## Validation workflow

Record observable acceptance criteria before editing; hand off exact results and remaining gaps
([convention](docs/agent-development.md#task-brief-and-completion-evidence)). A related
implementation alone does not close an owning issue. Use the lowest useful tier, starting with
`pnpm test -- <name>` and `pnpm run oracle`, and read its confidence. The post-edit hook formats and
runs type-unaware ESLint; re-read any file it rewrites.

### Before committing

Rebase onto the PR's base (normally `origin/main`). Run the full **`pnpm run check`** when:

- the oracle reports `LOW` confidence or `broad` coverage;
- the change touches security, sandboxing, permissions, persisted data or migrations, auth,
  secrets, billing, native runtime/IPC boundaries, agent-loop/hook control flow, dependencies or
  lockfiles, release/packaging/update controls, CI, test infrastructure or the oracle;
- the diff is cross-cutting, lacks direct focused coverage, will not pass required PR CI before
  merge, or the user asks.

Otherwise `pnpm run check:local` plus focused tests may replace it, only when
`pnpm run oracle -- --explain` reports `HIGH`, every behavioural change has direct coverage, and
required PR CI runs the full static and unit gates. Visual and real-runtime evidence are still
required. Say so in the PR's Validation section and name that gate. When in doubt, run the full
check. List an intentionally unlinked file in
`ALLOWED_UNLINKED` (`scripts/check-dead-code.mts`) with a reason.
