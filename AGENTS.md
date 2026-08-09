# AGENTS.md

## Product and standard commands

`copse-panel` (branded **Copse**) is one product: an Electron desktop AI coding assistant. There is
no backend service; the main process talks directly to LLM providers. Prefer the scripts in
`package.json` (`dev`, `build`, `start`, `typecheck`, `lint`, `format:check`, `test`, `test:e2e`,
`check`) rather than inventing parallel commands.

Use Node **22.18 or newer**. The repo pins `22.18.0` in `.nvmrc`; older Node 22 releases cannot run
the native TypeScript tooling in `scripts/*.mts`. Environment setup, headless GUI notes, mock-model
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

Minimise `as` casts, never cast object literals, and do not use `eslint-disable` or
`@ts-expect-error` to hide a real error. Keep `eslint-suppressions.json` empty. Parse untrusted JSON
with a decoder (`safeJsonParse(text, decodeWithSchema(schema))`), not a type argument. An exported
type predicate requires a test in the same PR. See [`docs/type-safety.md`](docs/type-safety.md).

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

Persistent settings live in Electron's `copse-panel` `config.json`, but chat threads do **not**.
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

### Choose the lowest useful test tier

Prefer unit/component tests. Use browser geometry for deterministic renderer layout and Electron e2e
only for native sizing, Monaco, terminal, webview, or real main-process IPC. Start with the smallest
relevant set:

```bash
npm test -- thread-store
npm run oracle
npm run oracle -- --run unit
npm run oracle -- --run e2e
```

Read the oracle confidence. `LOW` exposes unmapped files and `broad` requires the full named tier; a
green subset is never a substitute for the pre-commit gate. Full guidance is in
[`docs/testing-strategy.md`](docs/testing-strategy.md).

### Use the right machine

- Prefer `npm run e2e:remote -- run --detach` while iterating when a remote-e2e host or registry is
  configured; continue editing, then use `e2e:remote -- wait <run-id>`. Use local Electron e2e for
  macOS-specific behavior or when no remote host is available. See
  [`ci-runners/README.md`](ci-runners/README.md#remote-e2e-dev-hosts-npm-run-e2eremote).
- Use a spare macOS GUI machine when validation needs the real product and a real agent: authenticated
  ACP inference, native macOS UI, GUI-only reproduction, or real-model demo recording. Follow
  [`docs/remote-agent-demo-debugging.md`](docs/remote-agent-demo-debugging.md), isolate the app profile
  and project workspace, keep at least one run visible, and pair it with focused WebdriverIO evidence.

### Let the post-edit hook do its job

`.copse/hooks.json`, `.cursor/hooks.json`, and `.claude/settings.json` run
`scripts/hook-file-check.mts` after edits. It applies Prettier and reports type-unaware ESLint issues;
do not rerun Prettier after every edit. If it rewrites a file, re-read it before editing again. The
hook does not replace type-aware lint, TypeScript, or the full gate.

### Before committing

Rebase onto the PR's current base (normally `origin/main`) before opening the PR; GitHub tests the
merged base and head, not an isolated branch tip. Run **`npm run check`** before committing. It covers
typecheck, ESLint, Prettier, dead-code detection, and unit tests. If a source file is intentionally
unlinked, add it to `ALLOWED_UNLINKED` in `scripts/check-dead-code.mts` with a reason.

For renderer UI or e2e fixture changes, also run the focused visual workflow selected by the test
oracle. Detailed local commands and screenshot ownership behavior are in
[`docs/agent-development.md#visual-validation`](docs/agent-development.md#visual-validation).

## Specialized surfaces

Conversation messages, subagent timelines, and file preview use the hand-rolled renderer in
`src/renderer/markdown/`. Before markdown or list-indent changes, read
[`src/renderer/markdown/README.md`](src/renderer/markdown/README.md); then run
`npm run build && npm run test:e2e:markdown`.
