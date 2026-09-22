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

| case                  | head                                           | truth                                   | what it exercises                                                                |
| --------------------- | ---------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| `paginate-off-by-one` | every page one item short; the test catches it | one `contract` defect, regresses `test` | Stage 0's delta minting a finding, plus a reviewer's anchored one; a reproducer  |
| `timer-leak`          | the abort path stops clearing the timer        | one `resource` defect                   | a defect no test covers; anchor slack; the challenger as the only verdict        |
| `clean-rename`        | a local variable renamed                       | none                                    | a wrong candidate refuted by the challenger and dropped: precision kept          |
| `null-check-dropped`  | the null guard removed; tests never pass null  | one `contract` defect                   | two lenses, one defect, one finding (Stage 3), confirmed by a reproducer         |
| `false-alarm`         | a harmless early return                        | none                                    | a wrong claim the challenger cannot settle reaches the human: the false positive |

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
pnpm run bench:review --compare bench-results/review/summary.json bench-results/review-noverify/summary.json
pnpm run bench:review --model claude-sonnet-5 --update-baseline
pnpm run bench:review --model claude-sonnet-5 --cases /path/to/large-corpus --target-gate
```

Keys come from the environment the way the CLI takes them (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `LM_STUDIO_URL` / `LM_STUDIO_MODEL`,
`COPSE_REVIEW_API_KEY`). Reports land under `bench-results/review/` (one JSON per case and
a `summary.json`); `--compare` prints the delta between two summaries, which is how an
ablation is read (Q6: cross-model ensembling against one model; verification on against
off; lenses).

## The baseline and the gate

`baseline.json` is a regression ratchet, not evidence for an absolute quality claim. Each
entry is keyed by a digest of the complete run identity: evaluator version, provider,
reviewer and challenger models, credential-free custom endpoint, lenses, verification
mode, selected case IDs and corpus-content fingerprint. `--gate` fails on a missing exact
baseline, when precision drops (a model profile gets five points of tolerance, the mock
none), when true positives fall, when duplicates rise, or when output tokens per confirmed
finding exceed 1.25× the baseline. `--update-baseline` moves it deliberately.

`--target-gate` is separate and accepts real-model profiles only. It requires at least 85%
point precision, an 85% or better Wilson lower bound from a two-sided 95% interval, at
least 50% recall, and zero duplicate comments. The confidence requirement means a tiny
perfect sample is not enough (5/5 fails; 22/22 is the first all-correct sample that passes).

**What the mock number is, and is not.** The mock profile plays each case's script, so the
80% it scores is a property of the corpus and the pipeline's non-model parts — Stage 0's
delta, clustering across lenses, the verdicts, the ranking — and of nothing else. It is the
harness's self-test and the per-PR regression gate for those parts. It is not a precision
claim for Copse Reviewer. Nor can this five-case synthetic corpus establish B8's 85% claim:
it is a smoke/trend suite and is too small to pass the confidence gate. A public B8 claim
requires an appropriately mapped run over Martian's offline track (or a comparably sized,
independently labelled corpus); numbers from Martian's online track are not interchangeable.
