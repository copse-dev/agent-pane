# Kev-4b on the command test set, 2026-09-26

`dev.jsonl` and `holdout.jsonl` are the raw `pnpm run eval:classifier` records for
`fixtures/tier-dev.jsonl` and `fixtures/tier-holdout.jsonl`. They hold ids, probabilities,
latencies and the expected tier, and no command text.

| Part      | Identity                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Server    | `jaredpalmer/kev` `2855ba2a55a80579176a459f78b95d03548cabb5`: `uv run python -m kev.serve --run jaredpalmer/kev-4b --port 8009` |
| Adapter   | `jaredpalmer/kev-4b` `139fdd94f1b6a6ad80cc15e08fcb99cac885a101`, LoRA rank 16                                                   |
| Base      | `Qwen/Qwen3.5-4B-Base` `1001bb4d826a52d1f399e183466143f4da7b741b`                                                               |
| Runtime   | MLX on MPS, bfloat16; the server reports temperature 2.406                                                                      |
| Transport | `benchmarks/classifiers/kev.json` (systemone, model `kev-latest`, 30 s timeout), `--concurrency 4`                              |

28 dev calls timed out during the first minutes of the run and were retried once, at concurrency 2.
Every retry succeeded, and `dev.jsonl` holds the retried records. Holdout had no failures. Latency
is per request under concurrency, on a 32 GiB M1 Max that was also running the repository's unit
tests.

Rescore without the model:

```bash
node benchmarks/escalation-review/testset/score-models.mjs \
  kev-4b-dev=benchmarks/escalation-review/testset/results/2026-09-26/kev-4b/dev.jsonl \
  kev-4b-holdout=benchmarks/escalation-review/testset/results/2026-09-26/kev-4b/holdout.jsonl
```

The combined rows depend on the committed `deterministic.jsonl`, so they move when the gates do.
