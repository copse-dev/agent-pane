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
  in its own throwaway Docker, Podman or Apple container from a pinned image, never pulled, with
  the thread-in-container runtime's hardening (read-only root, all capabilities dropped,
  no new privileges, pid / memory / cpu limits, an exec-able private `/tmp`) and no network
  interface. Checkouts and scratch are bind-mounted read-write at their host paths, the
  declared read-only paths read-only at theirs; the host `PATH` gives way to the image's;
  containers are created before starting, with the requested executable as their entrypoint,
  so cancelling during creation cannot start a command after cleanup. `<engine> rm --force`
  ends a timed-out command with everything it forked. `containerCreateArgs` is
  pure and pinned by a test; `detectContainerBackend` says why there is no backend rather
  than guessing. Apple container (Apple silicon, macOS 26+) speaks its own dialect
  (`appleCreateArgs`, after the thread-in-container runtime's mapping): `--volume` mounts,
  `RLIMIT_NPROC` for the pid limit, `delete --force`, and no-new-privileges from
  `setpriv --no-new-privs`, which `Dockerfile.cell` guarantees by failing without it and
  stripping every setuid bit. `COPSE_CONTAINER_ENGINE` (`auto` / `docker` / `podman` /
  `apple`) picks the engine; `auto` tries Docker, Podman, then Apple container.
- **`checkouts.ts`** — materialises the merge-base and head as detached worktrees under
  the review's scratch directory, with the working tree's uncommitted changes overlaid on
  head. Git runs on the host with hooks disabled; nothing from a checkout is executed
  here.
- **`project-commands.ts`** — detects `build` / `typecheck` / `lint` / `test` for a
  TypeScript + pnpm repository (B5), overridable per repo by a `review.config.json`
  (argv per command, `null` to disable, timeouts). The default `prepare` is
  `pnpm install --frozen-lockfile --offline --ignore-scripts`, resolved from the host's
  pnpm store and corepack cache, both mounted read-only; corepack is pinned offline. Each
  disposable checkout gets a local symlink to the store mount so pnpm keeps its mutable
  project registration out of the immutable shared store, including for later focused tests. A
  trusted caller can override only preparation with `--trusted-prepare`, so default-branch
  CI policy can repair native dependencies even when the pull-request head predates that
  repository profile; only that trusted script file is added to the cell's read-only mounts.
- **`dependency-policy.ts`** / **`cell-preparation.ts`** — the trusted host's half of a
  cell, shared by the Actions shell (`ci/prepare-action.mts`) and the local shell: the
  lockfile checks (registry tarballs only; patch paths under `patches/`; directory
  dependencies only where the profile admits them), the dependency store filled by
  `pnpm fetch` / `npm cache add` in a seed directory with no repository config, and the
  image build. The store is filled for the **cell's** platform: the seed's
  `supportedArchitectures` makes `pnpm fetch` on a Mac fetch the Linux builds of
  platform packages (esbuild, rollup, …) the Linux cell installs offline.
- **`stage0.ts`** — runs the checks on head, then on base for whatever failed on head,
  and turns the delta into findings: a `tsc` regression becomes one finding per new
  diagnostic anchored at its line; a build or test regression becomes one finding
  anchored at the script in `package.json`. A lint regression is a failed check, never a
  finding (B4). Every output is size-capped and secret-scrubbed before it is kept, and
  the report always says what was not checked and why. An imported Stage 0 attached to a
  fresh execution cell re-prepares head (and its build output) before model tools, and
  independently prepares base before a reproducer; artifacts from another job are never
  assumed to exist locally.
- **`context.ts`** — Stage 1: the diff against the merge-base (committed plus the overlaid
  working tree), budgeted per file so a large change drops lockfiles and generated files
  first and then cuts retained files at a line boundary within a strict total cap; the
  repository's `AGENTS.md` / `CLAUDE.md` / `CONTRIBUTING.md`; and a test map for the
  touched files.
- **`lenses.ts`** — a lens is a scoped brief with a step budget: `correctness` (the default),
  `contracts`, `boundaries` (semantic fields, defaults and downstream fallbacks), `tests`,
  `security`, `concurrency`, `transitions`, and `visual` (rendering regressions seen in
  images); `--lenses all` runs every one. All stay inside B4. `applicableLenses` drops
  `visual` beside other lenses when there is no image to look at. The system prompt
  restates the quality bar as rules.
- **`pr-conversation.ts`** — Stage 1's pull-request half, behind `--read-pr`: the
  description, discussion, reviews and inline review comments from GitHub or Forgejo,
  skipping Copse Reviewer's own reviews, budgeted, and wrapped as external content. Every
  image becomes a handle (`img-3`) in an index; one in a table row is labelled by its row
  and column header, so any bot's before/after table reads as `settings.png — After`.
- **`review-images.ts`** — what `view_image` may show and how it is fetched: magic-byte
  checked PNG/JPEG/GIF/WebP up to 5 MB; conversation images only by id, over https, from
  the forge's hosts or `--image-host`, every redirect re-checked; the forge token only to
  its API (a same-repository GitHub link at a commit goes through the contents endpoint).
- **`reviewer-tools.ts`** — the reviewer's tools, jailed to the head checkout:
  `read_file`, `list_dir`, `search_code` (without following checkout symlinks),
  `read_dependency_file` (a fixed data-only helper in the serialised secret-free cell that follows
  pnpm package links only when their canonical file remains inside the disposable `node_modules`), and
  `git_diff` (complete per-file diffs paged by character offset); `view_image` (a changed image
  file on head or base, or a conversation image by id, returned as a tool-result image; twelve
  per role); `run_command`, brokered into the
  cell and gated by the run's permission profile, with its output wrapped as external
  content and secret-scrubbed. Its prompt directs reviewers to the smallest
  project-supported focused selector rather than repeating Stage 0's aggregate suite;
  and `report_finding`, through which every candidate
  arrives as a structured, anchored object rather than prose. Every reviewer must close
  with `finish_review`, a structured attestation of what it checked and could not verify;
  that closure can also carry findings the model held until its final response. If a
  provider ends in prose or consumes its investigation budget, the runner reserves the
  shared loop's generic-finalizer headroom for one bounded continuation over the same
  transcript with only the closure tool. The continuation has a short reasoning ceiling
  and converts the already-reached conclusion into anchored data. A still-missing
  attestation fails the run instead of being reported as clean, and preserves the draft
  for diagnosis.
- **`turn.ts`** / **`stage2.ts`** — one model turn over `@copse/agent`'s loop, projected live
  onto the headless contract's `turn_start … turn_end` event envelope; `runReviewers` fans
  out every model over every lens, a few at a time, over one serialised cell. Each role's
  report includes wall time in tools and outside tools. The latter includes model calls,
  API retries and orchestration; it is not a pure inference measurement. Every role's system
  prompt states today's (UTC) date, so a past timestamp is not reasoned about as a future one.
- **`cluster.ts`** — Stage 3: two candidates are one finding when their anchors overlap
  (with a few lines of slack) and their claims share enough content words. The first keeps
  its identity; the rest corroborate it. Thresholds are exported for `bench:review` to tune.
- **`verifier-tools.ts`** / **`stage4.ts`** — Stage 4: for the classes a test can demonstrate,
  a reproducer model writes one test under `.copse-review/` and names how to run it; it is
  run on head and on base. Opposite exit codes require a completed challenger audit of
  the test and both outputs before confirming a finding. Everything still open goes to the challenger, whose brief is to refute the finding
  with the burden of proof on the claim; `refuted` drops it, `stands` records the survived
  challenge. Most promising findings first, up to `--max-verify`.
  `--verify-concurrency 2` overlaps two findings' model passes; its default is 1
  for compatibility, and the protected PR workflow defaults to 2 (set repository
  variable `COPSE_REVIEW_VERIFY_CONCURRENCY=1` to restore sequential verification). Each
  finding's test precedes its own challenge. Tools still share one execution
  lane, including reproducer writes and cleanup; tests use distinct root-level
  filename prefixes so relative imports keep the same depth. Output ordering
  stays deterministic even when findings finish out of order.
- **`reproducer-runner.ts`** — `write_reproducer` accepts `argv: ["copse-test"]` for
  JS/TS `node:test` cases in projects that already depend on esbuild. The trusted runner
  executes only inside the existing cell, bundles local imports with each checkout's
  tsconfig, leaves package imports external, and runs the test with Node. Output stays
  inside a fresh checkout-local directory so dependencies resolve, then is removed.
  It needs no test-discovery changes on old base/head revisions and installs nothing.
  Import project DOM helpers explicitly. Custom argv remains available for other runners;
  project-specific test plugins/mocks are not installed automatically. Setup failures are
  labelled as such and cannot by themselves establish a defect.
- **`stage5.ts`** — rank and cap: confirmed findings, survivors and unverified candidates in
  one list, refuted reported separately, executable evidence, confirmation and a survived
  challenge rewarded, a lone unverified claim penalised, seven surfaced and the rest in the
  appendix.
- **`sarif.ts`** — SARIF 2.1.0 with the finding id in `partialFingerprints` and evidence,
  provenance and verdict in `properties` (B9).
- **`provider-selection.ts`** / **`cli.ts`** / **`bin/copse-review.mjs`** — the shell.
  Keys come from the environment only; remote providers get the diff with secrets
  redacted; `--provider mock` plays a scripted reviewer for harness self-tests.
  OpenRouter's reported hosting provider travels with each response's usage;
  per-turn JSON summaries and collapsed review details list the observed hosts.
  Missing metadata stays unknown rather than being inferred from a model ID.
  When a provider's own retries are exhausted on a retryable failure (an upstream rate
  limit, say) before anything but progress has streamed, `provider-backoff.ts` replays the
  request after about one and then two minutes, so many reviews started together degrade to
  slower rather than to "Review stopped early".
  Parallel pass durations overlap and must not be summed; tool time includes
  waiting for the shared execution lane.
- **`local-model-probe.ts`** — before Stage 0, asks a local server about each model a
  review will use: LM Studio's native catalogue gives the loaded context, vision and
  quantisation. A model loaded with too little context for `--budget-chars` fails the
  run in seconds with the `lms load … --context-length` that fixes it; a text-only model
  neither runs the `visual` lens nor is offered `view_image`; what the server said is
  recorded under the report's `models`. Servers without the catalogue (Ollama,
  llama.cpp, mlx-lm) are noted as unchecked rather than guessed at.
- **`local-pr.ts`** / **`review-lock.ts`** — `copse-review pr`: one pull request reviewed
  on this machine as CI would, with no forge integration (see below), one review at a
  time per machine.
- **`report-text.ts`** — the terminal projection. "Clean." is a complete answer only when
  every configured reviewer completed its attestation.
- **`stage0-report.ts`** — the Stage 0 report as a decoder, for the file the CI shell's
  secret-free job hands to the job with the model key: untrusted input, validated shape by
  shape (findings included) before a field of it reaches a model or a comment.
- **`forge-review.ts`** — the pull-request projection: one review (`COMMENT`, never a
  request for changes), each surfaced finding with a line an inline comment on the head
  commit, the rest in the body. On GitHub a re-run marks the same identity's earlier Copse
  reviews superseded (a submitted review cannot be deleted: its body becomes a link to the new
  one and its inline comments are hidden as outdated, keeping replies); a failure there leaves
  them as they were and does not fail the run. The CLI posts only when there is a finding to
  raise: a complete review with none marks earlier Copse reviews resolved instead, and an
  incomplete one leaves them. On GitHub it also leaves out a finding a bot comment on another
  open pull request already raises (same path and class, and a claim Stage 3 would cluster),
  naming that pull request; stacked branches otherwise received the same finding each. If that
  lookup fails, every finding is kept. GitHub and Forgejo; a line the forge refuses is folded
  into the body rather than lost. The claim and confirmation status stay visible;
  supporting reasoning and evidence use a collapsed `details` section. Run metadata and
  per-role timing live under `Review details`. Incomplete reviews and missing checks keep
  a visible warning even when the details are collapsed.
- **`pr-summary.ts`** — the pull request's description summary (B4 as amended): one
  tool-free model turn over the Stage 1 context that must end in `write_summary` (a risk
  level, a one-sentence reason and a short overview), rendered as a `[!NOTE]` block between
  `<!-- copse-review-summary -->` markers at the bottom of the description. Each run
  replaces only a block it wrote (whole-line markers outside code fences, the exact rendered
  shape between them, and a hidden digest showing the text is unedited) and leaves the rest
  of the description untouched. A surfaced high or critical finding raises the risk to High, and a
  medium-severity finding raises Low to Medium. Low-severity findings leave the risk unchanged;
  the evidence never lowers it. Model prose is inert markdown, as in reviews, so a
  diff cannot forge the end marker. Posting reads the description and writes it back, and
  leaves a pull request whose head has moved past the summarised commit alone.
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
  another, required); CI's gated `review-cell` job builds `Dockerfile.cell` and runs that
  real-engine arm, including the exact read-only trusted-preparation-file mount and a real
  offline preparation against the read-only dependency store. The unit tier covers its plumbing
  over a fake engine.

## Running it on this repository

```bash
pnpm run review --allow-unisolated --no-model                 # Stage 0 only
pnpm run review --allow-unisolated --model claude-sonnet-5    # plus one model reviewer
pnpm run review --allow-unisolated --provider lmstudio --model qwen3-coder
pnpm run review --allow-unisolated --model claude-sonnet-5 --model gpt-5 --lenses all
pnpm run review --allow-unisolated --model qwen3-coder --challenger claude-sonnet-5
pnpm run review --allow-unisolated --json report.json --sarif report.sarif --events turns.jsonl
pnpm run review --allow-unisolated --model claude-sonnet-5 --lenses correctness,visual \
  --read-pr github --repo owner/name --pr 123                 # plus the PR's discussion and images
pnpm run review --help
```

`--allow-unisolated` is the consent the trust table requires for your own tree when no
container answers. Findings are the output, never the exit code; the exit codes are the
headless contract's: `0` the reviewer looked, `1` the model turn failed or the review
could not be posted, `2` bad usage or an undetectable project, `3` execution was refused
for want of consent or isolation, `130` cancelled.

Local models get their own route options. `--challenger-provider` and
`--challenger-base-url` put the challenger on a second server (another LM Studio, an
mlx-lm or llama.cpp server, or a hosted model) while `--provider` / `--base-url` serve
the reviewers; `--reasoning` and `--challenger-reasoning` set each role's effort. When
every route is a local server, reviewers run one at a time (`--concurrency` overrides).
`--min-context` sets the context a local model must be loaded with (default: what
`--budget-chars` needs; `0` skips the check), and `--time-limit <minutes>` bounds the
whole run. Each turn of a local model knows the context it is loaded with and keeps its
history within three quarters of it, dropping its oldest investigation steps (never the
review request), so the server never receives a request it would silently cut from the
middle. A forced closure (`finish_review`, the challenger's `verdict`) is sent as
`tool_choice: "required"` with only that tool offered, which LM Studio accepts with
reasoning on.

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

## Reviewing a pull request on this machine (`copse-review pr`)

`copse-review pr` does on one machine what the CI shell spreads over two jobs, with no
forge API and no Copse service. Run it from a clone of the repository under review:

```bash
copse-review pr 123 --provider lmstudio --model qwen/qwen3-coder-30b
copse-review pr https://github.com/owner/repo/pull/123 --model qwen/qwen3-coder-30b \
  --challenger glm-4.6 --challenger-base-url http://127.0.0.1:8080/v1 \
  --challenger-provider openai-compatible
copse-review pr feature/branch --base main --no-model          # a ref, as it is; Stage 0 only
copse-review pr --help
```

(In this repository, `pnpm run review pr 123 …`; elsewhere,
`node <copse>/packages/review/bin/copse-review.mjs pr 123 …`.)

It fetches `refs/pull/<n>/head` and the base branch (the remote's default, or `--base`)
into `refs/copse-review/pr-<n>/`, leaving your branches and remote-tracking refs alone;
fills the dependency store for the Linux cell from the two lockfiles; builds the
validation image from `Dockerfile.cell` once per Dockerfile revision, or uses `--image`;
and runs the whole review with the change treated as **foreign**, whoever wrote it:
Stage 0, every `run_command` and every reproducer execute in network-disabled containers
(B3). A local model needs no key, so nothing secret is in reach of the change, and the
diff never leaves the machine.

Everything it keeps is under `~/.copse` (`COPSE_DIR` moves it):

- `cache/review/` — the Linux dependency stores (`pnpm-store-linux-<cpu>-glibc`,
  `npm-cache`), reused across reviews and skipped when the lockfiles are unchanged; the
  scratch checkouts; and `review.lock`, so a second review waits for the first (it shares
  the GPU, the CPUs and the store). A lock whose holder died is taken over.
- `reviews/<owner-repo>/pr-<n>/<head>-<settings>/` — `report.json`, `report.sarif`,
  `events.jsonl`, `report.txt` and `run.json` (inputs, engine, image, exit code), plus
  `pr-<n>.latest.json` beside them. The directory is keyed by the head, the merge-base,
  the engine asked for, the cell's limits, the review options (not the output-only
  `--quiet` or `--time-limit`) and the reviewer's own revision: asking again answers from
  the saved report (`--fresh` reviews again).

The profile follows the lockfile: `npm` (`package-lock.json`), `pnpm`, or `copse-pnpm` for
Copse itself, whose preparation builds node-pty in the cell. `--cell-memory` and
`--cell-cpus` size each cell command (default a quarter of the machine's memory, 4g to
16g, and half its CPUs, 2 to 8). Copse itself needs about 16g and 8: at 4g its typecheck
and lint run Node out of heap, and the run says so. `--cell-cpu x64` runs the cell as x64
Linux (under Rosetta on a Mac; the store and image follow it). A run writes beside the
saved report and replaces it only when it finishes, so a cancelled or failed run leaves
the last answer untouched; a report whose preparation failed or whose checks did not all
run is never reused as the answer. A container the engine is too slow to remove does not
cost its check's result; one still left when the review ends is named with the command
that removes it.

### On a Mac Studio

1. **A container engine.** OrbStack or Docker Desktop take the Docker dialect unchanged;
   Apple container (`container system start`, macOS 26+) is chosen when no Docker or
   Podman answers, or with `--engine apple` / `COPSE_CONTAINER_ENGINE=apple`. Prove the
   engine once with the conformance test:
   `COPSE_REVIEW_CONTAINER_E2E=1 COPSE_REVIEW_IMAGE=<tag> pnpm test -- packages/review/src/hostile-fixture.test.ts`
   (with `COPSE_REVIEW_DEPENDENCY_STORE` naming any store directory holding `v10/`).
2. **The model server.** LM Studio headless: `lms server start`, then
   `lms load <model> --context-length 65536` for each model (a review at the default
   `--budget-chars` needs about 49k tokens; the pre-flight says what is missing, and a
   large change reviews more comfortably at 131072). Load the
   reviewer and challenger together only if both fit in memory; otherwise the server
   swaps them between Stage 2 and Stage 4.
3. **The reviewer.** A checkout of this repository with `pnpm install` done, on Node 24.

On a Mac Studio, Apple container and colima (the Docker dialect) both pass the
conformance test, and Copse's own build, typecheck and lint run in Apple container cells
at 16g and 8 CPUs. Whether a local reviewer and challenger carry the review (the plan's
Q11) is still to be settled: measure it with
`pnpm run bench:review --provider lmstudio --model <m>` before trusting the output.

## In CI

For adoption on a separate repository, see [the reusable Actions workflow](ACTIONS.md).
Its first consumer is `copse-dev/streaming-markdown`; the workflow runs on the
adopter's runners, with separate isolated grounding and review jobs. No Copse
service is required. Copse calls this same workflow with its reviewed pnpm preparation policy.

`review-trigger.yml` calls `reviewer.yml` locally, so both the workflow and reviewer
source come from the same trusted default-branch revision. It retains owner-only,
same-repository paid reviews: ready PRs opened, reopened or marked ready are reviewed;
`copse-review` opts a draft in or requests a rerun; `copse-review-skip` opts out. Pushes
only dispatch the separate description-summary workflow. Maintainers can also dispatch
the caller manually with a PR number. Nightly sampling and real-model benchmarks remain
independent workflows.

The shared workflow resolves current PR metadata and separates grounding from findings
with a fresh runner for each. Grounding has `permissions: {}` and no referenced model or
App secrets. Both grounding and focused verification use network-disabled containers;
contributor code cannot reach the runner's Actions runtime token or command files.
Artifacts belong to the same run and attempt, and the CLI validates the exact reviewed
head and merge-base. Every new run grounds afresh; the previous 24-hour grounding lookup
and cross-workflow handoff have been removed. Normal PR CI's merge-commit checks are not
substituted for checks of the reviewed head.

The `copse-pnpm` preparation profile is restricted to Copse's own repository. The host
validates the head and merge-base lockfiles, permits integrity-pinned registry packages
and the reviewed `packages/extract-zip` directory dependency, and copies patch blobs at
validated paths. `pnpm fetch` runs in caller-owned scratch with manifests and hooks absent.
It skips local dependencies. The cell installs offline with lifecycle scripts disabled,
copies the immutable seed into a checkout-private writable store, then runs only the
reviewed node-pty build through `scripts/prepare-review-stage0.mts`. Electron's binary is
never downloaded, so that script gives the cell a placeholder executable at the path
Electron's loader returns: test files that import `electron` load and run, and anything
that launches it fails with a message saying the cell has none.

The protected `copse-findings` job rechecks the owner/caller/rerun context before entering
`copse-review-models`, keeps its workflow token read-only, and calls the same findings
Action as portable consumers. Model credentials enter only the review step; its App token
is minted after source/cache/image preparation. Imported Stage 0 uses `--backend container`
for focused verification and refuses a report for another commit. Source reads remain on
the trusted host; project commands and reproducers receive a scrubbed environment inside
network-disabled, capability-free containers with a read-only root.

Full-review description summaries are handed off as bounded inert data to a separate
model-free publisher. It verifies the immutable same-run artifact ID and ZIP/payload
digests against trusted producer outputs, rechecks the authorized PR head/base and consent,
and merges into the current author description using its own workflow token. The App
continues to post reviews and feedback labels. This prevents a bot summary PATCH from
dispatching another CI candidate without broadening the model read-context credential.

The run posts one advisory review
(`--post-review github --repo owner/name --pr n`), having read the pull request's
description, discussion, reviews and images first (`--read-pr github`); the default lenses
are `correctness,visual`, and `visual` runs only when there is an image to look at.
When configured with `--feedback-label <name>`, a non-empty review adds that label to the
pull request after posting; the CI workflows use `COPSE_REVIEW_FEEDBACK_LABEL` and default
to `review-has-feedback`.
The posted review carries material `finish_review.couldNotVerify` limits from every completed
reviewer. It says plain “No findings” only when those structured attestations declare nothing
material unverified; a bounded read-only review is never presented as broader assurance than it was.
The GitHub dogfood jobs mint a repository-scoped token for the existing Copse release/deploy
App with only `pull-requests: write` and pass it as `COPSE_REVIEW_FORGE_TOKEN`; their
`GITHUB_TOKEN` remains read-only and is passed as `COPSE_REVIEW_READ_TOKEN`, which
`--read-pr` prefers, so the write token is sent only with the post. For other callers the
token is `COPSE_REVIEW_FORGE_TOKEN`, else `GITHUB_TOKEN`; the model key `COPSE_REVIEW_API_KEY`.
Provider-specific keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`) take precedence over that shared model key when set.

The PR and nightly workflows default to Luna through OpenRouter, using only the
protected environment's `COPSE_REVIEW_OPENROUTER_API_KEY`. They prefer standard
OpenAI hosting while retaining zero-data-retention, no-training and supported-parameter
filters, with fallback to other eligible providers. Set the repository variable
`COPSE_REVIEW_OPENROUTER_PROVIDER=auto` to restore automatic routing, or to a base
provider slug such as `azure` to change the preference. The CLI reads the same name
from its environment; an unset value keeps automatic routing. This applies to discovery,
reproduction and challenge, including an explicitly selected challenger. Service-tier
slugs such as `openai/fast` are rejected. A preference does not guarantee which provider
answers; the review's usage details record the actual host.

Set `COPSE_REVIEW_PR_PROFILE=configured` to restore the retained `qwen3.8-27b` route
through Scaleway. `SCW_GENERATIVE_API_KEY` is the fallback for a dedicated
`COPSE_REVIEW_API_KEY`; `COPSE_REVIEW_PROVIDER`, `COPSE_REVIEW_MODEL`,
`COPSE_REVIEW_BASE_URL`, `COPSE_REVIEW_LENSES`, `COPSE_REVIEW_MAX_STEPS` and
`COPSE_REVIEW_MAX_VERIFY` repository variables override the pinned profile. The default is
the correctness lens, plus the visual lens when the change or its conversation has an image,
at most 12 tool-using steps and at most three challenged findings.
Review context is secret-redacted before it leaves the runner, but it does leave GitHub for
the configured model endpoint.

The description summary follows the head rather than the review. The trigger's `summary` job
dispatches `review-summary.yml` when a pull request the review would accept is opened,
reopened, marked ready or labelled, and on every push to one. That workflow authorizes like
the findings workflow, then runs the default branch's CLI with `--summary-only
--post-summary github`: read-only checkouts, no Stage 0, no container and nothing executed,
with the same model route. It edits the description with the job's own `GITHUB_TOKEN`
rather than the App token: GitHub starts no workflow run for an event that token causes,
whereas an App-token edit fires `edited` and CI re-ran in full on the same head. The findings
job also passes `--post-summary github`, so a finished review rewrites the summary with its
evidence unless a newer push has moved the pull request on. Forgejo's findings job does the same on each
labelled push.

`.github/workflows/review-nightly.yml` samples at most one recent branch from this repository
each night from its drafts, because that is where most active Copse work lives and ready pull
requests are already reviewed (already-labelled PRs, generated screenshot-review PRs and
`copse-review-skip` are excluded),
using the same secret-free Stage 0 / container-backed focused-validation split. It can also be dispatched for a
specific same-repository PR, draft or otherwise. Both paths remain advisory and retain the full
findings JSON and SARIF for 30 days so latency, token use and human adjudication can be collected
before any proposal to make the reviewer required.

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

Forgejo focused-validation-cell parity, a model-profile regression baseline, and a mapped
corpus of real pull requests large enough to test B8. See the plan's §Phases, §What Phase 4
delivered and §What Phase 5 delivered. For the local shell: a measured local reviewer and
challenger pair (Q11), and a run of `copse-review pr` and the conformance test on Apple
hardware under both Docker-dialect engines and Apple container (§Local pull-request shell).
