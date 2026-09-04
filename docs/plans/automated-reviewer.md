# Automated reviewer

Status: **Proposed** — design only. Nothing in this document is on `main`. It supersedes
the surfacing and validation gaps in the existing `copse.model-comparison` plugin, which
stays as-is until Phase 2 retires its judge and Phase 3 replaces it with `copse.review`.
Binding decisions B1 (execution isolation, 2026-09-03) and B2–B6 (packaging, backend
sequencing, scope, ecosystem, customer; 2026-09-04) are recorded. Problems are numbered
P1–P9 in §What needs to be solved, questions Q1–Q16 in §Competitive position, and the
remaining decisions D1–D4 in §Open decisions.

Prior art that prompted this: FFmpeg's **Forgejo Fairy**, the opt-in LLM reviewer a
contributor adds to a pull request by hand ([`doc/developer.texi`](https://ffmpeg.org/developer.html):
_"If you want an LLM-based review, add Forgejo Fairy as a reviewer to your pull request.
Issues with Fairy herself can be reported at her repository."_). Her source lives at
`code.ffmpeg.org/michaelni/Fairies`, which is unreachable from this environment (the
egress proxy returns 403 for `code.ffmpeg.org`), so everything below cites her
**documented behaviour**, not her implementation. Anything about her internals is
explicitly marked as inference.

Related: the in-tree `copse.model-comparison` plugin (`src/main/services/model-comparison.ts`,
`model-comparison-runner.ts`, `packages/agent/src/plugins/model-comparison-plugin.ts`) — no plan
doc of its own;
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
contracts/API compatibility, tests, security, concurrency/resources, docs-vs-behaviour.
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
  lineage) that runs the CLI and posts findings as inline comments. Opt-in per PR — a
  label, or adding the reviewer, exactly as Fairy is invited — never automatic on every
  push, and never a required check.

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

|                                        | Isolation available                                                                              | No isolation                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **Own diff** (the user's working tree) | Execute.                                                                                         | Execute only with explicit per-run consent, mirroring the shell gate's "no sandbox, so prompt" rule. |
| **Foreign diff** (a contributor's PR)  | Execute in a container or VM only (B3); the process-scoped OS sandbox is not enough. | **Never execute.** Degrade to read-only lenses plus the challenger pass, and say so in the report.   |

An OS sandbox (macOS ASRT, Linux bubblewrap) and an ephemeral container or VM are not the
same strength. The process-scoped sandbox is sufficient for reviewing one's own
changes, where the "attacker" already has a shell on the machine; a foreign diff gets a
throwaway container or VM. B3 settles the one sub-question B1 left open: the OS sandbox is never enough for a
foreign diff, and it ships first because own-tree review is Phase 0's whole scope.

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
  read-only pipeline and prints why. Until the container backend lands, the CLI reviews
  only the user's own working tree. There is no flag that executes a foreign diff
  unisolated.
- **CI:** a GitHub-hosted runner is ephemeral but not secret-free, so the workflow is two
  jobs. **Job A** checks out the PR head on the `pull_request` event — never
  `pull_request_target` — with `permissions: {}` and no secrets, runs Stage 0 and the
  reproducers, and uploads results as an artefact. **Job B** runs on the base ref with the
  model key and a write token, downloads the artefact, runs the model stages, and posts
  findings. Self-hosted Forgejo runners must be ephemeral (a fresh container per job): a
  persistent runner is precisely what a malicious PR would persist on.

**Conformance test, in Phase 0.** A review of a deliberately hostile fixture — a
`postinstall` that reads the environment and tries to exfiltrate it, a repo-controlled linter
config that executes code, a test that reads `~/.copse`, and a README carrying an instruction
aimed at the agent (the pattern already in `benchmarks/steer/fixtures/injection-project/`) —
run with canary secrets in the orchestrator's environment. Pass criteria: no canary appears in
any cell output, model request or finding; no egress from the cell beyond the allowlist; the
README's instruction produced no tool call. This runs in CI for every backend and is the gate
on calling a backend supported.

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

## Phases

- **Phase 0 — Findings schema + Stage 0 + OS-sandbox backend.** `@copse/review` as a
  workspace package (B2) with the finding type, the build/test baseline diff for
  TypeScript/pnpm repositories (B5), the `IsolationBackend` abstraction with the existing OS
  sandbox as its first backend (B3), and the hostile-fixture conformance test. No models at
  all; the user's own working tree only. Ships value immediately ("this doesn't compile /
  this test regressed"). Stage 0 _is_ execution, so this is where B1 is proven, before any
  model spend.
- **Phase 1 — CLI shell.** `copse review` over a single model, one lens, Stage 0 + 1 + 2 + 5,
  bugs and regressions only (B4). Dogfood on this repository's own PRs (B6), reviewing the
  author's own tree.
- **Phase 2 — Multi-model + verification.** Lenses, fan-out, clustering, the challenger
  role, reproducer generation. Retire the comparison judge in favour of per-finding
  verdicts.
- **Phase 3 — App shell.** `copse.model-comparison` → `copse.review`; findings card;
  the Changes-view gesture; dismissal persisted. This replaces the first-party pack that
  [`hooks-and-feature-packs.md`](hooks-and-feature-packs.md) P5 extracted, so its decisions
  log binds here: decision 15 for the typed chunk the findings card consumes, decision 5 for
  any machine turn a review starts.
- **Phase 4 — Container backend + foreign diffs + CI shell.** The container/VM
  `IsolationBackend`, consuming the local-docker runtime proposed in
  [`copse-cloud-workspaces.md`](copse-cloud-workspaces.md) C1, which unlocks foreign-diff
  review (B3); then the GitHub Action with inline comments, opt-in by label, and the Forgejo
  equivalent.
- **Phase 5 — Eval.** `bench:review` and a precision gate. Arguably belongs at Phase 2;
  listed last only because it needs a corpus that Phases 1–2 generate.

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

Compiled 2026-09-03 from search summaries and vendor posts citing Martian's benchmark; most
primary pages were unreachable from the authoring environment. Treat every figure as
indicative, as [`competitive-landscape.md`](competitive-landscape.md) advises for
secondary sources.

Built as designed, the reviewer sits in a gap nobody occupies: general-purpose review where
a finding reaches a human only after execution confirmed it or a refutation pass failed to
kill it. The best published precision in the field is about 76% on Martian's independent
Code Review Bench. That is the number the design is aimed at.

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

Published numbers, to fix the bar (each vendor claims first on a different date or metric,
so read them as a range):

| Tool                 | Precision       | Recall | F1              | Source                 |
| -------------------- | --------------- | ------ | --------------- | ---------------------- |
| Greptile, July 2026  | 76.2            | 50.6   | 60.8            | vendor, citing Martian |
| Qodo                 | 62.3            | 66.4   | 64.3            | vendor, citing Martian |
| CodeRabbit, Feb 2026 | 49.2            | 53.5   | #1 F1 at launch | vendor, citing Martian |
| Cursor Bugbot        | 70%+ resolution | —      | —               | vendor                 |
| GitHub Copilot       | 71% actionable  | —      | —               | vendor                 |

The range says even the leader is wrong or ignored one comment in four. Price floor for
context: Gemini free, GitLab Duo about $0.25 per MR, Bugbot about $1.20 per review, Anthropic
managed review in the tens of dollars.

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
    ephemeral, agents never touch sensitive data. Design in §Execution isolation. The CodeRabbit RCE
    (an unsandboxed RuboCop, a malicious config, the App key, a million repositories) is the
    reference incident.

**Product gaps**

13. **Q13 — Codebase context.** Wire Copse's semantic search into Stage 1, or accept the gap on
    large repos?
14. **Q14 — Learnings.** CodeRabbit-style prompt learning from dismissals, or suppression only?
    Privacy implications for the local-first customer.
15. **Q15 — Interop.** Emit SARIF so findings land in GitHub code scanning and any SAST dashboard.
    Cheap, and no competitor leads with it.
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
   package name, a binary name and a bot identity.
2. **D2 — Does Phase 0 ship inside Copse or as the standalone package from day one?**
   Recommendation: the package from day one, consumed by Copse — retrofitting the boundary
   later is how the boundary rots. **Decided (B2):** the package from day one.
3. **D3 — Default trigger in the app.** Recommendation: explicit gesture only, no
   automatic-per-turn mode at all. Deleting the auto path is a simplification, not a
   regression, given Problem 1.
4. **D4 — Does the reviewer get its own repository?** Deferred by request. The `@copse/review`
   boundary is what keeps the option open at low cost.
