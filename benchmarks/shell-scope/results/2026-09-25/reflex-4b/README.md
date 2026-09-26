# reflex 4B — shell-scope run, 2026-09-25

Run through `pnpm run eval:classifier` with the committed
[`inputs/classifier/`](../../../inputs/classifier) fixtures, scored by
[`score-classifier-eval.mjs`](../../../scripts/score-classifier-eval.mjs) and combined
with the deterministic verdicts by
[`combine-classifier-eval.mjs`](../../../scripts/combine-classifier-eval.mjs)
([tables](combinations.md)). Each JSONL file is the unmodified eval output.

| Item          | Value                                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model         | `Qwen/Qwen3.5-4B` commit `851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a`, no adapter (reflex's `stable` configuration)                                                                          |
| Server        | `kshetrajna12/reflex` `231f896d818a62b94fec305ed553df1088486dcb`: `reflex-serve --stable --device mps --dtype float16 --host 127.0.0.1 --port 8008`, installed with `uv sync --no-sources` |
| Configuration | `serving/stable.json` released 2026-09-20: markdown prompt, two option orders averaged, no calibration. The `stable` tag's own code has no MPS path, so `main` ran the same configuration  |
| Runtime       | torch 2.14.0, Transformers 5.17.0; MPS float16                                                                                                                                             |
| Host          | Apple M1 Max, 32 GB                                                                                                                                                                        |
| Transport     | Copse `systemone` HTTP adapter from `main` (no derived fields needed), requested model `jev-latest`, `--concurrency 2`; server reports `Qwen/Qwen3.5-4B`                                   |

| Split   | Prompt                  | Valid / planned | Correct | Wrong sandbox | Wrong external | Balanced accuracy | Median ms |
| ------- | ----------------------- | --------------: | ------: | ------------: | -------------: | ----------------: | --------: |
| dev     | original                |         100/100 |      47 |            51 |              2 |             0.550 |      6161 |
| dev     | explicit (dev-selected) |         100/100 |      64 |             0 |             36 |             0.550 |      3266 |
| holdout | original                |         100/100 |      74 |            25 |              1 |             0.562 |      2344 |
| holdout | explicit (dev-selected) |         100/100 |      30 |             0 |             70 |             0.507 |      2439 |

Median latency is per request at concurrency 2. The frozen base model is close to
chance on this task: with either prompt it answers mostly one way (the explicit prompt
external, the original prompt sandbox), and its balanced accuracy stays between 0.51
and 0.56. Combined with the deterministic check, the development-selected weighted sum
(88 on development data) falls to 61 on the holdout, and filtering first with a
dev-fitted threshold falls to 59; no combination improves on the deterministic
check's 87.
