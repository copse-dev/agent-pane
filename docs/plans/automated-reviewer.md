# Automated reviewer

Status: **Proposed** — design only. Nothing in this document is on `main`. It supersedes
the surfacing and validation gaps in the existing `copse.model-comparison` plugin, which
stays as-is until Phase 2 rewires it.

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

| Piece                             | Where                                                                                     | State                                                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Post-turn review subagent         | `packages/agent/src/review-subagent.ts`, `src/main/services/review-subagent-runner.ts`    | ✅ read-only subagent over the working diff; emits a prose summary + `REVIEW_JSON` verdict                             |
| Two-reviewer + judge comparison   | `src/main/services/model-comparison.ts`, `model-comparison-runner.ts`                     | ✅ fan-out to two models, judge compares their _prose_; experimental plugin, default off                               |
| Review / comparison cards         | `src/renderer/views/review-panel.ts`, `comparison-panel.ts`                               | ✅ rendered inline in the conversation; comparison card is the only consumer of the comparison                         |
| Model selection by rule            | `@copse/llm/dynamic-model.ts`, `resolveDistinctDynamicModelIds`                          | ✅ "best value" / "best intellect" selectors that resolve to _distinct_ concrete models                                |
| Spend approval                    | `comparisonNeedsApproval`, `requestApproval`                                              | ✅ prompts when any of the three models is billable, with per-thread remember                                          |
| Electron-free agent core          | `@copse/agent`, `@copse/llm`                                                              | ✅ real package boundary, proven by `scripts/bench-agent-lib.mts` (imports the packages only — no Electron, no `src/main`) |
| Headless contract                 | `packages/agent/src/headless-contract.ts`                                                 | ✅ v1 request/event/permission/exit-code contract with a published JSON Schema                                         |
| Worktrees                         | `src/main/services/worktree-manager.ts`, `worktree-inventory.ts`                          | ✅ per-thread worktree lifecycle                                                                                        |
| Command execution + sandbox       | `src/main/services/exec/command-runner.ts`, `src/main/project-sandbox/`                   | ✅ spawn, network scope, output caps — but **not reachable from a review**                                              |
| CI investigator subagent          | `src/main/services/github/ci-investigator-service.ts`                                     | ✅ read-only, reads real CI failures — on-demand inside a live turn only                                                |
| PR context                        | `src/main/services/github/pr-context-service.ts`, `pr-file-content.ts`                    | ✅ PR metadata and file content                                                                                         |
| Durable notes                     | `src/main/services/storage/knowledge-store.ts`                                            | ✅ typed OKF notes; no new store needed for finding suppression                                                         |
| Untrusted-content handling        | `packages/agent/src/external-content.ts`                                                  | ✅ exists; not currently applied to review inputs                                                                       |
| **Structured finding type**       | —                                                                                          | ❌ reviews are prose end-to-end                                                                                          |
| **Any execution during review**   | —                                                                                          | ❌ `REVIEW_TOOL_NAMES` is strictly read-only                                                                             |
| **CLI entry point**               | —                                                                                          | ❌ no `bin` in `package.json`; no standalone runner                                                                      |
| **Finding suppression / memory**  | —                                                                                          | ❌ every run rediscovers everything                                                                                      |
| **Review quality measurement**    | —                                                                                          | ❌ no eval; no precision number to regress against                                                                       |

### Problem 1 — it is never surfaced

The comparison is gated behind, in series: an experimental plugin that is default-off; a
second top-level opt-in (`modelComparisonAutoOnReview`, default false) for the automatic
path; and a spend-approval modal when any chosen model is billable. The only ambient
entry is a "Compare models" follow-up bubble, itself conditional on `when:
'workspace-changes'`.

That is four gates before a first-time user sees a comparison, and none of them is the
moment a human actually wants a review. The fix is not to lower a gate; it is to add the
gesture Fairy has and Copse lacks: **an explicit "review this" act, in the surface where
the human is already looking at the change** — the Changes view, PR creation, `copse
review` in a terminal. Automatic-on-every-editing-turn is the wrong trigger regardless of
its default; it fires when nobody asked and trains people to ignore the card.

### Problem 2 — nothing validates

`REVIEW_TOOL_NAMES` is `read_file`, `list_dir`, `search_code`, `git_diff`, `git_status`,
`git_log`, `staged_diffs`, `read_staged_diff`. There is no shell, no build, no test run.
Both reviewers read the same diff (capped at `MAX_DIFF_CHARS = 12_000`) and the same
source files. The judge reads _only their two prose outputs_ and is explicitly told **"Do
NOT re-review the code yourself"**.

So the pipeline has no contact with a compiler, a type checker, a linter or a test at any
point. Two models can agree, fluently and in detail, on a claim that thirty seconds of
`pnpm run typecheck` would have refuted — and the judge's role, as written, is to
_summarise their agreement_. Agreement between correlated models is close to worthless as
evidence; execution is worth a great deal.

### Problem 3 — prose is not addressable

Because the output is markdown, a finding has no identity. That single fact blocks:
per-finding verification, dedupe across reviewers, ranking, capping, inline PR comments,
"I already dismissed this", machine consumption by CI, and any measurement of whether the
reviewer is getting better or worse.

## Design

### The core move: findings, not reviews

One schema, in a new Electron-free package, is the whole contract. Sketch — the field
list is the design, the exact encoding is Phase 1's to settle:

- **identity** — a stable id derived from the *content* of the anchored lines plus a
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
reviewer runs in its own sandboxed checkout and **may execute** — run the tests, run a
scratch script — but cannot write to the real tree or the network beyond policy.
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

### Configuration

A repo-owned `review.config.*` (or a `[review]` block in an existing config) declaring:
commands for build/typecheck/lint/test; lenses to run and their severity floors;
model selections by role (reviewer / challenger), expressed as `dynamic-model` rules so
the config does not rot as models change; path-scoped rules ("`src/main/**` is
security-sensitive, `docs/**` is not"); and the output cap. Repo-owned so a project can
teach the reviewer its conventions — which is the difference between a tool people adopt
and a tool people mute.

## What needs to be solved

Ordered by how likely each is to sink the thing.

1. **Executing untrusted code.** Stages 0, 2 and 4 all run the code under review. On a PR
   from an arbitrary contributor that is straightforwardly arbitrary code execution — the
   FFmpeg case makes this concrete. This must run inside `project-sandbox/` with an
   explicit network scope, and the CLI shell must refuse to run build/test stages outside
   a sandbox unless the user passes an explicit `--i-trust-this-diff`-shaped flag. Copse
   has the containment primitives and a documented permission contract
   ([`../shell-permissions.md`](../shell-permissions.md)); what does not exist is a policy
   for _review_ specifically. **This is the gating decision for Phase 1 and it is a
   security design task, not an implementation detail.**
2. **Finding identity.** Clustering across reviewers, and stability across pushes and
   rebases. Naive string similarity will both over- and under-merge. Anchoring to content
   hashes plus overlapping ranges is the starting proposal; it needs a real corpus to
   tune against, and it is the crux of both Stage 3 and suppression.
3. **Cost and latency.** N models × M lenses × verification is easily 20× a current
   review. Needs: a declared budget, staged escalation (cheap broad pass → expensive
   verification on survivors only), caching keyed on `(base, head, config)`, and honest
   reporting of spend. The existing per-model usage accounting and
   `estimateUsageCost` give the accounting; the policy is missing.
4. **Verification when there is nothing to run.** Many repos have no tests, or a suite
   that takes forty minutes. Define the degradation ladder explicitly — full run →
   changed-package subset → single reproducing test → adversarial challenge only → declare
   the finding unverified and say so — and make which rung was reached visible in the
   output.
5. **Correlated model error.** Two models from one family agree on one hallucination.
   Agreement is only evidence if the reviewers are actually independent. Needs a stated
   position on which diversity axes count (family ≫ size ≫ sampling), and a challenger
   role that is scored on refutations rather than agreements.
6. **Measurement.** Without a precision number this degrades into noise within a quarter,
   and nobody will notice which change did it. Needs a `bench:review` harness on a corpus
   of PRs with known outcomes, following the pattern in
   [`industry-benchmarks.md`](industry-benchmarks.md), reporting precision on surfaced
   findings (primary), reproducer rate, and cost per confirmed finding. **Precision is the
   metric. Recall is explicitly not.**
7. **Prompt injection from the diff.** The reviewer reads attacker-controlled source and
   comments and then acts on them. `packages/agent/src/external-content.ts` exists; it
   must wrap every review input, and a finding must never be able to instruct the pipeline.
8. **Suppression that isn't annoying.** Dismissed findings must stay dismissed across
   pushes without also hiding a genuinely new problem at the same location. Depends
   entirely on (2).
9. **Where the gesture lives in the app.** "Review" in the Changes view is the proposal;
   it needs a design pass against [`../ui-taste.md`](../ui-taste.md) and, per
   [`../../AGENTS.md`](../../AGENTS.md), visual evidence.

## Phases

- **Phase 0 — Findings schema + Stage 0.** `@copse/review` with the finding type, and the
  build/test baseline diff. No models at all. Ships value immediately ("this doesn't
  compile / this test regressed") and proves the sandbox story before any model spend.
- **Phase 1 — CLI shell.** `copse review` over a single model, one lens, Stage 0 + 1 + 2 +
  5. Dogfood on this repo's own PRs. Settle the sandbox policy here.
- **Phase 2 — Multi-model + verification.** Lenses, fan-out, clustering, the challenger
  role, reproducer generation. Retire the comparison judge in favour of per-finding
  verdicts.
- **Phase 3 — App shell.** `copse.model-comparison` → `copse.review`; findings card;
  the Changes-view gesture; dismissal persisted.
- **Phase 4 — CI shell.** GitHub Action, inline comments, opt-in by label. Forgejo
  equivalent.
- **Phase 5 — Eval.** `bench:review` and a precision gate. Arguably belongs at Phase 2;
  listed last only because it needs a corpus that Phases 1–2 generate.

## Non-goals

- Not a merge gate. Advisory, like Fairy.
- Not a replacement for human review.
- Not a linter or a formatter — it defers to the repo's own.
- Not an autofixer in this plan. `remedy` is a suggested patch a human applies; applying
  it automatically is separate work with a separate risk profile.
- Not a hosted service. Local-first, provider-agnostic, runs against a local model.

## Open decisions

1. **Name.** Working title only. It wants a real one before Phase 1, since it becomes a
   package name, a binary name and a bot identity.
2. **Does Phase 0 ship inside Copse or as the standalone package from day one?**
   Recommendation: the package from day one, consumed by Copse — retrofitting the boundary
   later is how the boundary rots.
3. **Default trigger in the app.** Recommendation: explicit gesture only, no
   automatic-per-turn mode at all. Deleting the auto path is a simplification, not a
   regression, given Problem 1.
4. **Does the reviewer get its own repository?** Deferred by request. The `@copse/review`
   boundary is what keeps the option open at low cost.
