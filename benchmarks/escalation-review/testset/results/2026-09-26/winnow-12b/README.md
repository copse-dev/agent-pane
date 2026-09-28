# Winnow-12B on the command test set, 2026-09-26

`dev.jsonl` and `holdout.jsonl` are the raw `pnpm run eval:classifier` records for
`fixtures/tier-dev.jsonl` and `fixtures/tier-holdout.jsonl`. They hold ids, probabilities,
latencies and the expected tier, and no command text. Every call succeeded on the first attempt.

| Part      | Identity                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Server    | `EldanRing/winnow-inference` `77d14580c6732ca2f3745750c1dc1fd446d8bcee`, llama.cpp with Metal, `apple-silicon` profile, `--text-only`      |
| Weights   | `EldanRing/Winnow-12B` `b2b14213dfa252e6d6b543c8b334762e51772d29`, `gguf/Winnow-12B-Q8_0.gguf`, sha256 `b710efc4…18ea` (verified by setup) |
| Base      | `google/gemma-4-12B-it` `707f0a3b8a3c7ad586ed01e27eafbad8a27dd0f7`                                                                         |
| Launch    | `pnpm run classifier:serve -- winnow --context 16384` from a persistent cache                                                              |
| Transport | `benchmarks/classifiers/winnow.json` (systemone, 60 s timeout), `--concurrency 1`                                                          |

The context was cut from the profile's 64K to 16K to fit a 32 GiB M1 Max. The fixtures need only a
few thousand tokens.

Rescore without the model:

```bash
node benchmarks/escalation-review/testset/score-models.mjs \
  winnow-dev=benchmarks/escalation-review/testset/results/2026-09-26/winnow-12b/dev.jsonl \
  winnow-holdout=benchmarks/escalation-review/testset/results/2026-09-26/winnow-12b/holdout.jsonl
```
