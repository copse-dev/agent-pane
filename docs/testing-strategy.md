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
3. **Browser geometry** (`tests/demo/*.demo.ts`, WebdriverIO + plain Chrome) — real layout and
   computed styles over deterministic in-memory state, without Electron lifecycle cost.
4. **E2E** (`tests/e2e/*.e2e.ts`, WebdriverIO + real Electron) — only the
   broad-validation and real-runtime cases below.

When a behavior is reachable from more than one tier, write it at the lower one.
A component test that mounts the real view is nearly always preferable to an e2e
spec that asserts the same DOM — it's faster, deterministic, and gets exact
import-graph selection from the oracle.

## Run the smallest set of tests

Steering for _how much to run, and when_. A full `npm test` is ~3 minutes over
530 files; the tests that can actually fail on a given change are usually a
handful. Running the whole suite after every edit is the slow way to be wrong
about the same three assertions.

The loop, cheapest first:

| When                              | Run                                          | Cost           |
| --------------------------------- | -------------------------------------------- | -------------- |
| After each edit                   | _nothing_ — the hook formatted and linted it | ~2s, automatic |
| While iterating on one module     | `npm test -- <filter>`                       | seconds        |
| Before you believe a change works | `npm run oracle -- --run unit`               | seconds–1 min  |
| Before commit / PR                | `npm run check`                              | minutes        |

### After an edit: the hook already ran

`.copse/hooks.json`, `.cursor/hooks.json` and `.claude/settings.json` wire
`scripts/hook-file-check.mts` to the post-edit hook, so **every file you edit is
already reformatted and lint-checked** before you read the tool result. Don't
spend a turn running Prettier on a file you just touched — and if the hook said
nothing at all, it is clean.

**Prettier is auto-applied; ESLint is not.** Formatting is deterministic and
semantically neutral, so fixing it costs an agent turn and buys nothing —
`afterFileEdit` is the formatter event, and `after-file-edit.ts` awaits blocking
hooks precisely so a formatter lands before the agent proceeds. `eslint --fix`
is a different animal: it makes real code changes (`prefer-const`, import
rewrites), so those are reported with the command to run rather than applied
behind you.

A rewrite is **always** reported, even when there is nothing else to say, because
it makes your copy of the file stale — a later edit matching against remembered
text would fail against content you never saw. Re-read the file when you see it.

Coverage is a fast subset by construction: Prettier plus the **type-unaware**
ESLint rules (`eslint.hook.config.mjs`). Type-aware rules and `tsc` need the whole
TypeScript program — ~10s for a single file — which is too slow to run per edit,
so they stay in `npm run check`. The hook says so in its own output; treat a
silent hook as "no cheap problems", never as "verified".

### While iterating: `npm test -- <filter>`

Positional args filter the suite. A filter matches a path substring, a base name
(with or without `.test.ts`), or a glob:

```bash
npm test -- thread-store             # any path containing "thread-store"
npm test -- tool-display copse-adapter   # several filters union
npm test -- 'src/main/services/hooks/**'  # glob
```

A filter that matches nothing is an **error**, not an empty pass — otherwise a
typo reads as "0 tests, all green". The runner prints what it selected and
suggests near misses.

### Before believing it works: the oracle

The [test oracle](../scripts/test-oracle.mts) maps your diff to the tests that
can reach it — unit tests through the import graph (exact), e2e specs through
their selector vocabulary (heuristic):

```bash
npm run oracle                  # what would you run, and how confident is it?
npm run oracle -- --explain     # …and why each test was picked
npm run oracle -- --run unit    # run the recommended unit subset
npm run oracle -- --run e2e     # run the recommended e2e subset
```

Read the **confidence line** before trusting the subset:

- **HIGH** — every changed file mapped to a test. The subset is the answer.
- **LOW** — some changed source has no importing test and no selector match.
  The subset can't cover it; the listed unmapped files are your blind spot.
- **broad** — a cross-cutting file changed (build scripts, store, preload,
  `index.html`). The oracle recommends everything, and means it.

The oracle deliberately refuses to shrink below what it can back up: an empty
selection runs the **full** suite rather than reporting a green on zero tests.

### When a subset is not enough

A subset is a fast filter, never the gate. Run the full `npm run check` before
committing, and don't substitute a green subset for it — the oracle only knows
imports and selectors, so a change reached through dynamic dispatch, a string
key, or an IPC channel name is invisible to it. On a **LOW** or **broad**
verdict, run the full tier the oracle names rather than the subset it offers.

## What stays e2e

E2E is for **broad validation** and for assertions that need a real runtime.
Keep a spec at e2e only when its check requires one of:

- **Sizing / layout / geometry that depends on Electron** — native window chrome,
  Electron-only elements, or geometry derived from real main/preload state. Plain deterministic
  renderer geometry belongs in the browser tier because happy-dom/jsdom return zeroed geometry.
- **Monaco** editor (diff, selection, language workers).
- **xterm / node-pty** terminal.
- **webview / browser** panel (Electron webContents).
- **Real IPC to main** — `fs:listDir`, git status/diff, sandbox, project load.

Everything else is component- or unit-testable. The full discriminator and the
per-spec migration backlog live in
[`docs/e2e-component-migration.md`](e2e-component-migration.md) — extend that
list rather than adding e2e specs for DOM-only behavior.

> Visual changes still require a focused visual eval (see AGENTS.md → "Visual
> changes require evals"). That eval is usually a small browser or Electron spec that seeds a state
> and saves a screenshot — exactly the sizing/rendering job those tiers are for. Pushing
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
- The same oracle call also emits a **unit plan** (`unit_mode` / `unit_specs`),
  which the `check` job applies **only to a PR stacked on another PR's branch**.
  Such a layer cannot merge — the layer below has to land first, and when it
  does the PR is retargeted at trunk and re-runs the whole suite under the
  coverage ratchet. So the run that actually gates a merge is never a thinned
  one. Two properties keep this honest, and both are pinned by
  `npm run check:oracle`:
  - **An empty selection means `full`, never `skip`.** A fixture, JSON snapshot
    or config a test _reads_ is invisible to the import graph, so "no unit test
    selected" is evidence of a blind spot, not of safety. Only a docs-only diff
    skips outright.
  - **`subset` skips the coverage ratchet**, because a partial run's coverage
    number isn't comparable to `coverage-baseline.json`. The trunk-targeted run
    is where the ratchet applies.
- **Remote e2e for the local loop** (`npm run e2e:remote`) runs the same
  oracle-selected / CI-shaped suite on a cloud container from the working tree
  so agents and humans can keep iterating. Prefer it over local `test:e2e`
  while iterating when a host or `COPSE_CI_REGISTRY` is available (see
  [`ci-runners/README.md`](../ci-runners/README.md#remote-e2e-dev-hosts-npm-run-e2eremote)).
  Local `test:e2e` stays for macOS-specific behaviour and machines without cloud
  access.
- Don't reintroduce per-spec rebuilds or hosted-runner e2e for ordinary
  changes; the shared `dist` artifact + self-hosted PR/push runners exist to
  avoid that cost.

Net: every new e2e spec should justify why it can't be a component test. The
default direction is _down_.

## Browser geometry tier

`npm run build:demo && npm run test:demo` is the focused browser-hosted tier from
[`docs/spikes/demo-browser-tier.md`](spikes/demo-browser-tier.md). It runs the unchanged renderer
against an in-memory `ApiClient` in ordinary headless Chrome, so geometry/computed-style checks that
do not need Electron can be evaluated without main-process or window lifecycle cost.

The same build also carries the `landing` walkthrough — a recorded turn replayed through the real
chunk path, embedded as the marketing homepage hero. See
[`docs/demo-walkthrough.md`](demo-walkthrough.md) for how to record and swap a trace.

CI runs it from the existing build job and collects its reference screenshots alongside Electron
screenshots. After the initial `footer-compact` / `markdown-list-indent` soak, the next focused batch
moved deterministic subagent, settings-footer, and chat-layout rendering into this tier. Continue
to move specs in measured batches rather than treating every screenshot as browser-portable. The
tier boundary is:

| Question the test answers                              | Tier           |
| ------------------------------------------------------ | -------------- |
| Sizing/geometry over a deterministic mocked backend    | demo (browser) |
| Monaco / terminal / webview / native window / main IPC | e2e (Electron) |

## Testing ACP without a model key

Copse implements **both ends** of [ACP](acp-agents.md): the **client** role
(`acp-client.ts`, driving someone else's agent) and the **agent** role
(`acp-agent-server.ts` / `acp-app-entry.ts`, exposing Copse's own loop to someone
else's editor). None of that needs e2e, an installed agent binary, or an API key —
it all lives in the unit tier and runs on every PR.

Three shapes, cheapest first:

1. **Protocol loopback** (`acp-loopback.test.ts`, `acp-cancel.test.ts`,
   `acp-session-pool.test.ts`, …) — the agent role and the client role wired
   together through two in-memory byte pipes over real ndjson framing, injected
   via the pool's `createTransport` seam. The turn runner is a stub, so these pin
   _protocol_ behaviour: cancel and its grace window, resume, idle updates, mode
   and model selection, permission cancellation.
2. **Full stack on a mock model** (`acp-app-entry.test.ts`) — the same loopback,
   but the far end is the real `createAcpTurnRunner`, driving the real `runAgent`
   over a real `ToolRegistry` and the real approval plumbing. The only fake is the
   model: a `MockLLMProvider` passed through `runAgent`'s `provider` option (the
   same seam the headless host and the bench harness use), steered into a named
   tool call with the `[[mcp:<tool> {args}]]` directive. This is the tier that
   proves an ACP client gets _Copse's agent_ rather than a protocol echo — a turn
   crosses client → ndjson → agent role → agent loop → tool → `requestApproval` →
   back out as `session/request_permission` → client answer → tool result →
   chunks.
3. **A real subprocess** (`acp-spawn.test.ts`, driving
   `tests/fixtures/mock-acp-agent.mjs`) — the client spawning an actual child over
   stdio. The loopbacks step over the process boundary, so this is the only tier
   that reaches `spawnAcpAgentProcess`, the stdout→ndjson reader, the stderr tail
   and the exit-error path. The fixture is an independent implementation over the
   bare SDK, not Copse's own agent role, so the client is also exercised against
   an agent that shares none of its assumptions.

Pick the lowest one that can fail on the change, same as everywhere else: protocol
edge cases at (1), anything about what the agent actually _does_ at (2), and only
process lifecycle at (3).

What genuinely needs a real agent stays out of the PR path by design: the
`probe:acp*` scripts ([capability probe](acp-capability-probe.md)) measure what an
installed adapter actually negotiates, per adapter version. That is not knowable
from the spec and not fakeable — a mock can only tell you what we already believe.

## Self-hosted runners and on-machine LLM eval

Cost-cutting must **not** close the local-model path. The self-hosted fleet is
also where we can run real on-machine LLM evals against **LM Studio** — agent
loops driven by an actual local model rather than the mock:

- `wdio.eval.conf.ts` / `npm run test:e2e:agent-eval` drive real local-model
  agent evals (`tests/e2e/agent-eval-drive.e2e.ts`), reading `LM_STUDIO_API_KEY`
  / `LM_API_TOKEN` and talking to a local OpenAI-compatible endpoint
  (`createLMStudioProvider`, default `http://localhost:1234/v1`).
- `npm run validate:local-agent` exercises the agent loop headlessly.
- `npm run eval:doctrine -- --provider lmstudio --repeats 3 --sections tools`
  holds a fixed task/model/tool set constant and compares the full system prompt
  with one named section omitted. It writes solve-rate, doctrine-pass-rate,
  per-rule, and token deltas under `bench-results/doctrine/`. CI runs its mock
  smoke arm in the normal bench job; the real model matrix runs nightly or with
  the `bench-doctrine` label when `LM_EVAL_RUNNER` is configured.

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

When you add an e2e screenshot, ask: _if I rebuild this on a different branch,
on a different day, on a different machine — does any pixel move?_ If yes, pin
the source through a fixture or an e2e env override before committing the PNG.

CI's `commit-screenshots` job auto-commits re-rendered shots **only when the
write is uncontested**: the baseline is brand new or inherited untouched from
main. A shot deliberately committed on the PR branch (by any non-bot author),
or one main has changed since the merge-base, is never overridden — the
branch's committed version stands, and the PR comment shows a base-vs-branch
comparison instead. Add the `update-screenshots` label to explicitly regenerate
and take CI's render (`scripts/filter-screenshots.mts` implements the policy).

## Where each tier runs: `main` and `release`

`main` is the default branch and the integration target. `release` only ever
receives promotion PRs from `main`, so it stays in a state a release can be
cut from.

| Event                                     | Tier                                          |
| ----------------------------------------- | --------------------------------------------- |
| PR into `main` (the normal case)          | light — precheck, check, build (no e2e/bench) |
| Push to `main` (a merge landed)           | light                                         |
| PR from `main` into `release` (promotion) | **full** — adds e2e (8 shards) and bench      |
| Push to `release` (a promotion landed)    | **full**                                      |
| Nightly `schedule`, release tags          | **full**, on GitHub-hosted runners            |

The point is that e2e and bench are paid once per _promotion_ rather than once
per PR. At ~20 merges a day that is the difference between ~20 heavy runs and a
handful.

Two escape hatches on a `main`-targeted PR, both labels:

- `ci-full` — run the whole heavy tier now, for a change that genuinely needs
  the signal before it merges (also forces the tier on a draft).
- `update-screenshots` — run e2e specifically, because the screenshot commit is
  produced by the e2e run. Without this the label would be inert on a
  `main` PR.

**What this costs.** GitHub's merge queue would bisect a failing batch
automatically; a red promotion names a batch, not a commit. Keep promotions
frequent enough that the batch stays small, and read the failing e2e spec name
first — it usually identifies its own owner. There is no merge queue to fall
back on: it requires GitHub Enterprise Cloud for private repositories and this
org is on Team.

**Hotfixes.** A commit pushed straight to `release` must be merged back into
`main` immediately, or the branches drift and the next promotion carries a
spurious conflict.

## Quick rule of thumb

| Question the test answers              | Tier              |
| -------------------------------------- | ----------------- |
| Pure logic / data transform            | unit              |
| "Does the view render / wire up X?"    | component         |
| Sizing, computed style, real geometry  | browser geometry  |
| Monaco / terminal / webview / main IPC | e2e               |
| Either end of ACP, incl. the real loop | unit (mock model) |
| Does a real local model drive the loop | local-model eval  |
