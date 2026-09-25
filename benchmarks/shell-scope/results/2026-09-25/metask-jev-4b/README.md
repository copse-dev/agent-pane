# metask-jev-4b — shell-scope run, 2026-09-25

Run through `pnpm run eval:classifier` with the committed
[`inputs/classifier/`](../../../inputs/classifier) fixtures, scored by
[`score-classifier-eval.mjs`](../../../scripts/score-classifier-eval.mjs) and combined
with the deterministic verdicts by
[`combine-classifier-eval.mjs`](../../../scripts/combine-classifier-eval.mjs)
([tables](combinations.md)). Each JSONL file is the unmodified eval output.

| Item      | Value                                                                                                                                                                                                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model     | `wayfind/metask-jev-4b-policy-mix` commit `ea20fe85b28733b1522721dec119bec50947a869`, `model.safetensors` SHA-256 `f4b40475d18e0a38638b985ed51816c012619e0d4138166704e2ea0aac7a12b3`                                                                                          |
| Server    | `metask-ai/metask-jev` `6cce2276d7898a9ed0122afbc49d0f0b74ccda98` `serve.py --port 8000`, with one local change: `app.run` binds `127.0.0.1` instead of the hardcoded `0.0.0.0` (no authentication). Per-type temperatures from the server: choice 1.9, noul 2.375, score 2.3 |
| Runtime   | torch 2.14.0, Transformers 5.17.0, Flask 3.1.3; MPS, without the `causal_conv1d` and `flash-linear-attention` kernels (reference PyTorch paths)                                                                                                                               |
| Host      | Apple M1 Max, 32 GB                                                                                                                                                                                                                                                           |
| Transport | Copse `systemone` HTTP adapter with copse-dev/agent-pane#3084's derived fields, `--concurrency 1`                                                                                                                                                                             |

metask's responses leave out the top-level `model` and each answer's `choice`. The
adapter on `main` rejects every answer (`invalid-response`); with #3084 the result
reports the requested model and the likeliest option, and lists both in
`metadata.derivedFields`. Verdicts here come from the probabilities either way. The
first attempt at concurrency 2 lost the server silently after 12 requests (threaded
Flask requests sharing MPS); every file here is from the serial rerun.

| Split   | Prompt                  | Valid / planned | Correct | Wrong sandbox | Wrong external | Balanced accuracy | Median ms |
| ------- | ----------------------- | --------------: | ------: | ------------: | -------------: | ----------------: | --------: |
| dev     | original                |         100/100 |      48 |            51 |              1 |             0.563 |      2693 |
| dev     | explicit (dev-selected) |         100/100 |      53 |            45 |              2 |             0.600 |      3472 |
| holdout | original                |         100/100 |      76 |            24 |              0 |             0.586 |      2933 |
| holdout | explicit (dev-selected) |         100/100 |      86 |            13 |              1 |             0.769 |      2758 |

Like decider-4b, metask leans heavily towards sandbox: 86/100 on the holdout comes from
the 71% sandbox split while it misses 13 of 29 external commands. Combined with the
deterministic check, the development-selected weighted sum (88 on development data)
falls to 64 on the holdout. Filtering first at P ≥ 0.5 reaches 89 on the holdout but is
worse than the deterministic check on development data (75 against 76), the same
pattern as decider-4b, so development data would not select it.
