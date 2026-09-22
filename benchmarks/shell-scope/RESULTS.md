# Recorded shell-scope results

Assistant labels; independent human review pending. This is not an authorization policy.

| Candidate | Split   | Prompt                  | Valid / planned | Correct | Wrong sandbox | Wrong external | Raw .85 accepted / wrong | Fitted accepted / wrong |
| --------- | ------- | ----------------------- | --------------: | ------: | ------------: | -------------: | -----------------------: | ----------------------: |
| laya      | dev     | original (dev-selected) |         100/100 |      42 |            58 |              0 |                      0/0 |                     0/0 |
| laya      | dev     | explicit                |         100/100 |      40 |            54 |              6 |                      0/0 |                     0/0 |
| laya      | holdout | original (dev-selected) |         100/100 |      71 |            29 |              0 |                      0/0 |                     0/0 |
| laya      | holdout | explicit                |         100/100 |      70 |            27 |              3 |                      0/0 |                     0/0 |
| kev       | dev     | original                |         100/100 |      62 |             8 |             30 |                      1/0 |                     1/0 |
| kev       | dev     | explicit (dev-selected) |         100/100 |      60 |             0 |             40 |                      6/0 |                     6/0 |
| kev       | holdout | original                |         100/100 |      35 |             4 |             61 |                      0/0 |                     0/0 |
| kev       | holdout | explicit (dev-selected) |         100/100 |      29 |             0 |             71 |                      5/2 |                     5/2 |
| laya-base | dev     | original (dev-selected) |         100/100 |      41 |            58 |              1 |                      0/0 |                     0/0 |
| laya-base | dev     | explicit                |           0/100 |     N/A |             0 |              0 |                      0/0 |                     0/0 |
| laya-base | holdout | original (dev-selected) |         100/100 |      71 |            29 |              0 |                      0/0 |                     0/0 |
| laya-base | holdout | explicit                |           0/100 |     N/A |             0 |              0 |                      0/0 |                     0/0 |
| acp       | dev     | original (dev-selected) |         100/100 |      99 |             1 |              0 |                      0/0 |                     0/0 |
| acp       | dev     | explicit                |         100/100 |      99 |             1 |              0 |                      0/0 |                     0/0 |
| openjev   | dev     | original                |         100/100 |      43 |            55 |              2 |                      0/0 |                     0/0 |
| openjev   | dev     | explicit (dev-selected) |         100/100 |      53 |            44 |              3 |                      0/0 |                     0/0 |
| semif     | dev     | original                |         100/100 |      48 |            50 |              2 |                    92/47 |                     0/0 |
| semif     | dev     | explicit (dev-selected) |         100/100 |      81 |            10 |              9 |                     59/6 |                     2/0 |
| semif     | holdout | original                |         100/100 |      74 |            24 |              2 |                    91/21 |                     0/0 |
| semif     | holdout | explicit (dev-selected) |         100/100 |      54 |             6 |             40 |                    37/11 |                     4/0 |
| openjev   | holdout | original                |         100/100 |      70 |            29 |              1 |                      0/0 |                     0/0 |
| openjev   | holdout | explicit (dev-selected) |         100/100 |      75 |            20 |              5 |                      0/0 |                     0/0 |

No probability policy exists for categorical-only models. Missing/context-error outputs are not correct judgments; their planned cases remain in coverage denominators.

See README.md for deterministic results, model identities, blockers, latency caveats and interpretation.
