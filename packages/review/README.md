# @copse/review

The core of **Copse Reviewer** ([`docs/plans/copse-reviewer.md`](../../docs/plans/copse-reviewer.md)):
a reviewer that builds the code, tries to break it, and reports only what it could stand
behind. An Electron-free workspace package from its first commit (binding decision B2),
depending only on `@copse/std`, `@copse/llm` and zod, so the same core can serve a CLI, the
app and a CI action.

This is **Phase 0**: the finding schema, Stage 0 (the base-versus-head build and test
delta), the isolation-backend contract, and the conformance test that holds a backend to
what it declares. No model is called anywhere in this package yet.

## What's in it

- **`finding.ts`** — the unit of output. A `Finding` is a structured, addressable,
  evidenced claim about a line range: content-derived `id` (survives a rebase),
  `anchor`, one falsifiable `claim`, a `class` from the B4 list (`build`, `type`, `test`,
  `contract`, `security`, `concurrency`, `resource`, `api-compat`), `severity` and
  `confidence` separately, `provenance`, `evidence` (a command with its exit code and
  excerpt, a reproducer, or a citation) and a `verdict`. Zod schemas; `decodeFinding` is
  the boundary for a findings file.
- **`isolation.ts`** — `IsolationBackend` / `ExecutionCell`: the two privilege domains of
  B1. A backend declares its `strength` (`none` / `os-sandbox` / `container`) and its
  capabilities; `decideExecution` is the trust × isolation table (an own diff runs behind
  any isolation, or unisolated only with per-run consent; a foreign diff runs in a
  container or not at all — B3). `cellEnvironment` builds the allowlisted environment a
  cell receives; `droppedHostSecrets` feeds everything it dropped to the redactor.
- **`host-process-backend.ts`** — the weakest backend: the host process with a scrubbed
  environment and a `HOME`/`TMPDIR` inside the cell. It builds no filesystem or network
  wall and says so, which is what limits it to consented own-tree runs. The app's
  OS-sandbox backend (`src/main/services/review/os-sandbox-backend.ts`) is the first real
  one.
- **`checkouts.ts`** — materialises the merge-base and head as detached worktrees under
  the review's scratch directory, with the working tree's uncommitted changes overlaid on
  head. Git runs on the host with hooks disabled; nothing from a checkout is executed
  here.
- **`project-commands.ts`** — detects `build` / `typecheck` / `lint` / `test` for a
  TypeScript + pnpm repository (B5), overridable per repo by a `review.config.json`
  (argv per command, `null` to disable, timeouts). The default `prepare` is
  `pnpm install --frozen-lockfile --offline --ignore-scripts`, resolved from the host's
  pnpm store and corepack cache, both mounted read-only; corepack is pinned offline.
- **`stage0.ts`** — runs the checks on head, then on base for whatever failed on head,
  and turns the delta into findings: a `tsc` regression becomes one finding per new
  diagnostic anchored at its line; a build or test regression becomes one finding
  anchored at the script in `package.json`. A lint regression is a failed check, never a
  finding (B4). Every output is size-capped and secret-scrubbed before it is kept, and
  the report always says what was not checked and why.
- **`report-text.ts`** — the terminal projection. "Clean." is a complete answer.
- **`hostile-fixture.test.ts`** — the conformance test: a hostile repository reviewed with
  canary secrets in the orchestrator's environment. No canary may appear in any cell
  output or finding, and each capability a backend declares is checked against what the
  fixture managed to do.

## Running it on this repository

```bash
pnpm run review:stage0 -- --allow-unisolated          # text
pnpm run review:stage0 -- --allow-unisolated --json   # the full report
```

`--allow-unisolated` is the consent the trust table requires outside the app, where the
only backend is the host process. The exit code is advisory: `0` when the reviewer looked
(findings or not), `2` when it did not execute or could not detect the project.

## Not yet here

Phase 1 adds the `copse review` CLI shell, a single model reviewer and SARIF export;
Phase 2 the lenses, clustering and the challenger; Phase 3 the app card; Phase 4 the
container backend, foreign diffs and the CI action. See the plan's §Phases.
