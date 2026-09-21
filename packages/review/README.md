# @copse/review

The core of **Copse Reviewer** ([`docs/plans/copse-reviewer.md`](../../docs/plans/copse-reviewer.md)):
a reviewer that builds the code, tries to break it, and reports only what it could stand
behind. An Electron-free workspace package from its first commit (binding decision B2),
depending only on `@copse/std`, `@copse/llm` and zod, so the same core can serve a CLI, the
app and a CI action.

Phases 0 and 1 are here: the finding schema, Stage 0 (the base-versus-head build and test
delta), the isolation-backend contract and the conformance test that holds a backend to
what it declares (Phase 0); and the `copse-review` CLI with Stage 1 context, one model
under one lens with brokered tools, the ranked report and SARIF export (Phase 1).

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
- **`context.ts`** — Stage 1: the diff against the merge-base (committed plus the overlaid
  working tree), budgeted per file so a large change drops lockfiles and generated files
  first and then cuts each remaining file at a line boundary, never mid-hunk; the
  repository's `AGENTS.md` / `CLAUDE.md` / `CONTRIBUTING.md`; and a test map for the
  touched files.
- **`lenses.ts`** — a lens is a scoped brief with a step budget. Phase 1 ships the one B4
  allows: bugs and regressions. The system prompt restates the quality bar as rules.
- **`reviewer-tools.ts`** — the reviewer's tools, jailed to the head checkout:
  `read_file`, `list_dir`, `search_code`, `git_diff`; `run_command`, brokered into the
  cell and gated by the run's permission profile, with its output wrapped as external
  content and secret-scrubbed; and `report_finding`, through which every candidate
  arrives as a structured, anchored object rather than prose.
- **`stage2.ts`** — one model, one lens, over `@copse/agent`'s loop, projected live onto the
  headless contract's `turn_start … turn_end` event envelope.
- **`stage5.ts`** — merge, rank and cap: Stage 0's confirmed findings and the model's
  unverified candidates in one list, refuted dropped, executable evidence and confirmation
  rewarded, a lone unverified claim penalised, seven surfaced and the rest in the appendix.
- **`sarif.ts`** — SARIF 2.1.0 with the finding id in `partialFingerprints` and evidence,
  provenance and verdict in `properties` (B9).
- **`provider-selection.ts`** / **`cli.ts`** / **`bin/copse-review.mjs`** — the shell.
  Keys come from the environment only; remote providers get the diff with secrets
  redacted; `--provider mock` plays a scripted reviewer for harness self-tests.
- **`report-text.ts`** — the terminal projection. "Clean." is a complete answer.
- **`hostile-fixture.test.ts`** — the conformance test: a hostile repository reviewed with
  canary secrets in the orchestrator's environment. No canary may appear in any cell
  output or finding, and each capability a backend declares is checked against what the
  fixture managed to do.

## Running it on this repository

```bash
pnpm run review -- --allow-unisolated --no-model                 # Stage 0 only
pnpm run review -- --allow-unisolated --model claude-sonnet-5    # plus one model reviewer
pnpm run review -- --allow-unisolated --provider lmstudio --model qwen3-coder
pnpm run review -- --allow-unisolated --json report.json --sarif report.sarif --events turn.jsonl
pnpm run review -- --help
```

`--allow-unisolated` is the consent the trust table requires outside the app, where the
only backend is the host process. Findings are the output, never the exit code; the exit
codes are the headless contract's: `0` the reviewer looked, `1` the model turn failed, `2`
bad usage or an undetectable project, `3` execution was refused for want of consent or
isolation, `130` cancelled.

## Not yet here

Phase 2 adds lenses, clustering and the challenger (verification); Phase 3 the app card;
Phase 4 the container backend, foreign diffs and the CI action. See the plan's §Phases.
