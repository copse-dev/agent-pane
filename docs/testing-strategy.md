# Testing strategy

Steering for _where a test belongs_. The goal is fast, deterministic signal at
the lowest tier that can give it — and an e2e tier small enough to stay green.

## Push tests down

Default to the cheapest layer that can actually fail on the bug:

1. **Unit** (`src/**/*.test.ts`, Node's runner via `npm test`) — pure logic:
   parsers, cost/estimate math, history trimming, provider selection, store
   reducers. No DOM, no Electron. Fastest, run on every `npm run check`.
2. **Component** (happy-dom / jsdom, also `*.test.ts`; setup in
   `tests/setup-dom.ts` / `tests/setup-dom-jsdom.ts`) — mount the **real** view
   or controller, drive real events, assert DOM structure, classes, text,
   `data-*` attrs, store wiring, markdown output. The renderer is vanilla
   DOM/TS over a store, so most "does the UI do X" questions answer here without
   a browser engine. See `src/renderer/views/new-thread-keeps-panel.test.ts` for
   the canonical shape.
3. **E2E** (`tests/e2e/*.e2e.ts`, WebdriverIO + real Electron) — only the
   broad-validation and real-runtime cases below.

When a behavior is reachable from more than one tier, write it at the lower one.
A component test that mounts the real view is nearly always preferable to an e2e
spec that asserts the same DOM — it's faster, deterministic, and gets exact
import-graph selection from the oracle.

## What stays e2e

E2E is for **broad validation** and for assertions that need a real runtime.
Keep a spec at e2e only when its check requires one of:

- **Sizing / layout / geometry** — `getBoundingClientRect`, `getComputedStyle`,
  `clientWidth`, `elementFromPoint`. happy-dom/jsdom return zeroed geometry, so
  rendering and sizing regressions are genuinely only catchable here.
- **Monaco** editor (diff, selection, language workers).
- **xterm / node-pty** terminal.
- **webview / browser** panel (Electron webContents).
- **Real IPC to main** — `fs:listDir`, git status/diff, sandbox, project load.

Everything else is component- or unit-testable. The full discriminator and the
per-spec migration backlog live in
[`docs/e2e-component-migration.md`](e2e-component-migration.md) — extend that
list rather than adding e2e specs for DOM-only behavior.

> Visual changes still require a focused visual eval (see AGENTS.md → "Visual
> changes require evals"). That eval is usually a small e2e that seeds a state
> and saves a screenshot — exactly the sizing/rendering job e2e is for. Pushing
> _logic_ down doesn't waive the visual check.

## CI cost is a design input

The e2e tier is the expensive, flake-prone one (runner OOM / disk / Electron
startup, not assertion failures), so the recent refactoring trades it down — and
new tests should keep that trend:

- **Migrating a spec to a component test removes it from the flaky tier
  entirely** — strictly better than the oracle skipping it. This is the cheapest
  CI win available and the preferred way to retire a quarantined spec.
- The **test oracle** (`scripts/test-oracle.mts`) maps a PR's diff to the e2e
  specs it can affect and runs only those (`subset`), falling back to `full`
  for broad/low-confidence changes; the nightly schedule runs everything. Keep
  selector/DOM coupling honest so the oracle can confidently subset — and keep
  the oracle liveness gate (`npm run check:oracle`) passing.
- The **cheap static gate** (`lint`/typecheck/format/dead-code) short-circuits
  the pipeline before any build or e2e shard burns minutes. Put fast, broad
  checks here.
- Don't reintroduce per-spec rebuilds or hosted-runner e2e for ordinary
  changes; the shared `dist` artifact + self-hosted PR/push runners exist to
  avoid that cost.

Net: every new e2e spec should justify why it can't be a component test. The
default direction is _down_.

## Self-hosted runners and on-machine LLM eval

Cost-cutting must **not** close the local-model path. The self-hosted fleet is
also where we can run real on-machine LLM evals against **LM Studio** — agent
loops driven by an actual local model rather than the mock:

- `wdio.eval.conf.ts` / `npm run test:e2e:agent-eval` drive real local-model
  agent evals (`tests/e2e/agent-eval-drive.e2e.ts`), reading `LM_STUDIO_API_KEY`
  / `LM_API_TOKEN` and talking to a local OpenAI-compatible endpoint
  (`createLMStudioProvider`, default `http://localhost:1234/v1`).
- `npm run validate:local-agent` exercises the agent loop headlessly.

These are deliberately **out of the per-PR critical path** (they need a model
host and are slow/non-deterministic), but they remain a supported avenue: a
self-hosted runner with LM Studio installed is a valid home for them — nightly,
on-demand, or label-gated. Keep the seams (provider abstraction, `COPSE_AGENT_EVAL`,
the eval config) intact so this stays runnable as the rest of CI gets leaner.

## Deterministic screenshots

Committed reference screenshots (`tests/e2e/screenshots/*.png`) are regenerated
from e2e runs and diffed in review. They must depend **only on seeded fixtures**,
never on the live machine, repo, or clock — otherwise an unrelated PR (a lint
sweep, a dependency bump) re-renders them and every PR carries spurious PNG
churn. A change to a committed screenshot should always trace back to a UI
change, not to which branch the PR was built from.

Rules for anything that lands in a captured frame:

- **Git branch.** The app reads the live checkout for the footer branch-status
  and branch-picker. Under e2e the main process reports a fixed branch instead,
  via `COPSE_PANEL_MOCK_BRANCH` (default [`E2E_GIT_BRANCH`](../tests/e2e/helpers/e2e-env.ts),
  set in `wdio.conf.ts` `beforeSession`). The override is honored in
  `git-service.ts` (`getCurrentBranchName`, `getBranches`) and flows through
  `pr-context-service.ts` `getGitBranchStatus`. Fixtures that bind a thread to a
  branch must use `e2eGitBranch()` — never `git rev-parse` — so the seeded
  branch matches the one the footer renders.
- **Live `gh` / PR data.** `checkToolAvailability` forces `gh` unavailable under
  `COPSE_E2E`, so `getGitBranchStatus` never embeds a real PR number/title.
  Keep it that way; route any new PR-derived UI through the `COPSE_PANEL_MOCK_GH`
  fixtures (`gh-pr-mock.ts`), not real `gh`.
- **Clocks, versions, hosts, absolute paths.** Don't render `new Date()`,
  relative time ("2m ago"), app/Electron/Node versions, hostname/username, or
  home-dir paths in a captured view. Seed timestamps to fixed values; show
  workspace-relative paths.
- **Randomness.** No `Math.random()` / `randomUUID()` in rendered output. Derive
  visible ids/order from fixture data.

When you add an e2e screenshot, ask: *if I rebuild this on a different branch,
on a different day, on a different machine — does any pixel move?* If yes, pin
the source through a fixture or an e2e env override before committing the PNG.

## Quick rule of thumb

| Question the test answers              | Tier             |
| -------------------------------------- | ---------------- |
| Pure logic / data transform            | unit             |
| "Does the view render / wire up X?"    | component        |
| Sizing, computed style, real geometry  | e2e              |
| Monaco / terminal / webview / main IPC | e2e              |
| Does a real local model drive the loop | local-model eval |
