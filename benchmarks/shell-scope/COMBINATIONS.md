# Exploratory combinations of models and deterministic scope

No completed local-model combination improved on the historical deterministic
scope baseline. Claude is promising on development data only. Retain existing
deterministic checks and OS containment; this replay does not validate execution
permissions or measure end-to-end escalation.

These combinations were chosen after inspecting the holdout. They are exploratory,
not a fresh held-out policy evaluation. The 200 assistant-reviewed labels still
need independent human review. No model requests or fixture executions occur.

## Model as an additional external warning

Predict sandbox only when both the deterministic projection and the model predict
sandbox. An external model prediction can add a warning, never remove one.

| Evaluator         | Split       | Correct / 100 | Wrong sandbox | Wrong external |
| ----------------- | ----------- | ------------: | ------------: | -------------: |
| Determinism alone | Holdout     |            87 |             3 |             10 |
| + Laya typed      | Holdout     |            87 |             3 |             10 |
| + Laya base       | Holdout     |            87 |             3 |             10 |
| + OpenJev         | Holdout     |            84 |             3 |             13 |
| + SemIf           | Holdout     |            58 |             0 |             42 |
| + Kev             | Holdout     |            29 |             0 |             71 |
| Determinism alone | Development |            76 |            16 |              8 |
| + Claude ACP      | Development |            92 |             0 |              8 |

The holdout contains 29 external and 71 sandbox labels. SemIf fixes all three
incorrect sandbox predictions but introduces 32 additional incorrect external
predictions. OpenJev introduces three incorrect external predictions and fixes none.
Claude fixes all 16 incorrect sandbox predictions on development data. It has no
holdout observations; its development result cannot be ranked against held-out models.

## Relaxation, voting, confidence, and abstention

Allowing a model to replace a deterministic external prediction with sandbox gives:

| Model              | Holdout correct / 100 | Wrong sandbox | Wrong external |
| ------------------ | --------------------: | ------------: | -------------: |
| Laya typed or base |                    71 |            29 |              0 |
| OpenJev            |                    78 |            20 |              2 |
| SemIf              |                    83 |             9 |              8 |
| Kev                |                    87 |             3 |             10 |

A five-vote majority of determinism, SemIf, Laya typed, Kev, and OpenJev scores
80/100 with nine incorrect sandbox and eleven incorrect external predictions.
Laya base is excluded from voting to avoid giving that family two votes.

Using the standalone development-fitted confidence policies with deterministic
fallback leaves Laya and SemIf unchanged at 87/100. Kev's accepted external
prediction introduces one error, giving 86/100. Claude and OpenJev have no
categorical confidence; this rule makes no confidence-based changes for them.

A separate exploratory cascade fits thresholds specifically on development
disagreements. It maximizes corrections subject to zero newly introduced
development errors; equal corrections prefer the higher numeric threshold.
Prompts and temperatures stay fixed at their original development selections.
This selects no local-model changes in either direction, leaving every holdout
combination at 87/100. Claude permits a categorical external warning on development
data only. Thresholds are fitted without holdout labels, but choosing this analysis
after inspecting holdout results still makes it exploratory.

The replay also reports abstention on disagreements and an ambiguous-only
fallback. Abstentions remain in the denominator, not counted as successes.
Historical deterministic scope has two ambiguous development outputs and none
on holdout. The binary projection maps ambiguous to external; it scores 76/100
on development versus 74 exact binary matches. Raw ambiguity remains available
in the original evidence.

## Reproduce

From the repository root with its pinned Node and dependencies:

```sh
node benchmarks/shell-scope/scripts/combine-recorded.mjs
node benchmarks/shell-scope/scripts/cascade-thresholds.mjs
pnpm test -- shell-scope-benchmark
```

Both scripts validate the published evidence hashes before joining case IDs.
Each model uses its development-selected prompt. Missing/error predictions
fall back to determinism except in agreement-only analysis, where they abstain.

Add `--json <new-file>` to save create-only JSON. The combination output includes
every per-case prediction, changed case, error ID, and rule summary; the cascade
output includes fitted thresholds and changes. All inputs and native observations
are already included in this package. The regression check reproduces the headline
scores and verifies that changing holdout labels cannot change fitted thresholds.

These are hypothetical scope predictions. Harm checks, unknown-shape handling,
grants, sandbox enforcement, approval state and actual execution remain separate.
See [the main report](README.md) for the rubric, exact model identities, original
results, latency caveats, and review gaps.
