# AGENTS.md

## Product and standard commands

`copse-panel` (branded **Copse**) is one product: an Electron desktop AI coding assistant. There is
no backend service; the main process talks directly to LLM providers. Launch it with `make run`,
which verifies Node, content-addresses dependency and build inputs, validates the complete `dist/`
outputs, and then starts the app. For everything else prefer the scripts in
`package.json` (`dev`, `build`, `start`, `typecheck`, `lint`, `format:check`, `test`, `test:e2e`,
`check:local`, `check`) rather than inventing parallel commands.

Use Node **24 or newer** and **pnpm** (via Corepack). The repo pins the Node 24 LTS
release in `.nvmrc` and `pnpm@10.34.5` via `packageManager`; both nvm and fnm read
`.nvmrc`. Installs use pnpm’s isolated
`node_modules` (package symlinks into `.pnpm`) with `package-import-method=auto`
so worktrees share store bytes on APFS. Electron’s extracted `dist/` and the
vendored gortex binary are shared under `~/.copse/cache/electron-dist/` and
`~/.copse/cache/gortex/` (worktrees symlink into those caches). Environment setup, headless GUI notes, mock-model
controls, app-state locations, and common validation commands live in
[`docs/agent-development.md`](docs/agent-development.md).

## Rules that apply before editing

### Hooks and feature packs

Any change touching agent hooks (`cursor-hooks`, `claude-hooks`, the permission-gate hook path),
loop nudges/steering, auto-continuation, or feature-pack extraction MUST follow
[`docs/plans/hooks-and-feature-packs.md`](docs/plans/hooks-and-feature-packs.md). Its decisions log is
binding. If the implementation needs to diverge, update the document in the same PR. Read its
“Execution guidance” and “Known implementation traps” before writing code.

### Type safety

Minimise `as` casts, never cast object literals, never use a dynamic key with `in` (it matches
inherited members — use `Object.hasOwn`), and do not use `eslint-disable` or
`@ts-expect-error` to hide a real error. Keep `eslint-suppressions.json` empty. Parse untrusted JSON
with a decoder (`safeJsonParse(text, decodeWithSchema(schema))`), not a type argument. Prefer a type
predicate the compiler checks — `memberOf(TUPLE)`, an annotated binding, or no annotation at all
inside `.filter()`; the hand-written ones are held shrink-only by
`scripts/type-predicate-inventory.test.ts`, and an exported one requires a test in the same PR. See
[`docs/type-safety.md`](docs/type-safety.md).

### User-visible changes require visual evidence

Any change visible in the Electron app must include a focused visual eval unless it is demonstrably
invisible (for example, pure data plumbing with unchanged DOM). This includes renderer components,
styles, markdown, tool cards, terminal/diff surfaces, screenshot fixtures, and visual copy or layout.

Add or update the smallest focused WebdriverIO browser/Electron spec that reaches the state, asserts
the relevant DOM behavior, and saves a screenshot for review. Use
`.cursor/skills/screenshot-validate/SKILL.md` for DOM/layout work and
`.cursor/skills/agent-run-eval/SKILL.md` only when the visual depends on an agent/tool loop. A build
or manual VNC inspection is not sufficient evidence. See [`docs/testing-strategy.md`](docs/testing-strategy.md)
for the tier boundary and [`docs/ui-taste.md`](docs/ui-taste.md) for appearance conventions.

### Tests must not create product backdoors

An option, field, or flag written only by tests is not configuration; it is unsupported product API.
When a test needs otherwise-unreachable state, reach it through a real product surface, make the
option genuinely supported, or inject the dependency/fixture at a boundary. Search the whole repo
for writers before deciding. See
[`docs/testing-strategy.md#tests-must-not-create-product-api`](docs/testing-strategy.md#tests-must-not-create-product-api).

### State and permissions

Every Copse store lives under one root, `~/.copse/` (`COPSE_DIR` moves the profile). General app
state lives in `user-data/config.json`; validated settings and encrypted secrets
live in `user-data/settings.json`. Chat threads live in neither store.
Threads live under `~/.copse/workspace/<projectId>/<threadId>/`; use `writeSeedConfig`
(`tests/e2e/helpers/seed-config.ts`) so test threads are routed into the native thread store. See
[`docs/thread-store-format.md`](docs/thread-store-format.md) and
[`docs/agent-development.md#app-data-and-seeded-state`](docs/agent-development.md#app-data-and-seeded-state).

Shell auto-run has a platform-specific security contract: macOS ASRT is the containment boundary;
without an OS sandbox, commands prompt rather than treating the optional classifier as authority.
External reads use a narrow, thread-scoped, fail-closed grant. Read
[`docs/shell-permissions.md`](docs/shell-permissions.md) before changing permission policy, shell
scope analysis, sandboxing, escalation, or approval copy.

## Validation workflow

Record the task's observable acceptance criteria before editing, and hand off exact validation
results plus remaining gaps. Use the short
[task brief and completion evidence](docs/agent-development.md#task-brief-and-completion-evidence)
convention and the PR template; a related implementation alone does not close an owning issue.

### Choose the lowest useful test tier

Prefer unit/component tests. Use browser geometry for deterministic renderer layout and Electron e2e
only for native sizing, Monaco, terminal, webview, or real main-process IPC. Start with the smallest
relevant set:

```bash
pnpm test -- thread-store
pnpm run oracle
pnpm run oracle -- --run unit
pnpm run oracle -- --run e2e
```

Read the oracle confidence. `LOW` exposes unmapped files and `broad` requires the full named tier;
`HIGH` is eligible for the risk-based local fast path only when every condition below also holds.
Full guidance is in
[`docs/testing-strategy.md`](docs/testing-strategy.md).

### Use the right machine

- Prefer `pnpm run e2e:remote -- run --detach` while iterating when a remote-e2e host or registry is
  configured; continue editing, then use `e2e:remote -- wait <run-id>`. Use local Electron e2e for
  macOS-specific behavior or when no remote host is available. See
  [`ci-runners/README.md`](ci-runners/README.md#remote-e2e-dev-hosts-npm-run-e2eremote).
- Electron e2e runs without a visible window by default: Chromium headless on macOS/Windows and an
  isolated Xvfb on Linux, where Electron still requires a display driver. Set `COPSE_E2E_HEADLESS=0`
  for an intentionally visible debugging run when a real display is available.
- Use a spare macOS GUI machine when validation needs the real product and a real agent: authenticated
  ACP inference, native macOS UI, GUI-only reproduction, or real-model demo recording. Follow
  [`docs/remote-agent-demo-debugging.md`](docs/remote-agent-demo-debugging.md), isolate the app profile
  and project workspace, keep at least one run visible, and pair it with focused WebdriverIO evidence.

### Let the post-edit hook do its job

`.copse/hooks.json`, `.cursor/hooks.json`, and `.claude/settings.json` run
`scripts/hook-file-check.mts` after edits. It applies oxfmt and reports type-unaware ESLint issues;
do not rerun the formatter after every edit. If it rewrites a file, re-read it before editing again. The
hook does not replace type-aware lint, TypeScript, or a pre-commit gate.

### Before committing

Rebase onto the PR's current base (normally `origin/main`) before opening the PR; GitHub tests the
merged base and head, not an isolated branch tip.

Run the full **`pnpm run check`** locally when any of these applies:

- the test oracle reports `LOW` confidence or `broad` coverage;
- the change affects security, sandboxing, permissions, persisted data or migrations, auth,
  secrets, billing, native runtime/IPC boundaries, agent-loop/hook control flow, dependencies or
  lockfiles, release/packaging/update controls, CI, test infrastructure, or the oracle itself;
- the diff is cross-cutting, lacks direct focused coverage, will not pass through required PR CI
  before merge, or the user explicitly requests the full gate.

For a PR-bound, low-risk change, **`pnpm run check:local` plus focused tests may replace the full
local `pnpm run check`** only when all of these are true:

- `pnpm run oracle -- --explain` reports `HIGH` confidence;
- the diff is localized and every behavioral change has direct focused test coverage;
- none of the mandatory full-check surfaces above are touched;
- required PR CI will run the repository's complete static and unit gates before merge.

The fast path still requires `pnpm run check:local`, any relevant focused tests, and any visual or
real-runtime evidence the change normally requires. In the PR's Validation section, state that the
full local suite was deferred under the low-risk fast path and name the CI gate that will run it.
When risk or coverage is ambiguous, run the full check. If a source file is intentionally unlinked,
add it to `ALLOWED_UNLINKED` in `scripts/check-dead-code.mts` with a reason.

For renderer UI or e2e fixture changes, also run the focused visual workflow selected by the test
oracle. Detailed local commands and screenshot ownership behavior are in
[`docs/agent-development.md#visual-validation`](docs/agent-development.md#visual-validation).

## Specialized surfaces

Conversation messages, subagent timelines, and file preview use `@copse/streaming-markdown`,
with app integration in `src/renderer/markdown/`. Before markdown or list-indent changes, read
[`src/renderer/markdown/README.md`](src/renderer/markdown/README.md); then run
`pnpm run build && pnpm run test:e2e:markdown`.
