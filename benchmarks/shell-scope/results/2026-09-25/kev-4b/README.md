# Kev-4B — shell-scope run, 2026-09-25

Run through `pnpm run eval:classifier` with the committed
[`inputs/classifier/`](../../../inputs/classifier) fixtures, scored by
[`score-classifier-eval.mjs`](../../../scripts/score-classifier-eval.mjs) and combined
with the deterministic verdicts by
[`combine-classifier-eval.mjs`](../../../scripts/combine-classifier-eval.mjs)
([tables](combinations.md)). Each JSONL file is the unmodified eval output.

| Item      | Value                                                                                                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model     | `jaredpalmer/kev-4b` snapshot `139fdd94f1b6a6ad80cc15e08fcb99cac885a101` (LoRA r=16 and pointer head), on `Qwen/Qwen3.5-4B-Base` commit `1001bb4d826a52d1f399e183466143f4da7b741b`; head temperature 2.406 |
| Server    | `jaredpalmer/kev` `2855ba2a55a80579176a459f78b95d03548cabb5`: `python -m kev.serve --run jaredpalmer/kev-4b --port 8009` (binds 127.0.0.1), installed with `uv sync --extra serve`                         |
| Runtime   | MLX 0.32.2, mlx-lm 0.31.3, torch 2.8.0; the server reports backend `mlx`, dtype `bfloat16` (the published evaluations use fp32; the README bounds the difference at about 0.05)                            |
| Host      | Apple M1 Max, 32 GB                                                                                                                                                                                        |
| Transport | Copse `systemone` HTTP adapter from `main` (no derived fields needed), requested model `kev-latest`, `--concurrency 4`                                                                                     |

This is a different model from the 2026-09-22 run's Kev 0.5B (`jaredpalmer/kev-0.5b`).

| Split   | Prompt                  | Valid / planned | Correct | Wrong sandbox | Wrong external | Balanced accuracy | Median ms |
| ------- | ----------------------- | --------------: | ------: | ------------: | -------------: | ----------------: | --------: |
| dev     | original                |         100/100 |      57 |            35 |              8 |             0.608 |      1996 |
| dev     | explicit (dev-selected) |         100/100 |      61 |            31 |              8 |             0.642 |      2599 |
| holdout | original                |         100/100 |      79 |            15 |              6 |             0.699 |      2092 |
| holdout | explicit (dev-selected) |         100/100 |      81 |            11 |              8 |             0.754 |      2587 |

Median latency is per request at concurrency 4; the server batches concurrent
requests. Kev-4B is steadier across prompts than reflex or Winnow but leans towards
sandbox: it misses 11 of 29 external commands on the holdout. Combined with the
deterministic check, the development-selected weighted sum (weight 0.45, external at
≥ 0.55) reproduces the deterministic verdicts exactly on the holdout (87, 3 / 10), and
filtering first at P ≥ 0.5 trades two missed external commands for six false alarms
(83, 1 / 16). No combination improves on the deterministic check.
