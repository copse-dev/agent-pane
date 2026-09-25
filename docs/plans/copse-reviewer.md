# Copse Reviewer

Status: **Active — Phases 0 to 5 landed; B8's Martian-offline target is unmeasured.**
`@copse/review` is a workspace package on
`main` with the finding schema, Stage 0 (the base-versus-head build and test delta), the
`IsolationBackend` contract with the host-process, OS-sandbox and container backends, the
hostile-fixture conformance test, and the `copse-review` CLI: Stage 1 context, models ×
lenses with brokered tools, Stage 3 clustering, Stage 4 verification by reproducer and
adversarial challenge, the ranked report, SARIF export and the headless event envelope.
`pnpm run review -- --allow-unisolated` runs it over this repository's own working tree;
`--head <ref> --foreign` reviews a contributor's branch, executing only in a container.
In the app, the `copse.review` plugin has replaced `copse.model-comparison`: "Review" in
the Changes view, the "Review changes" bubble and the `review_changes` tool run the same
pipeline over the thread's checkout and render a findings card, with dismissals persisted
to the knowledge store (see §What Phase 3 delivered). In CI, the `copse-review` label on a
pull request runs Stage 0 on a secret-free runner and posts the findings as one review
from a second job whose model process brokers focused validation into a secret-free
container (see §What Phase 4 delivered). `pnpm run bench:review` scores
the pipeline for precision on surfaced findings over a corpus of cases with known defects,
with a mock self-test CI gates per PR, exact-configuration regression baselines, and a
separate model-only target gate; the seven-case local corpus cannot establish B8 (see §What
Phase 5 delivered). See also §What Phase 0 delivered, §What Phase 1 delivered and §What
Phase 2 delivered.
Binding decisions B1 (execution isolation, 2026-09-03), B2–B6 (packaging, backend
sequencing, scope, ecosystem, customer; 2026-09-04) and B7–B9 (name, precision aim, SARIF
export; 2026-09-04) are recorded. Problems are numbered P1–P9 in §What needs to be solved,
questions Q1–Q16 in §Competitive position, and the remaining decisions D3–D4 in §Open
decisions.

Prior art that prompted this: FFmpeg's **Forgejo Fairy**, the opt-in LLM reviewer a
contributor adds to a pull request by hand ([`doc/developer.texi`](https://ffmpeg.org/developer.html):
_"If you want an LLM-based review, add Forgejo Fairy as a reviewer to your pull request.
Issues with Fairy herself can be reported at her repository."_). Her source lives at
`code.ffmpeg.org/michaelni/Fairies`, which is unreachable from this environment (the
egress proxy returns 403 for `code.ffmpeg.org`), so everything below cites her
**documented behaviour**, not her implementation. Anything about her internals is
explicitly marked as inference.

Related: the retired in-tree `copse.model-comparison` plugin (its judge, runner and
`compare_models` tool were deleted in Phase 3; `packages/agent/src/plugins/review-plugin.ts`
took its place) — it had no plan doc of its own;
[`hooks-and-feature-packs.md`](hooks-and-feature-packs.md), whose decisions log
[`../../AGENTS.md`](../../AGENTS.md) makes binding for feature-pack work — its P5 extracted
the pack Phase 3 replaces, its decision 15 governs the typed chunk the findings card
consumes, and its decision 5 budgets any machine turn a review starts;
[`headless-automation-contract.md`](headless-automation-contract.md) (the contract a CLI
shell must speak), [`dark-factory-pr-orchestrator.md`](dark-factory-pr-orchestrator.md)
(the fleet supervisor that would _schedule_ reviews), [`industry-benchmarks.md`](industry-benchmarks.md)
(the harness pattern the reviewer's eval borrows), [`execution-runtime-security.md`](execution-runtime-security.md)
and [`../shell-permissions.md`](../shell-permissions.md) (the containment boundary the
build/verify stages must run inside).

## What this is

A reviewer that **builds the code, tries to break it, and reports only what it could
stand behind** — packaged so it runs three ways over one core: from a terminal in any
repository, inside Copse, and in CI on a pull request.

The unit of output is a **finding**: a structured, addressable, evidenced claim about a
specific line range, carrying who found it, who corroborated it, what was executed to
test it, and what that execution showed. Not a paragraph of prose.

Three properties, in priority order:

1. **Evidenced.** Every surfaced finding names the command that was run and what it
   printed, or the reproducing test that fails on head and passes on base, or the exact
   lines that contradict each other. A finding with none of those is a _question_, and
   questions are ranked below findings or dropped.
2. **Multi-model where it buys something.** Independent reviewers raise candidates;
   corroboration is an input to ranking, not a verdict. A second model's job is mostly to
   _refute_, not to agree.
3. **Short.** A capped, ranked list a human reads in full. Recall is not the target;
   precision is.

## What Fairy gets right, and what to take

Verified from FFmpeg's developer docs:

- **She is invited, not imposed.** A contributor _adds her as a reviewer_. That is a
  deliberate human gesture, made in the place the work already lives, at the moment
  review is wanted. It is not a config toggle set once in a settings dialog and forgotten.
- **She is a participant, not a gate.** A reviewer on a PR, not a required status check.
  Her output is advisory; humans still review. Nothing merges or blocks on her.
- **She is a separate, maintained thing with her own issue tracker.** "Issues with Fairy
  herself can be reported at her repository." The reviewer is an artefact with a life
  independent of the project it reviews — which is exactly the shape needed for "reusable
  in other people's projects."
- **The name is plural** (`Fairies`). Inference, flagged as such: more than one reviewer
  persona behind one invitation.

The lesson for us is the first bullet. Copse's comparison feature is not
under-discovered because it is badly built; it is under-discovered because there is no
gesture that invokes it. See below.

## Current state audit

| Piece                            | Where                                                                                  | State                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Post-turn review subagent        | `packages/agent/src/review-subagent.ts`, `src/main/services/review-subagent-runner.ts` | ✅ read-only subagent over the working diff; emits a prose summary + `REVIEW_JSON` verdict                                 |
| Two-reviewer + judge comparison  | `src/main/services/model-comparison.ts`, `model-comparison-runner.ts`                  | ✅ fan-out to two models, judge compares their _prose_; experimental plugin, default off                                   |
| Review / comparison cards        | `src/renderer/views/review-panel.ts`, `comparison-panel.ts`                            | ✅ rendered inline in the conversation; comparison card is the only consumer of the comparison                             |
| Model selection by rule          | `@copse/llm/dynamic-model.ts`, `resolveDistinctDynamicModelIds`                        | ✅ "best value" / "best intellect" selectors that resolve to _distinct_ concrete models                                    |
| Spend approval                   | `comparisonNeedsApproval`, `requestApproval`                                           | ✅ prompts when any of the three models is billable, with per-thread remember                                              |
| Electron-free agent core         | `@copse/agent`, `@copse/llm`                                                           | ✅ real package boundary, proven by `scripts/bench-agent-lib.mts` (imports the packages only — no Electron, no `src/main`) |
| Headless contract                | `packages/agent/src/headless-contract.ts`                                              | ✅ v1 request/event/permission/exit-code contract with a published JSON Schema                                             |
| Worktrees                        | `src/main/services/worktree-manager.ts`, `worktree-inventory.ts`                       | ✅ per-thread worktree lifecycle                                                                                           |
| Command execution + sandbox      | `src/main/services/exec/command-runner.ts`, `src/main/project-sandbox/`                | ✅ spawn, network scope, output caps — but **not reachable from a review**                                                 |
| CI investigator subagent         | `src/main/services/github/ci-investigator-service.ts`                                  | ✅ read-only, reads real CI failures — on-demand inside a live turn only                                                   |
| PR context                       | `src/main/services/github/pr-context-service.ts`, `pr-file-content.ts`                 | ✅ PR metadata and file content                                                                                            |
| Durable notes                    | `src/main/services/storage/knowledge-store.ts`                                         | ✅ typed OKF notes; no new store needed for finding suppression                                                            |
| Untrusted-content handling       | `packages/agent/src/external-content.ts`                                               | ✅ exists; not currently applied to review inputs                                                                          |
| **Structured finding type**      | —                                                                                      | ❌ reviews are prose end-to-end                                                                                            |
| **Any execution during review**  | —                                                                                      | ❌ `REVIEW_TOOL_NAMES` is strictly read-only                                                                               |
| **CLI entry point**              | —                                                                                      | ❌ no `bin` in `package.json`; no standalone runner                                                                        |
| **Finding suppression / memory** | —                                                                                      | ❌ every run rediscovers everything                                                                                        |
| **Review quality measurement**   | —                                                                                      | ❌ no eval; no precision number to regress against                                                                         |

### Problem 1 — it is never surfaced

The comparison sits behind two hard gates and one conditional one. The plugin is
`stability: 'experimental'`, so it is default-off; the automatic path additionally needs the
top-level `modelComparisonAutoOnReview` opt-in, default false; and a spend-approval modal
appears when any chosen model is billable, skipped when every model is local or when the user
picked the models themselves. Its two on-demand entries are the `compare_models` native tool,
which only the agent calls, and a "Compare models" follow-up bubble that appears only
`when: 'workspace-changes'`.

None of those is the moment a human actually wants a review. The fix is not to lower a
gate; it is to add the gesture Fairy has and Copse lacks: **an explicit "review this" act,
in the surface where the human is already looking at the change** — the Changes view, PR
creation, `copse review` in a terminal. Automatic-on-every-editing-turn is the wrong
trigger regardless of its default; it fires when nobody asked and trains people to ignore
the card.

### Problem 2 — nothing validates

`REVIEW_TOOL_NAMES` is `read_file`, `list_dir`, `search_code`, `git_diff`, `git_status`,
`git_log`, `staged_diffs`, `read_staged_diff`. There is no shell, no build, no test run.
Both reviewers start from the same diff, capped at `MAX_DIFF_CHARS = 12_000` in
`packages/agent/src/review-subagent.ts`, and each drives its own read-only tool loop from
there (`reviewWith` in `src/main/services/model-comparison-runner.ts` calls
`runPostTurnReview` once per model). The judge is weaker still: a single
`completeTextWithUsage` call with no tools at all, fed only the parent goal, the two model
ids and the two prose reviews, and explicitly told **"Do NOT re-review the code yourself"**.

So the pipeline has no contact with a compiler, a type checker, a linter or a test at any
point. Two models can agree, fluently and in detail, on a claim that thirty seconds of
`pnpm run typecheck` would have refuted — and the judge's role, as written, is to
_summarise their agreement_. Agreement between correlated models is close to worthless as
evidence; execution is worth a great deal.

### Problem 3 — prose is not addressable

Because the output is markdown, a finding has no identity. That single fact blocks:
per-finding verification, dedupe across reviewers, ranking, capping, inline PR comments,
"I already dismissed this", machine consumption by CI, and any measurement of whether the
reviewer is getting better or worse. The one structured hook that exists — the verdict's
`todoUpdates`, which can mint a todo item per finding — is a task id, not a finding id: it
carries no anchor, no evidence, and does not survive the next push.

## Design

### The core move: findings, not reviews

One schema, in a new Electron-free package, is the whole contract. Sketch — the field
list is the design, the exact encoding is Phase 1's to settle:

- **identity** — a stable id derived from the _content_ of the anchored lines plus a
  normalised claim, not from line numbers (so it survives rebase and reformatting).
- **anchor** — path, line range, and the blob hash it was computed against.
- **claim** — one sentence, falsifiable.
- **class** — `build` | `type` | `test` | `contract` | `security` | `concurrency` |
  `resource` | `api-compat` | `docs`. Class determines which verification strategy applies.
- **severity** and **confidence**, separately. A high-severity low-confidence finding is
  a different object from a low-severity certain one, and they rank differently.
- **provenance** — which reviewer (model id + lens) raised it, which corroborated, which
  challenged it and lost.
- **evidence** — an ordered list of `{ kind, command, exitCode, excerpt }` or
  `{ kind: 'reproducer', testPath, failsOnHead, passesOnBase }` or `{ kind: 'citation',
path, lines }`.
- **verdict** — `confirmed` | `refuted` | `unverified`, with the reason.
- **remedy** — optional minimal patch.

Everything downstream (terminal renderer, app card, PR comments, exit code) is a
projection of a list of these. That is what makes one core serve three shells.

### Pipeline

**Stage 0 — Ground (no model calls).**
Materialise two checkouts: merge-base and head. Detect or read the project's own commands
(build, typecheck, lint, test). Run them on both. The **delta** between base and head
results is a set of findings produced for zero tokens and at maximum confidence: it
compiled before and doesn't now; this test passed before and fails now; the linter is
newly angry about this line. If head does not build, the run says so and stops before
spending a penny on models — the highest-value review outcome in the whole system is also
the cheapest.
_Reuse: `worktree-manager.ts`, `project-sandbox/`, `exec/command-runner.ts`._

**Stage 1 — Context.**
Diff, merge-base, changed-file neighbourhoods, the repo's own instructions
(`AGENTS.md`/`CLAUDE.md`/`CONTRIBUTING.md`), the test map for touched files, and — where
a PR exists — its description and review history. Critically: replace the flat
12k-character diff truncation with per-file budgeting, so a large change degrades by
_dropping low-signal files_ rather than by cutting off mid-hunk.
_Reuse: `git-service.ts`, `pr-context-service.ts`, `search/`, `trim-history.ts` budgeting._

**Stage 2 — Fan out.**
N models × M **lenses**. A lens is a scoped brief with its own tool budget — correctness,
contracts/API compatibility, semantic boundaries/defaults, tests, security,
concurrency/resources, docs-vs-behaviour.
Lenses matter more than model count: two models on one generic "review this" prompt
mostly produce the same middle-of-the-distribution observations, whereas one model given
"only look for broken contracts" produces something the correctness lens didn't. Each
reviewer **may execute** — run the tests, run a scratch script — inside the cell. Read-only
lenses share the cell's read-only head checkout; any reviewer that writes gets its own git
worktree of head, so N × M reviewers never collide. Nothing reaches the real tree or the
network beyond policy.
Output: candidate findings, not prose.
_Reuse: `run-subagent.ts`, the fan-out in `model-comparison-runner.ts`,
`provider-selection.ts`, `dynamic-model.ts`._

**Stage 3 — Merge.**
Cluster candidates into canonical findings. Two candidates are the same finding when
their anchors overlap and their claims are equivalent. Record corroboration; do not
collapse it into a score yet.

**Stage 4 — Verify. (The new part.)**
For each canonical finding, pick a strategy by class and try to settle it by execution:

- `build` / `type` / `lint` — already settled by Stage 0.
- `test` / `contract` / `concurrency` — **write a reproducing test**. Confirmed only if it
  fails on head and passes on base. This is the strongest signal the system can produce
  and it is a real artefact the human can keep.
- `security` / `resource` — targeted execution or instrumented run where possible; trace
  every call site where not.
- anything not executable — an **adversarial challenge pass**: a second model whose brief
  is to _refute_ the finding using the code, with the burden of proof on the finding. This
  is the job the current judge should have had.

Verification is where the budget goes, and it is spent only on survivors of Stage 3.

**Stage 5 — Report.**
Drop refuted. Rank by severity × confidence, with a bonus for executable evidence and a
penalty for "raised once, corroborated by nobody, verified by nothing". Cap the surfaced
list (~7); the rest go to an appendix in the JSON. Always emit what was checked _and what
was not_ — "built ✓, 412 tests ✓, did not exercise the migration path" is more useful to
a reviewer than another speculative paragraph.

### The quality bar

These are the rules that decide whether this is worth a human's attention. They are
product requirements, not prompt suggestions:

- **No evidence, no surface.** Demote or drop.
- **Refuted findings never reach the human.** The point of spending compute in Stage 4 is
  to not spend the human's attention in Stage 5.
- **Hard cap, ranked.** A forty-item list is not a review, it is a denial of service.
- **Style nits are the linter's job.** If the repo's linter doesn't flag it, the reviewer
  doesn't either. If it does, it is a lint failure, not a finding.
- **"Clean" is a complete answer**, and should be one line.
- **Say what wasn't checked.** Stated coverage limits beat implied completeness.
- **Never claim a test passed that was not run.** Evidence carries the exit code.

### Packaging: one core, three shells

**Core — `@copse/review`** (new workspace package, Electron-free). Finding schema,
pipeline stages, lens prompts, clustering, verification strategies, renderers. Depends
only on `@copse/agent` + `@copse/llm` + zod. The boundary is already real and already
proven: `scripts/bench-agent-lib.mts` imports exactly those packages and no Electron, and
exists in part to keep that boundary honest. `@copse/review` becomes the second such
consumer, which is what makes eventual extraction to its own repository a packaging
decision rather than a rewrite.

- **Shell A — CLI.** `copse review [--base <ref>] [--models …] [--json]`, runnable via
  `npx` in any repository, against any provider including a purely local model. This is
  the "reusable for others locally" answer and it is the shell that should exist _first_,
  because it is the only one that can be dogfooded on arbitrary repositories.
  Needs: a `bin` (the repo has none today) and conformance to
  [`headless-automation-contract.md`](headless-automation-contract.md) rather than a
  fourth private dialect.
- **Shell B — the app.** `copse.model-comparison` becomes `copse.review`, and the
  comparison card becomes a findings card: ranked, each finding expandable to its
  evidence, each dismissible — with dismissal persisted to `knowledge-store.ts` so it
  stays dismissed. Invoked by a **"Review" action in the Changes view**, which is the
  missing gesture from Problem 1.
- **Shell C — CI / forge.** A GitHub Action (and a Forgejo equivalent, honouring the
  lineage) that runs the CLI, posts findings as inline comments and uploads the SARIF
  export to code scanning where the forge has one (B9). Opt-in per PR — a label, or
  adding the reviewer, exactly as Fairy is invited — never automatic on every push, and
  never a required check.

### Execution isolation

**Decided — binding decision B1.** Every stage that runs the code under review (Stage 0's
build baseline, Stage 2's reviewer tool calls, Stage 4's reproducers) runs inside an
isolated, **ephemeral execution cell**: an OS sandbox, or a container or VM created for one
review and destroyed after it. No reviewer agent, and nothing the cell executes, ever has
direct access to sensitive data.

This consumes [`execution-runtime-security.md`](execution-runtime-security.md) rather than
restating it. Its binding decisions 1 (a session is separate from its runtime), 3 (a grant
names scope and duration), 4 (fail-closed, per-execution network), 5 (raw credentials stay
outside untrusted workloads) and 11 (unattended work has a non-human principal) are the
reviewer's rules too, and its GitHub credential broker is the path any forge write takes.

**Two privilege domains.**

| Domain                                | Holds                                                                                                                                                           | Runs                                                                                         | Never                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Orchestrator (trusted)                | provider keys, forge tokens, the findings store, the suppression store                                                                                          | the agent loops, model calls, clustering, ranking, rendering, forge writes                   | repo code, build scripts, tests                                                                |
| Execution cell (untrusted, ephemeral) | two read-only reference checkouts (merge-base, head), a per-reviewer git worktree of head for anything that writes, a scratch dir, a read-only dependency cache | build, typecheck, lint, tests, reproducers; the brokered `read_file` / `run` the agents call | secrets, the host filesystem, `~/.copse`, other repositories, any network beyond the allowlist |

The agent loops live in the orchestrator and their tools are **brokered** into the cell over
a narrow RPC — the shape `src/main/project-sandbox/sandbox-fs-server.ts` already has for
filesystem reads. That placement is the whole point. If the loop ran inside the cell it would
need the provider key inside the cell, which is exactly the CodeRabbit leak path: a
repo-controlled `.rubocop.yml` executed Ruby with the production environment in scope, and
the GitHub App private key went with it. Everything that comes back from the cell — exit
codes, capped logs, JUnit, a reproducer test file — is untrusted input to the orchestrator:
size-capped, never evaluated, wrapped by `packages/agent/src/external-content.ts` before a
model sees it.

**What "sensitive data" means**, so the rule is checkable: model-provider keys; forge
credentials (App private keys, installation tokens, `GITHUB_TOKEN`, PATs); the profile under
`~/.copse` (settings, threads, memories, the knowledge store); SSH keys, git credential
helpers, cloud credentials, keychains; any other repository on the machine; the environment
at large; and, if this ever runs hosted, any other tenant's review. The
diff itself is scrubbed before it reaches a model — `packages/llm/src/redact-secrets.ts`
plus the repo's `.gitleaks.toml` rules run over every review input — because a secret
committed in the PR is still a secret.

**Cell capabilities** — the checklist a backend must satisfy to be called supported:

- **Filesystem:** its own checkouts and scratch only. No home directory, no host mounts.
- **Secrets:** none; environment scrubbed. Dependencies come from a pre-populated,
  read-only, content-addressed cache. If a registry must be reached, it is through the
  broker with a scoped, read-only, short-lived credential — never a raw token in `env`.
- **Network:** default deny. Allowlist at most package registries. Never model providers,
  never the forge, never host loopback, never cloud instance metadata or private ranges.
- **Process:** CPU, memory, disk and wall-clock limits; no privileged operations; no
  container socket.
- **Output:** structured results only, capped. The reproducer test file is the one artefact
  kept, and it is stored orchestrator-side.
- **Lifetime:** created per review, destroyed after. Nothing inside a cell survives to the
  next review, so a poisoned cache or a planted binary has nothing to persist on.

**Trust × isolation policy.** Two facts decide whether execution happens at all:

|                                        | Isolation available                                                                  | No isolation                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **Own diff** (the user's working tree) | Execute.                                                                             | Execute only with explicit per-run consent, mirroring the shell gate's "no sandbox, so prompt" rule. |
| **Foreign diff** (a contributor's PR)  | Execute in a container or VM only (B3); the process-scoped OS sandbox is not enough. | **Never execute.** Degrade to read-only lenses plus the challenger pass, and say so in the report.   |

An OS sandbox (macOS ASRT, Linux bubblewrap) and an ephemeral container or VM are not the
same strength. The process-scoped sandbox is sufficient for reviewing one's own changes,
where the "attacker" already has a shell on the machine; a foreign diff gets a throwaway
container or VM. B3 settles the one sub-question B1 left open: the OS sandbox is never
enough for a foreign diff, and it ships first because own-tree review is Phase 0's whole
scope.

**Backend per shell.**

- **App:** `src/main/project-sandbox/` as it exists — ASRT on macOS, bubblewrap on Linux.
  Per [`../shell-permissions.md`](../shell-permissions.md) there is no containment on
  Windows or when the sandbox fails to start, so there the reviewer does not execute. For
  foreign diffs the per-thread container runtime proposed in
  [`unattended-runs.md`](unattended-runs.md) and
  [`copse-cloud-workspaces.md`](copse-cloud-workspaces.md) C1 (the local-docker provider)
  is the backend; the reviewer is a consumer of that runtime, not a second implementation.
- **CLI:** an `IsolationBackend` abstraction from day one — the OS sandbox first (B3), then
  Docker/Podman or a microVM — detected at start. With none present the CLI runs the
  read-only pipeline and prints why. Since Phase 4 the container backend
  (`container-backend.ts`, Docker or Podman over a pinned image, never pulled) is what a
  `--foreign` diff executes in; without it the CLI reviews a foreign diff read-only and
  says so. There is no flag that executes a foreign diff unisolated.
- **CI:** a GitHub-hosted runner is ephemeral but not secret-free, so the workflow has two
  privilege domains. A `pull_request_target:labeled` dispatcher, loaded from the trusted default
  branch, resolves PR metadata and dispatches grounding; it checks out and executes nothing.
  **Job A** is a separate `workflow_dispatch` run on a fresh runner with `permissions: {}` and
  no secrets; it fetches the exact resolved head, runs Stage 0, and uploads
  results as an artefact. A fresh handoff job, which checks out and consumes nothing, gets
  only Actions-dispatch permission after Job A succeeds and explicitly dispatches **Job B**.
  Repeated reviews may reuse a clean Job A report less than 24 hours old for the identical
  head and merge-base. A separate trusted read-only lookup verifies GitHub producer identity,
  successful completion, complete check coverage, and unchanged trusted runner/dependency
  inputs. The source checkout is pinned to the producer's workflow SHA. Lookup failures or
  uncertain reports fall back to a fresh Job A; `fresh=true` forces it. The handoff names the
  original producer run, and Job B still validates its metadata and the current PR. Ordinary
  merge-commit CI results are not treated as exact-head grounding.
  Job B runs on the base ref. Before receiving model or App credentials it builds a trusted
  validation image and primes a read-only dependency store from the exact head lockfile. Its
  trusted model process holds the credentials; brokered focused commands and reproducers run
  only in that read-only-root, capability-free, network-disabled container, whose environment
  is allowlisted and secret-free. Job B then posts findings. Self-hosted Forgejo runners must
  be ephemeral (a fresh container per job):
  a persistent runner is precisely what a malicious PR would persist on.

**Conformance test, in Phase 0.** A review of a deliberately hostile fixture — a
`postinstall` that reads the environment and tries to exfiltrate it, a repo-controlled linter
config that executes code, a test that reads `~/.copse`, and a README carrying an instruction
aimed at the agent (the pattern already in `benchmarks/steer/fixtures/injection-project/`) —
run with canary secrets in the orchestrator's environment. Pass criteria: no canary appears in
any cell output, model request or finding; no egress from the cell beyond the allowlist; the
README's instruction produced no tool call. This runs in CI for every backend and is the gate
on calling a backend supported. CI's `review-cell` job builds `Dockerfile.cell` and opts the
real container backend into that fixture whenever reviewer-cell inputs change and on the nightly
run; it also proves the caller-trusted preparation script is an exact read-only file mount.

### Configuration

A repo-owned `review.config.*` (or a `[review]` block in an existing config) declaring:
commands for build/typecheck/lint/test; lenses to run and their severity floors;
model selections by role (reviewer / challenger), expressed as `dynamic-model` rules so
the config does not rot as models change; path-scoped rules ("`src/main/**` is
security-sensitive, `docs/**` is not"); and the output cap. Repo-owned so a project can
teach the reviewer its conventions — which is the difference between a tool people adopt
and a tool people mute.

## Binding decisions (B)

Changing one of these requires updating this document in the same change — the convention
[`execution-runtime-security.md`](execution-runtime-security.md) uses.

1. **B1 — Execution is isolated and ephemeral; agents never touch sensitive data.** Every stage
   that runs the code under review does so in an OS sandbox or an ephemeral container/VM
   created for that review, with no secrets, no host filesystem, and no network beyond an
   allowlist. The reviewer agents run outside that cell and reach it only through brokered
   tools. Where no isolation exists, a foreign diff is never executed. Recorded 2026-09-03;
   design in §Execution isolation.
2. **B2 — A workspace package from day one.** `@copse/review` is an Electron-free workspace
   package from its first commit, consumed by Copse; never a module under `src/main` that
   is extracted later. Recorded 2026-09-04; settles D2.
3. **B3 — OS sandbox first, container later.** Phase 0 ships on the existing
   `src/main/project-sandbox/` backend (macOS ASRT, Linux bubblewrap) and reviews only the
   user's own working tree. The container/VM backend arrives later in the plan, and
   foreign-diff review — and therefore the CI shell — waits for it. A foreign diff requires
   a container or VM, never the process-scoped OS sandbox alone. Recorded 2026-09-04; closes
   the sub-question B1 left open.
4. **B4 — Bugs and regressions first.** Findings are limited to the `build`, `type`, `test`,
   `contract`, `security`, `concurrency`, `resource` and `api-compat` classes. No PR
   summaries, no style, and the `docs` class and lens are deferred until precision is
   measured on the narrow set. Recorded 2026-09-04; answers Q4.
5. **B5 — TypeScript with pnpm is the only ecosystem for now.** Stage 0's build and test
   detection targets TypeScript/pnpm repositories only; other ecosystems are unscheduled
   until there is a consumer for them. Recorded 2026-09-04; answers Q16.
6. **B6 — OSS maintainers are the main consumer; Copse dogfoods first.** The CLI is the
   first shell, the first deployment is this repository's own PRs, and the local-model path
   must carry the reviewer lens. Recorded 2026-09-04; answers Q1.
7. **B7 — The name is Copse Reviewer.** The product name on the CLI, the app card and the
   CI bot. The package stays `@copse/review` and the plugin id `copse.review`, so nothing in
   B2 moves. Renaming is cheap until something ships, so the name is not revisited before
   Phase 1. Recorded 2026-09-04; settles D1.
8. **B8 — The precision aim is 85%, provisional until measured.** 85% precision on surfaced
   findings, on Martian's offline track, is the bar for any public claim. That track uses 50
   real pull requests and 173 golden comments with semantic judging; Greptile's published
   76.2% is from Martian's **online** track and is not an offline comparator. Nobody has
   measured this pipeline on the offline track. Until that run exists the bar is the
   qualitative one in §The quality bar: no finding reaches a human without evidence.
   Recorded 2026-09-04; answers Q5. _Amended 2026-09-22 (Phase 5 audit):_ a regression
   baseline never proves an absolute claim. `--target-gate` accepts real-model runs only
   and requires point precision ≥85%, the Wilson lower edge of a two-sided 95% interval
   ≥85%, recall ≥50%, and zero duplicates. The seven-case synthetic corpus is a smoke/trend
   suite: its mock profile scores 85.7% by construction with a 48.7% Wilson lower bound, and
   even 5/5 would fail the confidence condition. B8 remains unmeasured until the Martian
   offline set is mapped and run.
9. **B9 — SARIF is the interchange export.** The findings JSON (P2) stays the canonical
   contract; the CLI and the CI shell also emit SARIF 2.1.0, carrying the finding identity in
   `partialFingerprints` and the evidence, provenance and verdict in each result's
   `properties` bag. Two consumers come free: GitHub code scanning, which this repository
   already feeds from CodeQL, and reviewdog, which re-posts SARIF as review comments on
   GitHub, GitLab, Bitbucket, Gerrit and Gitea; Forgejo is Gitea-API-compatible but not
   documented there, so that one is an inference. Alternatives considered and held back:
   reviewdog's own rdjson, only if the SARIF route proves lossy; GitLab's Code Quality
   report, only if a GitLab consumer appears; GitHub workflow-command annotations, capped
   at ten per step and not persisted, so a fallback at most. Recorded 2026-09-04; answers
   Q15.

## What needs to be solved (P)

Ordered by how likely each is to sink the thing.

1. **P1 — Executing untrusted code — decided.** Binding decision B1 and §Execution isolation
   settle the policy: Stages 0, 2 and 4 run in an ephemeral, secret-free cell, the agents
   are brokered in, and a foreign diff without isolation is never executed. B3 sequences
   the backends (OS sandbox first, container later) and settles that a foreign diff needs
   a container or VM. What stays open underneath: how the CLI detects its backend; the
   read-only dependency cache, since "the build cannot fetch" is the common case once the
   network is closed; and the Forgejo self-hosted runner story, which we cannot enforce
   and must document as a requirement.
2. **P2 — Finding identity.** Clustering across reviewers, and stability across pushes and
   rebases. Naive string similarity will both over- and under-merge. Anchoring to content
   hashes plus overlapping ranges is the starting proposal; it needs a real corpus to
   tune against, and it is the crux of both Stage 3 and suppression.
3. **P3 — Cost and latency.** N models × M lenses × verification is easily 20× a current
   review. Needs: a declared budget, staged escalation (cheap broad pass → expensive
   verification on survivors only), caching keyed on `(base, head, config)`, and honest
   reporting of spend. The existing per-model usage accounting and
   `estimateUsageCost` give the accounting; the policy is missing.
4. **P4 — Verification when there is nothing to run.** Many repos have no tests, or a suite
   that takes forty minutes. Define the degradation ladder explicitly — full run →
   changed-package subset → single reproducing test → adversarial challenge only → declare
   the finding unverified and say so — and make which rung was reached visible in the
   output. Binding decision B1 adds a rung above all of these: with no isolation backend, a
   foreign diff never reaches the first one.
5. **P5 — Correlated model error.** Two models from one family agree on one hallucination.
   Agreement is only evidence if the reviewers are actually independent. Needs a stated
   position on which diversity axes count (family ≫ size ≫ sampling), and a challenger
   role that is scored on refutations rather than agreements.
6. **P6 — Measurement.** Without a precision number this degrades into noise within a quarter,
   and nobody will notice which change did it. Needs a `bench:review` harness on a corpus
   of PRs with known outcomes, following the pattern in
   [`industry-benchmarks.md`](industry-benchmarks.md), reporting precision on surfaced
   findings (primary), reproducer rate, and cost per confirmed finding. **Precision is the
   metric. Recall is explicitly not.**
7. **P7 — Prompt injection from the diff.** The reviewer reads attacker-controlled source and
   comments and then acts on them. `packages/agent/src/external-content.ts` exists; it
   must wrap every review input, and a finding must never be able to instruct the pipeline.
8. **P8 — Suppression that isn't annoying.** Dismissed findings must stay dismissed across
   pushes without also hiding a genuinely new problem at the same location. Depends
   entirely on (2).
9. **P9 — Where the gesture lives in the app.** "Review" in the Changes view is the proposal;
   it needs a design pass against [`../ui-taste.md`](../ui-taste.md) and, per
   [`../../AGENTS.md`](../../AGENTS.md), visual evidence.

## What Phase 0 delivered

On `main` under `packages/review/` (README there), with the app-side adapter under
`src/main/services/review/` and the dogfood entry `scripts/run-review-stage0.mts`:

- **The finding schema** (`finding.ts`), as zod, with the content-derived identity of P2's
  starting proposal: SHA-256 of class, path, the normalised anchored source and the
  normalised claim — never a line number.
- **Stage 0** (`stage0.ts`, `checkouts.ts`, `project-commands.ts`, `tsc-diagnostics.ts`).
  Decisions made while building it, recorded so the next phase does not re-derive them:
  - **Head runs first; base runs only for the checks that failed on head.** A passing
    head check can produce no finding, so the clean case costs one pass, not two. The
    "fixed" verdict is therefore only ever observed incidentally. Stage 4 separately
    prepares dependencies and build output on base before its first reproducer, reusing
    successful Stage 0 work. Preparation failure leaves the finding unverified.
  - **A lint regression is a failed check, never a finding.** The Stage 0 text above
    lists `lint` beside `build` and `type`, and B4's class list does not include it; B4
    is binding, and §The quality bar already says a lint failure "is a lint failure, not
    a finding". The report shows it as `lint ✗ regressed`.
  - **The default `prepare` is `pnpm install --frozen-lockfile --offline --ignore-scripts`**,
    with pnpm's content-addressed store passed in read-only. `--ignore-scripts` because a
    repo-controlled `postinstall` is the CodeRabbit incident; a repository whose native
    modules need their build step says so in `review.config.json`. The host's pnpm store
    and corepack cache are mounted read-only and corepack is pinned offline
    (`COREPACK_ENABLE_NETWORK=0`), since a cell with its own `HOME` would otherwise try to
    download the pinned package manager. This is P1's "read-only dependency cache" in its
    simplest form; a registry allowlist stays open.
    The CLI discovers the store using filesystem paths and environment settings only;
    it never runs `pnpm store path`, which can execute a repository's `.pnpmfile.cjs`
    before consent. A store configured only in `.npmrc` needs `--store`.
    CI can supply `--trusted-prepare <script>` from its reviewed default-branch checkout;
    that command replaces only checkout preparation and the script is mounted read-only
    in container cells. Copse uses this to selectively rebuild `node-pty` for old pull-request
    heads without enabling arbitrary lifecycle scripts. A checkout records the exact untracked
    files copied from the author's tree; later context generation marks only those intent-to-add,
    so cell infrastructure created inside the checkout cannot leak into the model's diff.
  - **`review.config.json`** is the §Configuration file, Phase 0 subset: an argv per
    command, `null` to disable one, and per-command timeouts. It is repo-controlled, so
    its argv only ever runs inside the cell; the orchestrator reads it as data.
  - **A `tsc` regression is one finding per new diagnostic**, keyed on path, code and
    message (not line), anchored at the file and line. Build and test regressions are one
    finding per check, anchored at the script line in `package.json`, until Phase 2's
    reproducers give them a finer anchor.
  - **A timeout claims nothing.** A check that timed out on head is `undetermined` and
    listed under "not checked", never a finding.
  - **The repository's git common directory is readable in the cell**, read-only, so a
    build that stamps the commit or a test that shells out to git works. Both checkouts
    are detached worktrees of it.
- **The `IsolationBackend` contract** (`isolation.ts`) with `decideExecution`, the
  trust × isolation table as a function, tested exhaustively. Two backends: the
  **host process** with a scrubbed environment (strength `none`, so own diffs with
  consent only), and the app's **OS sandbox** (`os-sandbox-backend.ts`, strength
  `os-sandbox`), which spawns ASRT's wrapped argv itself rather than through
  `spawnInProjectSandbox` because that path layers the app's own environment underneath
  the caller's, and a review cell's environment must be exactly the allowlist.
  The OS overlay denies host reads by default, then allows declared cell paths, read-only
  mounts and installed system/toolchain resources. Scratch paths are canonical so macOS
  temporary-directory aliases do not need broader access. A live seatbelt test checks
  permitted reads and execution against an outside canary.
  Cancellation reaches Stage 0 and every command, kills the process group and waits for
  command closure before removing scratch. On POSIX, a leader's normal exit also kills
  remaining descendants in its process group; background commands cannot outlive it.
- **The conformance test** (`hostile-fixture.test.ts`): a hostile repository — a prepare
  step that dumps its environment, a build that reads `$HOME/.copse` and the
  orchestrator's secrets file, a test that writes outside the cell, a README aimed at an
  agent — reviewed with canary secrets in the orchestrator's environment. Each declared
  capability is checked against what the fixture managed. The README criterion is
  vacuous until Stage 2 puts a model in the loop and is re-armed then.
- **Secret scrubbing** of every retained output through `@copse/llm`'s `redactSecrets`,
  with every environment value the allowlist dropped passed as a literal secret — a
  second line behind the backend's wall, not a substitute for it.

Not in Phase 0, by design: any model call, the CLI shell and SARIF (Phase 1), the app
gesture (Phase 3), and the container backend that a foreign diff needs (Phase 4). Outside
the app there is no OS sandbox, so `pnpm run review:stage0` needs `--allow-unisolated`.

### Groundwork evidence limits (2026-09-24)

A successful aggregate check attests only that command. Unit/component results do not establish
browser geometry, Electron, screenshot, or manual visual coverage. The reviewer system message
states that boundary explicitly and treats an unspecified test command's tier as unknown.

Two red exit codes cannot establish that failures are pre-existing. Stage 0 compares complete
individual failure inventories for Node tests. Copse opts in through `review.config.json` and
`run-tests --review-report`: a compact reporter emits the full failing file/name set only after
Node's final summary, with no cancelled tests, consistent counts and unique identities. It excludes
parent-suite failures, and normalizes per-run bundle roots and ignores source line movement.
Stage 0 reads the inventory as untrusted data, preserves it in the report and mints one finding
per new failing identity. It never says a new test passed on base, only that it was absent from the
base failure inventory. Missing/ambiguous inventories or other doubly-failing check kinds remain
`undetermined`, with a coverage gap. Imported legacy reports without individual inventories are
downgraded the same way. Renamed tests can appear as new failures; the report preserves
both command outputs for inspection. This is failure identity comparison, not proof of causal blame.

The reporter executes only where the test command already executes (inside the cell for foreign
reviews). No repository output or test names are promoted into trusted system instructions.

## What Phase 1 delivered

The CLI shell (Shell A), on `main` in the same package, as `copse-review` (the package's
`bin`; `pnpm run review` in this repository). Decisions made while building it:

- **Candidates arrive through a tool, not prose.** The reviewer reports each defect with
  `report_finding`, whose arguments are validated against the finding vocabulary and
  anchored to real lines at report time (the tool reads the anchored source and rejects an
  out-of-range anchor), so Problem 3 never re-enters through the model's output. Stage 5
  mints the content-derived id from that anchored source. The reviewer must then call
  `finish_review` exactly once with what it checked and could not verify; the final call can
  carry any defects the model did not emit incrementally, with the same validation and
  anchoring. When a provider instead ends in a prose draft, the runner gives it one bounded
  continuation over the same transcript with only that strict closure tool available. If
  the correction still omits the attestation, the run fails closed and retains the original
  draft for diagnosis, so an exhausted or interrupted model can never be projected as “No
  findings.” The investigation loop does not spend the shared runner's generic prose-finalizer
  headroom: those calls are reserved for the forced structured correction, whose reasoning is
  capped to one checkpoint because it may encode but must not re-investigate the conclusion.
- **The reviewer's tools are brokered, not the loop.** Ordinary reads are served over the head
  checkout as data, jailed to it. Host-side reads and reproducer writes reject symlinks
  below the canonical checkout root, and final file opens use `O_NOFOLLOW`; recursive
  searches skip symlinks. Installed dependency files use a separate fixed, data-only reader in
  the serialised secret-free cell: it accepts package-relative paths (with an optional
  `node_modules/` prefix), resolves pnpm links,
  requires the canonical regular file to remain inside the disposable `node_modules`, and never runs
  package code. `run_command` is the only model-controlled executing tool: it runs argv
  (never a shell string) in the cell, is gated by the run's permission profile, and its
  output comes back secret-scrubbed and wrapped as external content (P7).
- **Headless conformance.** The model turn is projected onto the headless contract's event
  envelope live (`--events`), validated against the schema; permissions come from a
  declared profile derived from `CI_DENY_BY_DEFAULT_PROFILE` with shell allowed only when
  the execution decision allowed it, resolved non-interactively so `ask` fails closed; exit
  codes are the contract's, with a refused execution reported as `APPROVAL_REQUIRED`.
  The CLI does not consume `headlessRunRequestSchema` on stdin: its request is the
  repository and the base ref, not a prompt. That reading is recorded here rather than
  forced.
- **Per-file diff budgeting** replaces the flat 12k truncation: lockfiles, generated files,
  build output and binaries are dropped (and listed). Remaining files receive a minimum
  useful share only while the total budget permits it, then divide the remaining budget
  proportionally. Truncation notices count toward the cap. `git_diff` pages the complete
  per-file diff by character offset, including deleted files and changes omitted from
  the initial context. Git text conversions and external diff helpers are disabled.
- **Ranking** is severity × confidence, plus a bonus for executable evidence and a confirmed
  verdict, minus a penalty for a finding one reviewer raised, nobody corroborated and
  nothing verified; refuted findings never reach the list; seven are surfaced and the rest
  go to the appendix. Merging is by identical id or same class on overlapping lines — a
  stand-in for Phase 2's clustering, not the answer to P2.
- **Provider-agnostic by construction.** `--provider` selects among Anthropic, OpenAI,
  OpenRouter, LM Studio and any OpenAI-compatible endpoint through `@copse/llm`'s
  factories; keys come from the environment only; remote providers are wrapped in secret
  redaction. `--provider mock` plays a scripted reviewer, which is how the pipeline is
  tested end to end without a model.
- **The bin is a one-line shim** over the TypeScript source, which Node strips on load.
  Flags work directly and with the optional separator forwarded by `pnpm run review --`.
  Publishing to npm needs a bundle step; nothing in this repository publishes yet, so that
  is left with D4.

Not in Phase 1: any second model or lens, clustering, the challenger, reproducers (Phase 2),
the app gesture (Phase 3), the container backend and CI action (Phase 4), and the
`bench:review` precision measurement (Phase 5) — so B8's 85% is still unmeasured.

## What Phase 2 delivered

Fan-out, clustering and verification, in the same package and CLI. Decisions made while
building it:

- **Six lenses, all inside B4.** `correctness` (the default), `contracts`, `boundaries`,
  `tests`, `security` and `concurrency`; `boundaries` independently audits semantic fields,
  defaults and downstream fallbacks on new producers. `--lenses all` runs every one,
  `--model` repeats to fan out across models, and `--concurrency` bounds how many reviewers
  run at once. The `docs` lens
  waits with the `docs` class.
- **One serialised cell, not per-reviewer worktrees.** Reviewers fan out over one head
  checkout and one cell whose commands run one at a time, so two test runs never trample
  one working directory. The plan's per-reviewer worktrees for writers stay the design;
  the only writer today is the reproducer, which writes one file under `.copse-review/`
  and is run alone.
- **Clustering (Stage 3, P2's starting proposal).** Two candidates are one finding when
  their anchors overlap within three lines of slack, the class matches, and either the
  Jaccard similarity of their content words (stopwords out, crude suffix stemming) is at
  least 0.34 or at least four words overlap and cover 45% of the shorter claim. The
  containment fallback was added after a real-model smoke run emitted concise and expanded
  versions of the same pagination defect whose Jaccard score was only 0.28. The first member
  keeps its identity and claim, its anchor widens to cover the cluster, later raisers become
  corroborators, and their command evidence is carried along. The thresholds are exported
  constants and the scorer also refuses to count repeated hits on one truth defect twice.
- **Verification (Stage 4) by class.** `test`, `contract` and `concurrency` go to a
  reproducer model first: it writes one test under `.copse-review/` and names the argv;
  the orchestrator runs it on head, copies it to base, runs it there, removes it from base,
  and records whether the exit codes differ. Every finding then goes to the challenger,
  including successful differentials: opposite exits alone are not behavioral proof.
  A differential requires an explicit `reproducerAssessment` (`valid`, `invalid`, or
  `undetermined`) explaining the behavior exercised on **both** revisions and why head's
  assertion failure proves the claim. Source-text checks, skipped base scenarios, absent
  APIs, setup errors and unrelated failures do not qualify. Only a completed `stands`
  verdict with a `valid` audit of a differential upgrades to `confirmed` and retains its
  artefact in the report. A plausible claim with invalid or missing proof stays unverified;
  without a challenger a differential also stays unverified. `refuted` drops the finding
  (retained in the report's `refuted` list); other `stands` verdicts record a survived
  challenge; `undetermined` leaves the finding as it was. The audit is model judgment,
  not a guarantee, and can add one bounded challenger turn per successful differential.
  Review closure also rejects mapping multiple reported suspicions to the same finding
  index; duplicate suspicions must use an explicit `duplicate` disposition, explain the duplication,
  and reference the finding index resolved by a `reported` suspicion.
- **Budget (P3's staged escalation, first rung).** Verification is spent only on
  unverified survivors of Stage 3, most promising first by rank score, up to
  `--max-verify` (default 10); the rest are reported as skipped. `--no-verify` skips the
  stage. The challenger and reproducer default to the first `--model` and can be a
  different model via `--challenger` (P5's cross-family diversity is a flag, not yet a
  measured claim).
- **Ranking** gains a bonus for a survived challenge, and the lone-unverified penalty no
  longer applies to a finding that survived one.
- **The comparison judge is not retired here.** The plan schedules it for Phase 2, but the
  judge is the only thing the app's comparison card summarises with, and removing it
  before Phase 3's findings card would leave the card with two prose reviews and nothing
  between them. It goes when Phase 3 replaces the pack; the per-finding verdicts that
  replace it now exist.

Not in Phase 2: any model in the app, the app gesture (Phase 3), the container backend and
CI action (Phase 4), and the precision measurement (Phase 5) — B8's 85% is still
unmeasured, and the clustering thresholds above are the first thing that measurement
should move.

## What Phase 3 delivered

On `main`: the `copse.review` first-party plugin (`packages/agent/src/plugins/review-plugin.ts`),
the app-side review service (`src/main/services/review/review-service.ts`, with
`review-dismissals.ts` beside the OS-sandbox backend), the findings card
(`src/renderer/views/review-findings-card.ts`) and the Changes-view gesture
(`git-changes-pane.ts`). The `copse.model-comparison` plugin, its judge, its runner, the
`compare_models` tool, the picker dialog and the `model-compare` approval type are deleted.

- **One pipeline, three gestures.** "Review" in the Changes header, the "Review changes"
  follow-up bubble (action `review`, offered on `workspace-changes`) and the agent's
  `review_changes` tool all run `runThreadReview` over the thread's execution-context
  root: the base resolves to `HEAD` for a dirty tree (the change is what is not committed
  yet) and to the base branch for a clean one, so committed branch work still gets a
  review; a clean tree on the base reports "nothing to review" rather than an error. The
  human gestures are their own spend decision and never prompt; the tool prompts for a
  billable model, remembered per thread, exactly as the post-turn review does.
- **Execution in the app follows the trust table with no consent path.** Behind the OS
  sandbox (`createOsSandboxBackend`) Stage 0 runs and the reviewer has `run_command`;
  without it the ground opens **read-only** — a new `readOnlyCheckouts` option on
  `openReviewGround` materialises base and head with no cell — so the model stages still
  run over the checkouts, and the card says "Read-only review — nothing was executed" and
  why. `--allow-unisolated` stays a CLI flag; the app never runs the user's tree unisolated.
- **The typed chunk (decision 15).** `review_report` carries `ThreadReviewReport` — the
  package report projected for a card: findings flattened with their anchored source, the
  Stage 0 checks and coverage notes, the execution decision, reviewer turns, verification
  counts, cost — as a running placeholder, then the report or an error. It is persisted on
  the thread as `reviewReport` (metadata, like the retired `comparison`) and rendered from
  that data alone, so a report keeps rendering after the plugin is disabled (decision 17).
  No review starts a machine turn, so decision 5's budget is untouched.
- **The findings card.** Ranked rows — severity, class, `path:line`, the claim, the
  verdict ("confirmed by reproducer", "survived challenge", "unverified") — each a
  disclosure onto the verdict's reason, the anchored lines, the evidence (a command with
  its target, exit and excerpt; a reproducer with its head/base outcome; a citation) and
  who raised, corroborated or challenged it. Stage 0's checks are chips above the list;
  the appendix and refuted counts sit below it. "Clean." is a complete answer.
- **Dismissal persisted (P8).** Dismiss writes one `review-dismissal` knowledge note per
  finding, keyed by the finding's content-derived id, so it stays dismissed across pushes
  for as long as the anchored source and the claim hold — and lapses by itself when the
  code or the claim at that spot changes, which is the P8 balance. The next review marks
  those ids dismissed; the card folds them behind an "n dismissed" toggle with Restore.
- **The judge is retired.** Per-finding verdicts (Stage 4) are the only synthesis. A thread
  that still carries a `comparison` renders its old card, dismissible and never
  re-runnable; the `model_comparison` chunk, the retry and the auto-on-review trigger are
  gone with the runner.
- **Plugin settings and migration.** `reviewerModel` (blank = the chat model),
  `challengerModel` (default: the most-capable rule), `lenses` (`correctness` or `all`)
  and `verify`. A one-shot host migration carries an existing profile's comparison
  enablement across (on stays on, off stays off, the retired id leaves the list) and seeds
  the reviewer and challenger from reviewer A and the judge when the new bag is empty.
- **Visual evidence.** `tests/e2e/review-findings-card.e2e.ts` (the card, expansion,
  dismissal through main's knowledge store, persistence across a restart) and
  `tests/e2e/git-changes-review-button.e2e.ts` (the button present only while the plugin is
  enabled), plus component tests for the card, the inline placement and the actions.

Not in Phase 3: a container backend and foreign diffs (Phase 4), the CI action (Phase 4),
`bench:review` (Phase 5), and the per-finding inline anchor in the Changes view's diff
(the card links by `path:line`; jumping the diff editor to it is a follow-up).

## What Phase 4 delivered

On `main`: the container backend (`packages/review/src/container-backend.ts`), its app
adapter over the thread-in-container runtime (`src/main/services/review/container-backend.ts`),
foreign-diff review in the CLI (`--head`, `--foreign`, `--backend`), the two hand-offs the
CI shell needs (`stage0-report.ts`, `forge-review.ts`) and the workflows
(`.github/workflows/review-ground.yml`, `review-findings.yml`, `.forgejo/workflows/review.yml`).

- **One container per command.** The backend runs every cell command in its own
  throwaway container from a pinned image with the hardening the thread-in-container
  runtime settled on (read-only root, every capability dropped, no new privileges, pid /
  memory / cpu limits, an exec-able private `/tmp`) and **no network interface at all**.
  The two checkouts and the scratch directory are bind-mounted read-write at their host
  paths, the declared read-only paths (dependency store, corepack cache, the repository's
  git directory) read-only at theirs, so an argv, a cwd, `npm_config_store_dir` and a
  reproducer's relative path mean the same on both sides and the orchestrator's reads of
  head see what the cell wrote. The host `PATH` is dropped for the image's; `HOME` and
  `TMPDIR` live in scratch. A timed-out or cancelled command is ended by `<engine> kill`,
  which takes everything it forked. Every wall the capabilities declare is a flag pinned
  by a unit test; the plumbing is exercised over a fake engine that runs the argv on the
  host, and the real engine by the hostile-fixture conformance test behind
  `COPSE_REVIEW_CONTAINER_E2E=1` (a daemon and the image required). Not a second runtime:
  the image is never pulled or built here, and the app adapter reuses the runtime's image,
  fingerprint check (a stale image is never run), daemon probe, container name and labels,
  so its orphan sweep covers review cells too.
- **The app's backend order.** OS sandbox for the author's own tree (enough per B3, and
  lighter); the container where no OS sandbox is active but Docker is; read-only review
  where neither is. There is still no consent path in the app.
- **Foreign diffs.** `materialiseCheckouts` takes a `headRef`; another ref is reviewed as
  committed and the working tree is never overlaid on it. `--foreign` declares the diff a
  contributor's: `decideExecution` lets it run only at container strength, `auto` looks
  for the container (`--image`, default the app's worker image) and, finding none, the
  pipeline degrades to read-only lenses plus the challenger pass and says so — the trust
  table's bottom-right cell. `--allow-unisolated` is not consent for a foreign diff (B3).
- **The runner as the cell.** `--backend ephemeral-runner` is the host-process backend
  declared at container strength for the one place that is true: a CI job created for one
  run, holding no secrets, discarded after. It is an assertion the caller makes about
  where it runs, never a detection, and the conformance test holds it to what it
  guarantees inside the process (a scrubbed environment, `HOME` and `TMPDIR` in the cell).
  "Holding no secrets" is not the whole of it: the job still carries an Actions runtime
  token (which `permissions: {}` does not remove) into the later steps the runner user
  executes, and that user owns those actions and has sudo. The CI shell therefore runs the
  CLI as a separate unprivileged user that cannot reach the runner's home
  (`packages/review/ci/ground-as-cell-user.sh`), and kills everything that user owns before
  the upload step.
- **The CI shell, in two privilege domains.** `review-ground.yml` uses
  a separate `workflow_dispatch` from `review-trigger.yml`. The trigger uses
  `pull_request_target:labeled`, only for the `copse-review` label, so its definition comes from
  the trusted default branch even when the pull request predates it. (`issues:labeled` does not
  fire for pull requests, while `pull_request:labeled` selects the pull request revision.) The
  target context is deliberately confined to resolving current PR metadata and dispatching the
  ground workflow: it checks out and executes no repository content. Grounding gets the PR
  number, exact head and base in a separate fresh hosted run with `permissions: {}`, no secrets
  and removed checkout credentials. That runner installs
  only the reviewer's workspace subtree with scripts off, runs Stage 0 on the head, and
  uploads the report. Reapplying the label is the explicit retrigger after a new head.
  A separate handoff job runs after grounding on a fresh runner, checks out and downloads
  nothing, and gets only `actions: write`; it explicitly dispatches `review-findings.yml`
  with the trusted inputs and ground run id. This explicit `workflow_dispatch` is required
  because GitHub suppresses the implicit `workflow_run` event after a run that another
  workflow started with `GITHUB_TOKEN`; `workflow_dispatch` is the documented exception that
  always creates a run. The findings workflow runs in the base repository's context with the
  model key. Its ordinary workflow token can only read pull-request metadata and artefacts.
  Before a step receives model or App credentials it builds the reviewed
  `packages/review/Dockerfile.cell`, fetches the resolved refs, and primes pnpm's store from
  the exact head lockfile with lifecycle scripts disabled. After that preparation it mints a
  repository-scoped installation token for the existing Copse release/deploy App with only
  `pull-requests: write`, and passes that token only as the forge posting credential. It
  verifies that the named run is the
  successful default-branch `Copse review ground` run, resolves the current contributor commit
  and base from GitHub's Pull Request API, and never trusts the artefact or a dynamic run
  association. It fetches the head
  to read it and imports the Stage 0 report through `--stage0-json`, which is read-only by
  default and refuses a report for another commit. The workflow explicitly supplies
  `--backend container`: the model loop remains in the trusted host process while
  `run_command` and Stage 4 reproducers execute through the container backend with no network,
  no capabilities, a read-only root, bounded resources and an allowlisted environment that
  excludes every provider, cloud, workflow and forge credential. Imported Stage 0 re-prepares
  the fresh head checkout and build output before reviewers run; base is prepared independently
  before the first reproducer. `--backend ephemeral-runner` is rejected for an imported report,
  so the secret-bearing model host cannot be mislabeled as a cell. The Forgejo
  workflow is the same split as two jobs of one workflow (Forgejo Actions has no
  `workflow_run`), with the secret-holding job gated to same-repository pull requests and
  a note that its runners must be ephemeral.
- **The Stage 0 report is a decoder.** Between the jobs it is an artefact a runner wrote
  after executing the pull request's own code, so `stage0-report.ts` validates every
  shape of it — findings included — before a field reaches a model or a comment.
- **One review on the pull request.** `forge-review.ts` projects a report onto a review
  (`COMMENT`, never a request for changes): each surfaced finding with a line is an inline
  comment on the head commit — its class, severity, confidence, claim, verdict, evidence and
  provenance — and the rest (the ground, what was not checked, findings without a line,
  the appendix and refuted counts) is the body. GitHub anchors by `line`/`side`, Forgejo
  by `new_position`; both refuse a line outside the diff, so a 422 is retried once with
  every inline comment folded into the body rather than lost. `--post-review github|forgejo`
  with `--repo` and `--pr`; the token from `COPSE_REVIEW_FORGE_TOKEN`, else `GITHUB_TOKEN`
  (Forgejo: `FORGEJO_TOKEN` too); a review that could not be posted is exit 1.
- **Copse dogfoods the shell, still as an adviser.** _Added 2026-09-22; Luna rollout 2026-09-24._
  Label-triggered reviews and nightly samples default to `openai/gpt-6-luna` through OpenRouter,
  the correctness lens, at most 12 tool-using steps and at most three challenged findings.
  `COPSE_REVIEW_PR_PROFILE=configured` rolls both paths back to the retained
  `COPSE_REVIEW_PROVIDER`, `COPSE_REVIEW_MODEL`, and `COPSE_REVIEW_BASE_URL` variables
  (the Scaleway `qwen3.8-27b` route). The benchmark profile remains separately selectable.
  A separate schedule samples no more than one recent, unlabelled same-repository pull
  request per night, including drafts; `copse-review-skip` is the opt-out. Both paths run the trusted default-branch CLI,
  preserve the secret-free Stage 0 / container-backed focused-validation boundary, post `COMMENT` reviews
  only, and retain JSON plus SARIF for 30 days. This is explicit remote processing: the
  secret-redacted diff and file context leave the GitHub runner for the selected provider. Human
  accepted/rejected judgements, report latency and token usage are gathered during the
  rollout; making the reviewer required needs a separate decision backed by that record.
  Dogfood acceptance is operational evidence, not the Martian offline measurement B8
  requires for the public 85% precision claim.
- **Streamed rate limits need time to clear.** _Added 2026-09-24 after the Luna rollout._
  Two live attempts exhausted HTTP-200 SSE 429 retries in roughly ten seconds. Recognized
  statusless SDK 429 errors now use 10/20/40-second fallback delays plus up to 10% jitter,
  capped at 60 seconds per delay. Server retry hints retain precedence; the four-attempt
  budget, cancellation, and refusal to replay committed text/tool calls are unchanged.
  Ordinary HTTP and transport errors retain their existing timing. This gives temporary
  throttling a longer recovery window; it does not guarantee upstream availability.
- **The paid PR key excludes external contributors.** _Added 2026-09-24._ Both model jobs
  use `COPSE_REVIEW_OPENROUTER_API_KEY` only from the `copse-review-models` environment;
  there is no fallback to an organization-wide OpenRouter secret. Its exact-main branch
  policy and required reviewer approval remain in place: after grounding, a maintainer
  approves the pending environment deployment before the model runs. Trusted main workflow
  refs and the owner/Actions-bot dispatch identities are checked before a credential-free
  API preflight and again on each model job, including partial reruns. The preflight
  accepts only owner-authored PRs (user ID `338988`) whose head and base both
  belong to this repository (ID `1274237362`). External authors and forks do not enter
  the protected model job, even if a trusted actor dispatches them. The label trigger also
  requires the owner actor; a later live PR check verifies head/base identity again before
  model/App credentials enter a step. Luna drops Scaleway credentials, and rollback drops
  the OpenRouter credential. The key's $25/month cap remains an account-side limit.
- **A bounded clean review names its limits.** _Added 2026-09-23 after live review #2737._
  The required `finish_review` coverage attestation stays structured through Stage 5. Forge
  projections surface every material `couldNotVerify` value and reserve plain “No findings” for
  completed turns that attest `Nothing`; unavailable dependency source or command execution is
  therefore visible instead of being collapsed into a false-clean result.
- **Focused validation in GitHub CI.** _Added 2026-09-23 after live review #2737._ Imported
  Stage 0 remains read-only unless a real container is explicitly requested. Copse's findings
  workflows build that cell before credentials enter a step, then let reviewers run the
  smallest project-supported focused test or probe and let Stage 4 execute head/base
  reproducers. The existing read/search/diff tools remain host-side and jailed to the checkout;
  only argv execution crosses into the cell. The ordinary CI workflow builds the same image and
  runs the hostile-fixture conformance test when this surface changes (and nightly), so a broken
  image, network wall, secret wall or trusted-script mount blocks the aggregate gate. The Forgejo
  example remains read-only until its ephemeral runner contract also guarantees Docker isolation.
- **Dependency source inspection stays inside the cell.** _Added 2026-09-23 after the first
  post-merge validation-evidence run._ pnpm's top-level package entries are checkout symlinks, so
  host-side `read_file` must continue to reject them. `read_dependency_file` instead runs fixed
  trusted reader code in the same serialised, secret-free cell as focused commands, rejects paths
  outside `node_modules/` and canonical targets outside the disposable dependency tree, and does not count
  as executable validation. Reviewers are still instructed to run the smallest relevant focused
  test or probe when executable code changed.
- **Structured closure owns the final call budget.** _Added 2026-09-23 after the first
  dependency-enabled dogfood run._ That run reached the right clean conclusion and read the
  installed dependency, but the generic prose finalizer consumed three more calls and its
  forced repair then terminated before `finish_review`. A review role now spends no LLM calls
  on that generic finalizer: it proceeds directly to the bounded closure-only continuation,
  with a one-checkpoint reasoning ceiling. JSON-encoded argv is decoded back to a validated
  string array, including literal control characters that an OpenAI-compatible model can leave
  inside that nested JSON string, and dependency reads accept the package-relative spelling
  models naturally use; neither tolerance introduces a shell or expands the canonical dependency
  boundary. The first post-merge proof on PR #2737 completed through that reserved closure call,
  read jsdom's installed source, ran the focused 4-test selector plus positive/negative esbuild
  probes, used the explicit Scaleway project endpoint, and posted as the Copse GitHub App.
- **Hosted scratch is semantically ordinary workspace storage.** _Added 2026-09-23 after the
  first focused-validation proof._ GitHub jobs pass `$RUNNER_TEMP` as `--scratch-parent`, keeping
  the disposable checkout, `HOME` and `TMPDIR` away from the literal `/tmp` namespace. Product
  tests that intentionally classify machine-global `/tmp` paths therefore see the same path
  semantics in a review cell as they do in normal CI, instead of producing baseline-only false
  failures.
- **Known limit: the dependency store across platforms.** The cell resolves the offline
  install from the host's pnpm store, which holds the host platform's packages. The GitHub
  ground jobs prime that store from the exact contributor lockfile and patch data with
  `pnpm fetch` in the secret-free job; manifests and lifecycle scripts still run only in
  the isolated cell. On a Linux host (CI, a Linux desktop) the host and guest platforms
  match. On macOS the Linux guest finds no Linux binaries for native packages and the
  prepare step fails, which Stage 0 reports as "not checked" rather than pretending.
  Pointing the cell at the runtime's shared store volume, populated by an installing
  container run, is the follow-up there.

Not in Phase 4: Forgejo focused-validation parity, `bench:review` (Phase 5), and a foreign-diff
gesture in the app (the app reviews the thread's own tree; a "review this pull request"
gesture is a product question for later).

## What Phase 5 delivered

On `main`: the scorer (`packages/review/src/eval.ts`), the harness
(`scripts/bench-review-lib.mts`, `pnpm run bench:review`), the corpus and its baseline
(`benchmarks/review/`, with a README), and the per-PR gate in CI's `bench` job.

- **Precision is the metric, as P6 asks.** A case declares the defects its head carries as
  anchors (path and lines in the head), semantic `claimSignals`, and, where a defect makes
  a Stage 0 check regress, which one; the harness runs the whole pipeline over the case and
  scores only the **surfaced** findings — the appendix and the refuted never reach a human,
  so they never count. An anchored hit needs both an overlapping source range and all of
  the truth's AND-of-OR semantic signal groups. A Stage 0 finding instead hits by the
  declared regression because it anchors at the script that failed, not the defect.
  Equivalent comments form one precision observation and the extras are reported as
  duplicates, so repeated true comments cannot inflate precision, confirmation or
  reproducer counts. Reported beside precision: its Wilson 95% lower bound, recall
  (secondary), duplicate count, reproducer rate, and output tokens per unique confirmed
  finding.
- **The corpus is small and deliberate.** Seven cases, each a two-tree project with a
  `review.config.json` that runs its own test with `node` so Stage 0 needs no install: a
  defect the project's test catches (Stage 0 mints it, a reviewer anchors it, a reproducer
  confirms it); a resource leak no test covers (the challenger is the verdict); a clean
  rename where the mock reviewer's wrong candidate is refuted and dropped; a dropped null
  guard reported by two lenses in different words (one finding after Stage 3, confirmed by
  a reproducer); and a harmless change where a wrong claim the challenger cannot settle
  reaches the human; and two semantic-boundary defects model new image producers that omit
  metadata used by unchanged rendering and trust consumers. The false alarm is deliberate:
  the corpus scores 85.7%, not 100%, so the metric visibly bites, and a change that lets one
  more wrong claim through moves it.
- **Two profiles, one harness.** `--mock` plays each case's `mock.json` through the same
  `ScriptedProvider` the CLI's `--provider mock` uses — deterministic, no model, a few
  seconds — and is the self-test CI runs per PR with `--gate`. A model profile goes through
  the CLI's provider door (`--provider`, `--model` repeatable for an ensemble,
  `--challenger`, keys from the environment). `--no-verify`, `--lenses` and the model list
  are the ablation knobs; `--compare` prints the delta between two summaries, which is how
  Q6 (cross-model ensembling against one model) and "how much does verification buy" are
  read. The manual trusted-default-branch workflow can target one case and a lens set for a
  controlled real-model rerun; every case retains its headless event JSONL beside the report
  so a miss can be diagnosed rather than inferred from its final summary.
- **The ratchet.** `benchmarks/review/baseline.json` is coverage-baseline style. Each entry
  is keyed by evaluator version, provider, reviewer and challenger models, credential-free
  endpoint identity, lenses, verification mode, reviewer and verification budgets, selected
  cases and corpus fingerprint.
  `--gate` fails closed when that exact baseline is absent, when precision drops (the mock
  gets no tolerance, a model profile five points), when true positives fall, when
  duplicates rise, or when tokens per confirmed finding grow past 1.25×;
  `--update-baseline` moves it on purpose. The unit tier runs the corpus too
  (`scripts/bench-review.test.ts`), pinning each case's expected counts, so a pipeline change
  that moves the measurement fails on the PR that makes it.
- **The target is not the ratchet.** `--target-gate` rejects mock profiles and requires
  point precision ≥85%, a two-sided 95% Wilson lower bound ≥85%, recall ≥50%, and no
  duplicates. This is the gate for evidence behind B8; a historical baseline only detects
  regressions and can never substantiate the claim by itself.
- **What is and is not measured.** The mock's 85.7% is a property of the corpus and of the
  pipeline's non-model parts; it says nothing about any reviewer. The corpus is also small
  enough that any model number over it is a smoke figure, not a claim: its five surfaced
  observations give the 85.7% mock score a 48.7% Wilson lower bound, and even a perfect 5/5
  would not pass. Mapping Martian's offline set — or a comparably sized, independently
  labelled real-PR corpus — is the work that makes B8 measurable and is not faked here.

Not in Phase 5: a mapped Martian-offline or equivalent real-PR corpus, and the online track
(Q8). Model-profile baselines remain optional trend records, not claim evidence.

## Phases

- **Phase 0 — Findings schema + Stage 0 + OS-sandbox backend.** ✅ Landed; see above. `@copse/review` as a
  workspace package (B2) with the finding type, the build/test baseline diff for
  TypeScript/pnpm repositories (B5), the `IsolationBackend` abstraction with the existing OS
  sandbox as its first backend (B3), and the hostile-fixture conformance test. No models at
  all; the user's own working tree only. Ships value immediately ("this doesn't compile /
  this test regressed"). Stage 0 _is_ execution, so this is where B1 is proven, before any
  model spend.
- **Phase 1 — CLI shell.** ✅ Landed; see above. `copse review` over a single model, one lens, Stage 0 + 1 + 2 + 5,
  bugs and regressions only (B4), findings JSON and SARIF out (B9). Dogfood on this
  repository's own PRs (B6), reviewing the author's own tree.
- **Phase 2 — Multi-model + verification.** ✅ Landed, except the judge's retirement, which
  moves to Phase 3; see above. Lenses, fan-out, clustering, the challenger
  role, reproducer generation. Retire the comparison judge in favour of per-finding
  verdicts.
- **Phase 3 — App shell.** ✅ Landed; see above. `copse.model-comparison` → `copse.review`;
  findings card; the Changes-view gesture; dismissal persisted; the comparison judge
  retired. This replaced the first-party pack that
  [`hooks-and-feature-packs.md`](hooks-and-feature-packs.md) P5 extracted, so its decisions
  log bound here: decision 15 for the typed chunk the findings card consumes, decision 5 for
  any machine turn a review starts (none does: every review is a human gesture or an agent
  tool call inside an existing turn).
- **Phase 4 — Container backend + foreign diffs + CI shell.** ✅ Landed for GitHub;
  Forgejo focused-validation parity remains. The container `IsolationBackend`, consuming the
  thread-in-container runtime's image and naming in the app (the local-docker provider
  [`copse-cloud-workspaces.md`](copse-cloud-workspaces.md) C1 proposed), which unlocks
  foreign-diff review (B3); then the GitHub workflows with inline comments, opt-in by label,
  and the Forgejo equivalent.
- **Phase 5 — Eval.** ✅ Local harness and gates landed; the external claim corpus remains;
  see above. `bench:review`, an exact-configuration regression ratchet, and a separate
  absolute target gate. Arguably belongs at Phase 2; listed last only because it needs a
  corpus that Phases 1–2 generate.

## Non-goals

- Not a merge gate. Advisory, like Fairy.
- Not a replacement for human review.
- Not a linter or a formatter — it defers to the repo's own.
- Not an autofixer in this plan. `remedy` is a suggested patch a human applies; applying
  it automatically is separate work with a separate risk profile.
- Not a hosted service from us. Local-first, provider-agnostic, runs against a local model.
  If this ever runs hosted, the isolation rules in §Execution isolation already cover the
  other tenants' data.

## Competitive position

Compiled 2026-09-03 and re-checked 2026-09-22 against Martian's benchmark description and
the linked vendor posts. Treat vendor figures as indicative, and keep Martian's online and
offline tracks separate, as [`competitive-landscape.md`](competitive-landscape.md) advises.

Built as designed, the reviewer sits in a gap nobody occupies: general-purpose review where
a finding reaches a human only after execution confirmed it or a refutation pass failed to
kill it. Greptile publishes 76.2% on Martian's online track. B8 deliberately targets the
separate offline track, so that figure gives context but is not the baseline to beat.

**Three groups.**

- **Hosted incumbents** — CodeRabbit, Greptile, Cursor Bugbot, GitHub Copilot, Codex,
  Gemini, Qodo, Anthropic's managed Code Review. All judge without executing. Bugbot runs
  eight parallel passes with majority voting and a validator model, the nearest thing to
  our ensemble, but nothing runs the code. Copilot review now runs on Actions runners yet
  restricts its tool calls to read-only. Codex Security reproduces an issue in a sandbox
  before surfacing it — our Stage 4 exactly — but only for security findings and only on
  their cloud; whether plain Codex review executes is unconfirmed. Anthropic's managed
  review dispatches parallel specialised agents, which is our lenses idea shipped as a
  service at roughly ten times Bugbot's price.
- **Local and self-hosted** — Qodo's PR-Agent is now a community-maintained legacy project;
  the rest is diff-in-a-prompt Actions pointed at Ollama, or Alibaba's rules-plus-LLM
  `open-code-review`. This slot is open, and running a serious pipeline against a local
  model with zero data egress is what Copse already is.
- **Multi-model consensus tools** — Star Chamber, claude-consensus, ensemble. They fan out
  and synthesise with no execution; the commentary around them already argues that
  vote-counting compounds correlated error and refutation is what is needed. That is this
  design, so it is a citable framing rather than a competitor.

One sharp point: [`competitive-landscape.md`](competitive-landscape.md) lists Copse's
two-model comparison as unusual among desktop agents. Against PR reviewers it is commodity.
The same feature is a differentiator in one category and table stakes in the other.

| Axis                      | Field today                                   | This design                                                     |
| ------------------------- | --------------------------------------------- | --------------------------------------------------------------- |
| Verification by execution | Codex Security only, security findings        | Every finding, any class                                        |
| Ensemble                  | Bugbot: 8 passes, one vendor, validator model | Cross-vendor, challenger scored on refutations                  |
| Local model, no egress    | PR-Agent, DIY Actions                         | First-class shell                                               |
| Codebase context          | Greptile's graph, Copilot's agentic explore   | Diff plus neighbourhood; Copse semantic search not yet wired in |
| Learns from dismissals    | CodeRabbit learnings, Bugbot rules            | Suppression only                                                |
| Forges                    | CodeRabbit four, Bugbot GitHub only           | GitHub and Forgejo                                              |
| Setup                     | Two clicks                                    | Isolation backend plus build commands                           |
| Latency                   | Bugbot about 90 s                             | Minutes, bounded by the test suite                              |
| Benchmark presence        | Martian ranks 13–17 tools                     | None                                                            |

Published numbers for context (different tracks, dates and metrics; they are not one
comparable leaderboard):

| Tool                 | Precision       | Recall | F1              | Context                         |
| -------------------- | --------------- | ------ | --------------- | ------------------------------- |
| Greptile, July 2026  | 76.2            | 50.6   | 60.8            | Martian **online**; vendor post |
| Qodo                 | 62.3            | 66.4   | 64.3            | Martian; vendor post            |
| CodeRabbit, Feb 2026 | 49.2            | 53.5   | #1 F1 at launch | Martian; vendor post            |
| Cursor Bugbot        | 70%+ resolution | —      | —               | vendor-specific metric          |
| GitHub Copilot       | 71% actionable  | —      | —               | vendor-specific metric          |

Martian's offline track instead fixes 50 real pull requests and 173 golden comments and
uses a semantic judge. Results from the live online track cannot establish the offline B8
claim, and neither can this repository's seven synthetic cases.

Greptile's online point estimate implies roughly one wrong or ignored comment in four in
that setting; it does not transfer to the offline track. Price floor for context: Gemini
free, GitLab Duo about $0.25 per MR, Bugbot about $1.20 per review, Anthropic managed review
in the tens of dollars.

**Where this design is weaker.** Table stakes it lacks: PR summaries, inline suggested
changes, one-click fix, learnings, four-forge support, two-click install. Cost, because
verification is the expensive stage. Latency, because ninety seconds is unreachable if the
suite runs. Codebase context, where Greptile's graph is a real advantage on large repos. And
the moat is copyable: Copilot already sits on a runner and chose read-only, and that is a
switch they can flip.

### Questions the position raises (Q)

Numbered Q1–Q16 to match the working list; answered ones say so.

**Positioning**

1. **Q1 — Who is the customer?** OSS maintainers with AI policies like FFmpeg's, regulated teams
   that cannot send code out, or Copse users. Each picks a different first shell.
   Recommendation: OSS maintainers and local-first teams — the segment is unoccupied and
   the Fairy lineage is a story. **Decided (B6):** OSS maintainers are the main consumer;
   Copse dogfoods first.
2. **Q2 — Is "only what we proved" the pitch, at the cost of recall?** Recommendation: yes.
   Precision is where the field is weakest and the benchmark rewards it directly.
3. **Q3 — Opt-in per PR or always-on?** Fairy is opt-in; every incumbent is always-on. Opt-in
   risks recreating Problem 1. Overlaps D3.
4. **Q4 — Narrow or broad?** Bugbot proves narrow works commercially. Recommendation: bugs and
   regressions only; defer summaries. **Decided (B4):** bugs and regressions first.

**Proof**

5. **Q5 — What precision makes us credible?** Recommendation: above 85% on Martian's offline
   track before any public claim. The pipeline is open source, so we can run it ourselves.
   **Decided (B8):** 85% is the aim, with the confidence, recall and duplicate conditions
   recorded in B8; the local smoke corpus is not that measurement.
6. **Q6 — Does cross-vendor ensembling beat single-vendor multi-pass?** Unknown and testable;
   the first ablation for `bench:review`.
7. **Q7 — What fraction of findings can execution settle?** If under half, the challenger pass
   is the product and the reproducer is a bonus.
8. **Q8 — How do we get on the online track?** It measures tools deployed on live OSS PRs, so
   distribution precedes measurement.

**Economics**

9. **Q9 — Cost per review and who pays.** Budget cap, staged escalation, and a free Stage 0 tier
   are the levers.
10. **Q10 — Latency target.** What is acceptable for an invited reviewer versus an always-on one?
11. **Q11 — Can a local model carry the reviewer lens**, with a frontier model reserved for the
    challenger? That decides whether local-first is real or marketing.

**Security**

12. **Q12 — The sandbox for untrusted PRs — decided.** Binding decision B1: isolated and
    ephemeral, agents never touch sensitive data. Design in §Execution isolation. The
    CodeRabbit RCE (an unsandboxed RuboCop, a malicious config, the App key, a million
    repositories) is the reference incident.

**Product gaps**

13. **Q13 — Codebase context.** Wire Copse's semantic search into Stage 1, or accept the gap on
    large repos?
14. **Q14 — Learnings.** CodeRabbit-style prompt learning from dismissals, or suppression only?
    Privacy implications for the local-first customer.
15. **Q15 — Interop.** Emit SARIF so findings land in GitHub code scanning and any SAST
    dashboard. Cheap, and no competitor leads with it. **Decided (B9):** SARIF, with the
    alternatives weighed there.
16. **Q16 — Ecosystems.** Stage 0 needs build and test detection per language. FFmpeg is C and
    make; Copse is TypeScript. **Decided (B5):** TypeScript with pnpm only, for now.

Sources: [Martian Code Review Bench](https://codereview.withmartian.com/) ·
[Greptile on Martian](https://www.greptile.com/content-library/greptile-martian-code-review-benchmark) ·
[Qodo on Martian](https://www.qodo.ai/blog/qodo-ranked-1-ai-code-review-tool-in-martians-code-review-benchmark/) ·
[CodeRabbit on Martian](https://www.coderabbit.ai/blog/coderabbit-tops-martian-code-review-benchmark) ·
[Bugbot 2026](https://weavai.app/blog/en/2026/05/12/cursor-bugbot-2026-review-ai-bug-detection-autofix/) ·
[Copilot agentic review](https://github.blog/changelog/2026-03-05-copilot-code-review-now-runs-on-an-agentic-architecture/) ·
[Copilot MCP read-only](https://github.blog/changelog/2026-07-29-copilot-code-review-agent-skills-and-mcp-now-generally-available/) ·
[Codex Security](https://help.openai.com/en/articles/20001107-codex-security) ·
[Anthropic Code Review](https://alphasignalai.substack.com/p/anthropic-releases-code-review-that) ·
[PwnedRabbit, Endor Labs](https://www.endorlabs.com/learn/when-coderabbit-became-pwnedrabbit-a-cautionary-tale-for-every-github-app-vendor-and-their-customers) ·
[Star Chamber, Mozilla.ai](https://blog.mozilla.ai/the-star-chamber-multi-llm-consensus-for-code-quality/) ·
[Three Models Agreed](https://www.digitalapplied.com/blog/cross-model-review-consensus-verification-2026) ·
[Alibaba open-code-review](https://github.com/alibaba/open-code-review)

## Open decisions (D)

1. **D1 — Name.** Working title only. It wants a real one before Phase 1, since it becomes a
   package name, a binary name and a bot identity. **Decided (B7):** Copse Reviewer.
2. **D2 — Does Phase 0 ship inside Copse or as the standalone package from day one?**
   Recommendation: the package from day one, consumed by Copse — retrofitting the boundary
   later is how the boundary rots. **Decided (B2):** the package from day one.
3. **D3 — Default trigger in the app.** Recommendation: explicit gesture only, no
   automatic-per-turn mode at all. Deleting the auto path is a simplification, not a
   regression, given Problem 1.
4. **D4 — Does the reviewer get its own repository?** Deferred by request. The `@copse/review`
   boundary is what keeps the option open at low cost.

### Candidate preservation and bounded investigation (2026-09-24)

A reviewer records a concrete suspected defect with `record_suspicion` before investigating it.
The immutable ledger is review data, not published findings. `finish_review` must resolve every id
exactly once: link to a structured finding, refute with specific counterevidence, or leave unresolved
and name the id in `couldNotVerify`. Missing evidence or exhausted budget cannot refute a suspicion.
Closure validation is atomic; a rejected disposition cannot partially publish findings. Dispositions
remain auditable in the tool events. This makes omissions detectable; it does not independently prove
that a model's counterevidence is correct or capture suspicions it never records.

For review budgets of at least six steps, up to three steps (at most one third) are reserved inside
the existing `maxSteps` for focused investigation of recorded suspicions. They run before the existing
three-call protocol repair, with the same tools, execution cell and permission policy. The reserve
only runs while completion is missing and the ledger is nonempty. Cancellation and provider errors
remain terminal. Protocol repair receives the ledger and cannot silently discard it. This is a bounded
phase of the same review turn, not product auto-continuation or a change to hook budgets.

### September 24: reviewer startup

PR and nightly ground/findings checkouts retain full Git ancestry (`fetch-depth: 0`)
but use `filter: blob:none` to omit historical file contents. Trusted code is checked
out normally; materializing the exact head and merge-base worktrees hydrates their
contents on the host before commands run in the network-disabled cell. No shared
writable cache, broader credentials or change to the protected environment is involved.
The original Luna PR #3003 findings job spent 41 seconds in checkout, 11 seconds
installing the reviewer and 35 seconds preparing validation (about 28 seconds building
the container). A local filtered clone plus both exact worktrees took 20.7 seconds
and 131 MiB of packed Git data; the full-clone comparison exhausted the local disk,
so this is a feasibility measurement, not a controlled CI speedup claim. Full Stage 0
checks, queue/approval time and model time are separate costs.

### September 24: tolerate irrelevant closure metadata

The same-head Luna retest (35996064428) reduced findings-job setup from 100 to
65 seconds and posted the resize defect, but failed its final attestation: four
closure attempts included `findingIndex: 1` on a refuted suspicion. The local
provider normalizer did not make this field required. Refuted/unresolved dispositions now strip
irrelevant finding-index metadata before validation; reported/duplicate links,
complete disposition coverage and explicit unresolved uncertainty remain mandatory.
Counterevidence must contradict the recorded claim rather than a stronger paraphrase.
This preserves the evidence checks while avoiding repeated model calls to remove a
field that cannot affect the disposition's meaning.

### September 24: readable comments and supported test execution

PR comments lead with the concrete problem and a plain confirmation status. Evidence,
model metadata and supporting reasoning move into collapsed details; the review body
keeps incomplete-review and missing-check warnings visible. Reviewer claims should name
the trigger and effect in plain language, leaving implementation detail in the explanation.

The last completed Luna run spent 86 seconds preparing the job, then 493 seconds reviewing.
Checkout was only 10 seconds of setup. It made three serial model passes and 82 tool calls;
the reproducer used 30 read/search calls without writing a test. `write_reproducer` now
offers `argv: ["copse-test"]`: a trusted esbuild/Node test adapter passed as literal argv
to the existing cell on both revisions. It bundles local TS imports using each checkout's
tsconfig and keeps compiled output under that checkout for dependency resolution. It does
not install dependencies or execute reviewed code on the host. Custom argv, shell policy,
offline/credential-free boundaries, and mandatory differential-proof audits are unchanged.
The prompt directs an early small test rather than open-ended setup research; role budgets
remain unchanged. This removes an observed source of wasted work, not a guaranteed latency
reduction. Each role now records total wall time, tool wall time (overlap counted once), and
the remainder for model calls/retries/orchestration so the next live run can measure it.

### September 24: two concurrent verifications and actual hosting providers

The protected PR workflow now opts into `--verify-concurrency 2` (the CLI keeps
1 as its compatibility default). Repository variable `COPSE_REVIEW_VERIFY_CONCURRENCY`
can restore 1 without a workflow edit; invalid values are refused. A bounded worker pool processes findings in
priority order. Each finding still runs its reproducer before its own challenger
and keeps the mandatory behavioral-proof audit. Stable turn IDs and result order
are allocated before workers start. Cancellation stops queued findings; all active
workers settle before the shared cell can be destroyed.

This overlaps model investigation and model waiting. It does not parallelize
commands in a shared checkout: one tool queue covers every verification tool,
including each reproducer's prepare/write/head-run/base-run/base-cleanup sequence.
Each concurrent finding must use its own root-level `.copse-review/finding-N-`
filename prefix; a mismatched path is refused before writing or executing. Relative
imports keep their prior depth. The existing credential-free, offline cell and
all owner/key/environment checks are unchanged. This is collision prevention in
the existing shared cell, not separate OS isolation for each finding's code.

Hosting provider names are read from successful response metadata, bounded to a
short plain label and passed with per-stream usage through secret redaction. The
review report retains the observed names for each role and puts their union in
collapsed details. Absent metadata remains unknown; the `openai/` model prefix is
never used as hosting evidence. This is additive accounting only: no changes to
agent-loop budgets, hooks, continuations, routing, model choice or retry delays.

The sequential baseline (run 36015789351) took 697.7s for two findings: 618.2s in
model calls/waiting, including 135.4s of scheduled waits after ten streamed 429s,
44.4s in tools and 35.2s elsewhere. The second finding's two passes used 148.3s,
which is an overlap opportunity, not a promised saving under increased load.
Compare the subsequent protected live run's elapsed time, per-turn overlap,
provider metadata, retry count and proof quality before claiming a speedup.
