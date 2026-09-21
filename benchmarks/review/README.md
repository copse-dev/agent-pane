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
path and overlapping lines within Stage 3's slack is a hit; a Stage 0 regression is a hit
when the defect declares that regression. Every finding that hits nothing is a false
positive.

| case                  | head                                           | truth                                   | what it exercises                                                                |
| --------------------- | ---------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| `paginate-off-by-one` | every page one item short; the test catches it | one `contract` defect, regresses `test` | Stage 0's delta minting a finding, plus a reviewer's anchored one; a reproducer  |
| `timer-leak`          | the abort path stops clearing the timer        | one `resource` defect                   | a defect no test covers; anchor slack; the challenger as the only verdict        |
| `clean-rename`        | a local variable renamed                       | none                                    | a wrong candidate refuted by the challenger and dropped: precision kept          |
| `null-check-dropped`  | the null guard removed; tests never pass null  | one `contract` defect                   | two lenses, one defect, one finding (Stage 3), confirmed by a reproducer         |
| `false-alarm`         | a harmless early return                        | none                                    | a wrong claim the challenger cannot settle reaches the human: the false positive |

Add a case by adding a directory with those four things and running
`pnpm run bench:review -- --mock --update-baseline`; the gate refuses to compare runs over
different case counts.

## Running it

```bash
pnpm run bench:review -- --mock --gate                 # the self-test CI runs per PR
pnpm run bench:review -- --provider lmstudio --model qwen3-coder
pnpm run bench:review -- --model claude-sonnet-5 --model gpt-5 --out bench-results/review-ensemble
pnpm run bench:review -- --model claude-sonnet-5 --no-verify --out bench-results/review-noverify
pnpm run bench:review -- --compare bench-results/review/summary.json bench-results/review-noverify/summary.json
pnpm run bench:review -- --model claude-sonnet-5 --update-baseline
```

Keys come from the environment the way the CLI takes them (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `LM_STUDIO_URL` / `LM_STUDIO_MODEL`,
`COPSE_REVIEW_API_KEY`). Reports land under `bench-results/review/` (one JSON per case and
a `summary.json`); `--compare` prints the delta between two summaries, which is how an
ablation is read (Q6: cross-model ensembling against one model; verification on against
off; lenses).

## The baseline and the gate

`baseline.json` holds one entry per profile — `mock`, or the reviewer models joined by
`+`. `--gate` fails when precision drops (a model profile gets five points of tolerance,
the mock none: it is deterministic), when true positives fall, when output tokens per
confirmed finding grow past 1.25× the baseline, or when the case count is not the
baseline's. `--update-baseline` moves it deliberately.

**What the mock number is, and is not.** The mock profile plays each case's script, so the
80% it scores is a property of the corpus and the pipeline's non-model parts — Stage 0's
delta, clustering across lenses, the verdicts, the ranking — and of nothing else. It is the
harness's self-test and the per-PR regression gate for those parts. It is not a precision
claim for Copse Reviewer. That claim, B8's 85%, rests on a model profile's baseline, which
needs a model run and has not been recorded yet: the first such run sets it, and the
number is revisited then, as B8 says.
