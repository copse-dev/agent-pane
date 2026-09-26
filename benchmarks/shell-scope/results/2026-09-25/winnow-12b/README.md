# Winnow-12B — shell-scope run, 2026-09-25

Run through `pnpm run eval:classifier` with the committed
[`inputs/classifier/`](../../../inputs/classifier) fixtures, scored by
[`score-classifier-eval.mjs`](../../../scripts/score-classifier-eval.mjs) and combined
with the deterministic verdicts by
[`combine-classifier-eval.mjs`](../../../scripts/combine-classifier-eval.mjs)
([tables](combinations.md)). Each JSONL file is the unmodified eval output.

| Item      | Value                                                                                                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model     | `EldanRing/Winnow-12B` commit `b2b14213dfa252e6d6b543c8b334762e51772d29`, `gguf/Winnow-12B-Q8_0.gguf` SHA-256 `b710efc4c0d048ee61eed92c5fef5ce323a4d17e7c51f9f0533cc72ae50818ea` |
| Server    | `EldanRing/winnow-inference` `77d14580c6732ca2f3745750c1dc1fd446d8bcee`: patched llama.cpp `911f6cdc8ab8a530b2bee09ee61471a6f3178eeb`, built by its `setup.py --text-only`       |
| Launch    | `python3 scripts/serve.py --profile apple-silicon --text-only --context 16384` (127.0.0.1:8091, one slot, Metal); server reports `Winnow-12B`                                    |
| Host      | Apple M1 Max, 32 GB                                                                                                                                                              |
| Transport | Copse `systemone` HTTP adapter from `main` (no derived fields needed), requested model `jev-latest`, `--concurrency 1`                                                           |

| Split   | Prompt                  | Valid / planned | Correct | Wrong sandbox | Wrong external | Balanced accuracy | Median ms |
| ------- | ----------------------- | --------------: | ------: | ------------: | -------------: | ----------------: | --------: |
| dev     | original                |         100/100 |      62 |            31 |              7 |             0.654 |      1906 |
| dev     | explicit (dev-selected) |         100/100 |      87 |             0 |             13 |             0.838 |      2475 |
| holdout | original                |         100/100 |      94 |             4 |              2 |             0.917 |      2059 |
| holdout | explicit (dev-selected) |         100/100 |      65 |             0 |             35 |             0.754 |      2471 |

Winnow alone is highly prompt-sensitive and the two splits disagree about which prompt
is better. The development-selected explicit prompt makes it answer external for
anything uncertain: no external command is missed, but 35 of 71 sandbox commands
are flagged (for example `wget --version`, `sh -c 'head -n 1 docs/guide.txt'`,
`python3 -c` reading a workspace file). The original prompt's 94/100 holdout is the
best single-model holdout recorded here, but development data would not have selected
it (62/100), so it is not a validated result.

Combined with the deterministic check (explicit prompt, all choices fitted on
development data):

| Strategy                                                                     | Holdout correct | Wrong sandbox / wrong external | Balanced |
| ---------------------------------------------------------------------------- | --------------: | -----------------------------: | -------: |
| Deterministic alone                                                          |              87 |                         3 / 10 |    0.878 |
| Weighted sum (dev-selected strategy; weight 0.05, external at ≥ 0.94)        |              90 |                          3 / 7 |    0.899 |
| Filter first: deterministic external final, Winnow adds external at P ≥ 0.99 |              88 |                         1 / 11 |    0.905 |

Both transfer from development data, unlike decider-4b's fitted variants. The
weighted sum is effectively Winnow with a high external threshold: it fixes two
`$TMPDIR` writes and four false external verdicts, but it also relaxes a deterministic
external verdict on `rg --files /workspace/project-old`, an outside read. The
filter-first variant never removes a deterministic warning; it fixes the two `$TMPDIR`
writes and adds one false alarm (`ls -l node_modules/.bin/electron …`). The
differences are one to three cases out of 100 on a 29-case external class, so neither
is established as an improvement.
