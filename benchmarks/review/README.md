# Copse Reviewer measurement (`pnpm run bench:review`)

The number [`docs/plans/copse-reviewer.md`](../../docs/plans/copse-reviewer.md) says the
reviewer lives or dies by (P6, B8): **precision on surfaced findings**. A finding that
reaches a human and is wrong is the failure the whole design exists to prevent, so that is
the metric; recall is reported and explicitly secondary, because the design trades it away
on purpose. Beside it: the reproducer rate (how many surfaced findings execution settled)
and the tokens spent per confirmed finding.

## The corpus

Each directory under `cases/` is one case: a small project as two trees, `base/` and
`head/`, a `case.json` naming the defects the head carries (or none), and a `mock.json`
scripting what a reviewer, a reproducer and a challenger do. The harness materialises the
case as a git repository (`main` is the base, `head` the change), runs the whole pipeline
over it — Stage 0 in a host-process cell, the reviewers under `correctness` and
`contracts`, clustering, verification, ranking — and scores the surfaced findings against
the truth with [`packages/review/src/eval.ts`](../../packages/review/src/eval.ts): same
path and overlapping lines within Stage 3's slack plus the defect's hand-authored
`claimSignals` are required for an anchored hit; a Stage 0 regression is a hit when the
defect declares that regression. `claimSignals` are AND-of-OR groups, so every group must
match one alternative. Every unique finding that hits nothing is a false positive.
Equivalent surfaced comments are reported as duplicates and excluded from both precision
counts, so repeating a true claim cannot inflate the score; the absolute target requires
zero duplicates.

| case                        | head                                               | truth                                   | what it exercises                                                                |
| --------------------------- | -------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| `paginate-off-by-one`       | every page one item short; the test catches it     | one `contract` defect, regresses `test` | Stage 0's delta minting a finding, plus a reviewer's anchored one; a reproducer  |
| `timer-leak`                | the abort path stops clearing the timer            | one `resource` defect                   | a defect no test covers; anchor slack; the challenger as the only verdict        |
| `clean-rename`              | a local variable renamed                           | none                                    | a wrong candidate refuted by the challenger and dropped: precision kept          |
| `null-check-dropped`        | the null guard removed; tests never pass null      | one `contract` defect                   | two lenses, one defect, one finding (Stage 3), confirmed by a reproducer         |
| `false-alarm`               | a harmless early return                            | none                                    | a wrong claim the challenger cannot settle reaches the human: the false positive |
| `semantic-image-kind`       | a new image producer omits its semantic kind       | one `contract` defect                   | tracing an omitted field through an unchanged renderer fallback                  |
| `external-image-provenance` | a page-image producer inherits internal provenance | one `security` defect                   | comparing the closest analogue and tracing trust metadata through its wrapper    |

Add a case by adding a directory with those four things and running
`pnpm run bench:review --mock --update-baseline`; any corpus-content change creates a new
baseline identity, so the next gate fails until that exact configuration is reviewed and
rebaselined.

## Running it

```bash
pnpm run bench:review --mock --gate                 # the self-test CI runs per PR
pnpm run bench:review --provider lmstudio --model qwen3-coder
pnpm run bench:review --model claude-sonnet-5 --model gpt-5 --out bench-results/review-ensemble
pnpm run bench:review --model claude-sonnet-5 --no-verify --out bench-results/review-noverify
pnpm run bench:review --model qwen3.8-27b --max-steps 12 --max-verify 3
pnpm run bench:review --model qwen3.8-27b --lenses boundaries --case semantic-image-kind
pnpm run bench:review --compare bench-results/review/summary.json bench-results/review-noverify/summary.json
pnpm run bench:review --model claude-sonnet-5 --update-baseline
pnpm run bench:review --model claude-sonnet-5 --cases /path/to/large-corpus --target-gate
```

Keys come from the environment the way the CLI takes them (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `LM_STUDIO_URL` / `LM_STUDIO_MODEL`,
`COPSE_REVIEW_API_KEY`). Reports land under `bench-results/review/` (one JSON per case and
a matching event-stream JSONL plus `summary.json`); `--compare` prints the delta between two summaries, which is how an
ablation is read (Q6: cross-model ensembling against one model; verification on against
off; lenses).

## The baseline and the gate

`baseline.json` is a regression ratchet, not evidence for an absolute quality claim. Each
entry is keyed by a digest of the complete run identity: evaluator version, provider,
reviewer and challenger models, credential-free custom endpoint, lenses, verification
mode, reviewer/verification budgets, selected case IDs and corpus-content fingerprint. `--gate` fails on a missing exact
baseline, when precision drops (a model profile gets five points of tolerance, the mock
none), when true positives fall, when duplicates rise, or when output tokens per confirmed
finding exceed 1.25× the baseline. `--update-baseline` moves it deliberately.

`--target-gate` is separate and accepts real-model profiles only. It requires at least 85%
point precision, an 85% or better Wilson lower bound from a two-sided 95% interval, at
least 50% recall, and zero duplicate comments. The confidence requirement means a tiny
perfect sample is not enough (5/5 fails; 22/22 is the first all-correct sample that passes).

**What the mock number is, and is not.** The mock profile plays each case's script, so the
91.7% it scores is a property of the corpus and the pipeline's non-model parts — Stage 0's
delta, clustering across lenses, the verdicts, the ranking — and of nothing else. It clears
the point target by construction; it is the harness's self-test and the per-PR regression
gate for those parts, not a precision claim for Copse Reviewer. Nor can this 17-case
synthetic corpus establish B8's 85% claim: its Wilson lower bound is only 64.6%, and it is a
smoke/trend suite. A public B8 claim requires an appropriately mapped run over Martian's
offline track (or a comparably sized, independently labelled corpus); numbers from
Martian's online track are not interchangeable.

## State transitions and model experiments

The audit-derived additions each have a matched `-clean` case. Ordinary fixture tests pass on
both revisions; an independent `probe.cjs` outside the model checkout proves the transition:

| Bug case                    | Transition and invariant                                                          | Source    |
| --------------------------- | --------------------------------------------------------------------------------- | --------- |
| `filter-refresh`            | A title filter retains its row after a refresh replaces records with placeholders | PR #3008  |
| `resize-without-scroll`     | Resizing updates the viewBox even when scroll offsets remain unchanged            | PR #3003  |
| `workspace-switch-inflight` | An old request cannot overwrite the newly selected workspace                      | Synthetic |
| `dispose-inflight`          | A late response cannot repopulate a disposed view                                 | Synthetic |
| `shortcut-autorepeat`       | Holding the shortcut performs one share action                                    | PR #2833  |

These are reduced state-machine fixtures, not full Electron replays. The clean controls preserve
the relevant guards across an export refactor. `scripts/review-transition-corpus.test.ts` executes
all base/head smoke tests and all independent probes, checking expected failure on each buggy head
and success on every base and clean head. The scripted reproducer separately confirms each bug
through the normal pipeline. Probes and truth labels are never included in the model checkout.

The opt-in `transitions` lens targets these event sequences. Keep the default reviewer unchanged
until measured. First compare one model under `correctness`, `correctness,boundaries`, and
`correctness,transitions`; add `concurrency` only as a separate controlled ablation. Keep the corpus,
step limits, verification settings, provider route and prompt revision fixed and compare precision,
recall, duplicates, unresolved reviews, command use and billed cost per confirmed defect. Repeat
runs: the small synthetic corpus is a smoke suite, not an estimate of production precision.

As of 2026-09-24, the first model experiment should be **GPT-6 Luna**, with **GPT-6 Sol** as the
quality comparison, before spending on Astra. Artificial Analysis v4.3.2 currently reports
Intelligence Index scores of [37 for Luna (max)](https://artificialanalysis.ai/models/gpt-6-luna),
[48 for Sol (max)](https://artificialanalysis.ai/models/gpt-6-sol) and
[34 for Qwen3.8 27B (xhigh)](https://artificialanalysis.ai/models/qwen3-8-27b).
Its [coding-agent comparison](https://artificialanalysis.ai/articles/gpt-6-sol-and-luna-push-the-cost-efficiency-frontier)
gives Sol 57 and Luna 41. This is a reason to test Luna's value, not evidence that it reviews better.

OpenRouter lists [Luna](https://openrouter.ai/openai/gpt-6-luna) at $0.10/$0.50 and
[Sol](https://openrouter.ai/openai/gpt-6-sol) at $2/$10 per million input/output tokens;
[Scaleway Qwen](https://www.scaleway.com/en/generative-apis/) is EUR 0.60/3.30. Sol's token rates
are higher; token use, caching and route determine actual cost per review. These rates exclude
credit-purchase fees and taxes. AA's task costs use its own workload/provider pricing.

The existing OpenRouter provider can select either model:

```bash
pnpm run bench:review --provider openrouter --model openai/gpt-6-luna --lenses correctness --max-steps 12 --max-verify 3 --out bench-results/review-luna
pnpm run bench:review --provider openrouter --model openai/gpt-6-sol --lenses correctness --max-steps 12 --max-verify 3 --out bench-results/review-sol
pnpm run bench:review --compare bench-results/review-luna/summary.json bench-results/review-sol/summary.json
```

These commands use the current provider defaults, not AA's max-effort harness. Verify reasoning and
tool-call compatibility with one case before a full paid run, and record the effective effort and
route; the benchmark CLI does not yet expose an effort override. No production model change or
real-model quality claim is part of the corpus change.
