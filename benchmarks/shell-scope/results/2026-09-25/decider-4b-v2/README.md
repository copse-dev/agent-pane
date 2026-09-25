# decider-4b v2 — shell-scope run, 2026-09-25

Run through `pnpm run eval:classifier` with the committed
[`inputs/classifier/`](../../../inputs/classifier) fixtures and scored by
[`score-classifier-eval.mjs`](../../../scripts/score-classifier-eval.mjs). Each JSONL
file is the unmodified eval output: one record per fixture with its expected label,
the typed answer and probabilities, the returned model identity and wall-clock time.

| Item        | Value                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| Model       | `Mapika/decider-4b`, tag `v2`, commit `49564ddcfccafb6db563eb757c1d41e6c78dcb56`; server reports `decider-4b-v2` |
| Weights     | `model.safetensors` SHA-256 `69e6895461c425c6469cd304838a2e5673141613c2da04782026e37c1481d936`                   |
| Server      | `decider-ai` 1.4.0, `uvicorn decider.serve:app --host 127.0.0.1 --port 8000`, `DECIDER_DEVICE=mps`, offline Hub  |
| Runtime     | Python 3.12.6, torch 2.14.0, Transformers 5.17.0; MPS float16, no CUDA kernels                                   |
| Host        | Apple M1 Max, 32 GB, while other work shared the machine                                                         |
| Transport   | Copse `systemone` HTTP adapter from `main` (no derived fields needed), `--concurrency 4`                         |
| Temperature | The checkpoint's fitted 1.935 for every question type                                                            |

Scores (the verdict is the likelier scope; a tie reads as external):

| Split   | Prompt                  | Valid / planned | Correct | Wrong sandbox | Wrong external | Balanced accuracy | Median ms |
| ------- | ----------------------- | --------------: | ------: | ------------: | -------------: | ----------------: | --------: |
| dev     | original                |         100/100 |      47 |            46 |              7 |             0.529 |      1821 |
| dev     | explicit (dev-selected) |         100/100 |      52 |            42 |              6 |             0.575 |      2792 |
| holdout | original                |         100/100 |      80 |            18 |              2 |             0.676 |      1838 |
| holdout | explicit (dev-selected) |         100/100 |      87 |            13 |              0 |             0.776 |      2779 |

Median latency is per request at concurrency 4 on a shared machine, not a serial
latency figure. A single warm request took 0.7–1.2 s.

The holdout's 87/100 equals the deterministic baseline's count, but only because the
holdout is 71% sandbox: decider leans heavily towards `sandbox`. Its 13 holdout errors
all label an external command sandbox. Eleven reach outside the workspace through a
path argument: a `../` or sibling path such as `/workspace/other` or
`/workspace/project-old`, given to `cp`, `mv`, `tar`, `sed`, `rg`, `du`, a `command`
wrapper or inline Python. The other two have unknown effects: an unseen archive's
extraction and a path read from a file. The deterministic check misses 3 external
commands; decider's balanced accuracy is 0.776 against the deterministic check's
0.878. A P(external) cut-off fitted on development data (0.09, development balanced
accuracy 0.792) does not transfer: on the holdout it gives 64 correct, 2 wrong
sandbox and 34 wrong external. No threshold or policy is adopted from this run.
Combinations with the deterministic check are in [combinations.md](combinations.md): the
equal-weight sum equals the deterministic check, filtering first helps the holdout (89)
but hurts development data (72 against 76), and the dev-fitted variants do not transfer.
