# @copse/review

The core of **Copse Reviewer** ([`docs/plans/copse-reviewer.md`](../../docs/plans/copse-reviewer.md)):
a reviewer that builds the code, tries to break it, and reports only what it could stand
behind. An Electron-free workspace package from its first commit (binding decision B2),
depending only on `@copse/std`, `@copse/llm` and zod, so the same core can serve a CLI, the
app and a CI action.

Phases 0 to 2 and the core of Phase 4 are here: the finding schema, Stage 0 (the
base-versus-head build and test delta), the isolation-backend contract and the conformance
test that holds a backend to what it declares (Phase 0); the `copse-review` CLI with Stage 1
context, brokered tools, the ranked report and SARIF export (Phase 1); the fan-out over
models and lenses, Stage 3 clustering, and Stage 4 verification by reproducer and
adversarial challenge (Phase 2); and the container backend, foreign-diff review and the CI
shell's hand-offs (Phase 4).

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
  one. `createEphemeralRunnerBackend` is the same cell declared at container strength, for
  the one place that is true — a secret-free CI runner created for one job — and only ever
  chosen by an explicit `--backend ephemeral-runner`.
- **`container-backend.ts`** — the strength a foreign diff needs (B3): every cell command
  in its own throwaway Docker or Podman container from a pinned image, never pulled, with
  the thread-in-container runtime's hardening (read-only root, all capabilities dropped,
  no new privileges, pid / memory / cpu limits, an exec-able private `/tmp`) and no network
  interface. Checkouts and scratch are bind-mounted read-write at their host paths, the
  declared read-only paths read-only at theirs; the host `PATH` gives way to the image's;
  containers are created before starting, with the requested executable as their entrypoint,
  so cancelling during creation cannot start a command after cleanup. `<engine> rm --force`
  ends a timed-out command with everything it forked. `containerCreateArgs` is
  pure and pinned by a test; `detectContainerBackend` says why there is no backend rather
  than guessing.
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
  first and then cuts retained files at a line boundary within a strict total cap; the
  repository's `AGENTS.md` / `CLAUDE.md` / `CONTRIBUTING.md`; and a test map for the
  touched files.
- **`lenses.ts`** — a lens is a scoped brief with a step budget: `correctness` (the default),
  `contracts`, `tests`, `security`, `concurrency`; `--lenses all` runs every one. All stay
  inside B4. The system prompt restates the quality bar as rules.
- **`reviewer-tools.ts`** — the reviewer's tools, jailed to the head checkout:
  `read_file`, `list_dir`, `search_code` (without following checkout symlinks), and
  `git_diff` (complete per-file diffs paged by character offset); `run_command`, brokered into the
  cell and gated by the run's permission profile, with its output wrapped as external
  content and secret-scrubbed; and `report_finding`, through which every candidate
  arrives as a structured, anchored object rather than prose.
- **`turn.ts`** / **`stage2.ts`** — one model turn over `@copse/agent`'s loop, projected live
  onto the headless contract's `turn_start … turn_end` event envelope; `runReviewers` fans
  out every model over every lens, a few at a time, over one serialised cell.
- **`cluster.ts`** — Stage 3: two candidates are one finding when their anchors overlap
  (with a few lines of slack) and their claims share enough content words. The first keeps
  its identity; the rest corroborate it. Thresholds are exported for `bench:review` to tune.
- **`verifier-tools.ts`** / **`stage4.ts`** — Stage 4: for the classes a test can demonstrate,
  a reproducer model writes one test under `.copse-review/` and names how to run it; it is
  run on head and on base, and confirms the finding only when it fails on head and passes on
  base. Everything still open goes to the challenger, whose brief is to refute the finding
  with the burden of proof on the claim; `refuted` drops it, `stands` records the survived
  challenge. Most promising findings first, up to `--max-verify`.
- **`stage5.ts`** — rank and cap: confirmed findings, survivors and unverified candidates in
  one list, refuted reported separately, executable evidence, confirmation and a survived
  challenge rewarded, a lone unverified claim penalised, seven surfaced and the rest in the
  appendix.
- **`sarif.ts`** — SARIF 2.1.0 with the finding id in `partialFingerprints` and evidence,
  provenance and verdict in `properties` (B9).
- **`provider-selection.ts`** / **`cli.ts`** / **`bin/copse-review.mjs`** — the shell.
  Keys come from the environment only; remote providers get the diff with secrets
  redacted; `--provider mock` plays a scripted reviewer for harness self-tests.
- **`report-text.ts`** — the terminal projection. "Clean." is a complete answer.
- **`stage0-report.ts`** — the Stage 0 report as a decoder, for the file the CI shell's
  secret-free job hands to the job with the model key: untrusted input, validated shape by
  shape (findings included) before a field of it reaches a model or a comment.
- **`forge-review.ts`** — the pull-request projection: one review (`COMMENT`, never a
  request for changes), each surfaced finding with a line an inline comment on the head
  commit, the rest in the body. GitHub and Forgejo; a line the forge refuses is folded
  into the body rather than lost.
- **`eval.ts`** — the measurement (P6, B8): a case's known defects as anchors, a finding
  matched to a defect the way Stage 3 clusters (same path, overlapping lines within the
  slack) or by the Stage 0 regression it declares, and the metrics — precision on surfaced
  findings first, recall second, the reproducer rate and tokens per confirmed finding.
  `pnpm run bench:review` (`scripts/bench-review-lib.mts`, corpus and baseline under
  `benchmarks/review/`) is the harness over it.
- **`hostile-fixture.test.ts`** — the conformance test: a hostile repository reviewed with
  canary secrets in the orchestrator's environment. No canary may appear in any cell
  output or finding, and each capability a backend declares is checked against what the
  fixture managed to do. The container backend joins it with
  `COPSE_REVIEW_CONTAINER_E2E=1` (a daemon and the image, `COPSE_REVIEW_IMAGE` to name
  another, required); the unit tier covers its plumbing over a fake engine.

## Running it on this repository

```bash
pnpm run review --allow-unisolated --no-model                 # Stage 0 only
pnpm run review --allow-unisolated --model claude-sonnet-5    # plus one model reviewer
pnpm run review --allow-unisolated --provider lmstudio --model qwen3-coder
pnpm run review --allow-unisolated --model claude-sonnet-5 --model gpt-5 --lenses all
pnpm run review --allow-unisolated --model qwen3-coder --challenger claude-sonnet-5
pnpm run review --allow-unisolated --json report.json --sarif report.sarif --events turns.jsonl
pnpm run review --help
```

`--allow-unisolated` is the consent the trust table requires for your own tree when no
container answers. Findings are the output, never the exit code; the exit codes are the
headless contract's: `0` the reviewer looked, `1` the model turn failed or the review
could not be posted, `2` bad usage or an undetectable project, `3` execution was refused
for want of consent or isolation, `130` cancelled.

## Reviewing a contributor's branch

```bash
git fetch origin refs/pull/123/head:refs/remotes/pr/123
pnpm run review --foreign --head refs/remotes/pr/123 --base origin/main --model claude-sonnet-5
pnpm run review --foreign --head refs/remotes/pr/123 --backend container --image copse-worker:local
```

`--foreign` says the change is not yours: it executes only in a container (B3), which
`auto` looks for by image — the app's worker image by default, built by the first
container run in Copse — and, finding none, the pipeline reviews read-only (the reviewers
and the challenger over the checkouts, no `run_command`) and says so with exit `3`.
`--allow-unisolated` is not consent for a foreign diff.

## In CI

The plan's job A and job B (`.github/workflows/review-ground.yml` and
`review-findings.yml`; `.forgejo/workflows/review.yml` for Forgejo) are opt-in by the
`copse-review` label on a pull request. On GitHub, `review-trigger.yml` receives the
`pull_request_target:labeled` event so an older pull request still selects trusted default-branch
workflow code. That target-context job has PR-read and Actions-dispatch permission, but it checks
out and executes nothing; it resolves current PR metadata and dispatches the separate ground
workflow. Job A has `permissions: {}` and no secrets, runs Stage 0 on the head with the runner as
the cell (`--backend ephemeral-runner`), and uploads the report. It uses the reviewed CLI from the
default branch, so an older PR need not contain `@copse/review`; pull-request code is fetched only
after checkout credentials have been removed.
The secret-bearing findings job parses the trusted PR number from the ground run name and resolves
the current contributor commit and base from GitHub's Pull Request API, rather than trusting the
artefact or a dynamic run association. Remove and re-add the label to review a newer head.
Job B, on the base ref with the model key, imports that report (`--stage0-json`, which makes
the run read-only and refuses a report for another commit), reviews the head without
executing it, and posts one advisory review (`--post-review github --repo owner/name --pr n`).
The token is `COPSE_REVIEW_FORGE_TOKEN`, else `GITHUB_TOKEN`; the model key
`COPSE_REVIEW_API_KEY`. Provider-specific keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`) take precedence over that shared model key when set.

This repository dogfoods the GitHub path with `qwen3.6-35b-a3b` through Scaleway's
OpenAI-compatible endpoint. `SCW_GENERATIVE_API_KEY` is the fallback for a dedicated
`COPSE_REVIEW_API_KEY`; `COPSE_REVIEW_PROVIDER`, `COPSE_REVIEW_MODEL`,
`COPSE_REVIEW_BASE_URL`, `COPSE_REVIEW_LENSES` and `COPSE_REVIEW_MAX_VERIFY` repository
variables override the pinned profile. The default is one correctness lens and at most
three challenged findings. Review context is secret-redacted before it leaves the runner,
but it does leave GitHub for the configured model endpoint.

`.github/workflows/review-nightly.yml` samples at most one recent, non-draft branch from
this repository each night (already-labelled PRs, generated screenshot-review PRs and
`copse-review-skip` are excluded), using the same secret-free Stage 0 / read-only findings
split. It can also be dispatched for a specific same-repository PR. Both paths remain
advisory and retain the full findings JSON and SARIF for 30 days so latency, token use and
human adjudication can be collected before any proposal to make the reviewer required.

The CLI discovers the standard host pnpm store (or the absolute
`npm_config_store_dir` / `PNPM_HOME` environment setting) without running pnpm
or reading repository configuration. Pass `--store` for a custom store configured
only in `.npmrc`. Base dependencies and build artifacts are prepared lazily before
the first reproducer, even when every Stage 0 check passed on head.

## In the app

Phase 3 lives in the app repository rather than here: the `copse.review` first-party
plugin, `src/main/services/review/review-service.ts` (this package's pipeline over a
thread's checkout, read-only where the OS sandbox is not active), the findings card and
the Changes view's "Review". `openReviewGround`'s `readOnlyCheckouts` option is what the
app uses to review without executing.

## Measuring it

```bash
pnpm run bench:review --mock --gate                      # the deterministic self-test CI runs
pnpm run bench:review --provider lmstudio --model qwen3-coder
pnpm run bench:review --model a --model b --compare bench-results/review/summary.json other/summary.json
```

See [`benchmarks/review/README.md`](../../benchmarks/review/README.md). The mock number
measures the corpus and the pipeline's non-model parts. Model baselines are regression
ratchets; the separate `--target-gate` requires 85% precision with a 95% confidence lower
bound, a recall floor and no duplicates on a sufficiently large labelled corpus.

## Not yet here

Reproducers in CI (job B has no cell, so Stage 4 there is the challenger only), a
model-profile regression baseline, and a mapped corpus of real pull requests large enough
to test B8. See the plan's §Phases, §What Phase 4 delivered and §What Phase 5 delivered.
