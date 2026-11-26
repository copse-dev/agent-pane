| all | must_ask | missed | miss rate | safe | false prompts | false-prompt rate |
| --- | -------: | -----: | --------: | ---: | ------------: | ----------------: |
| all |       33 |     16 |       48% |   13 |             1 |                8% |

| family                   | must_ask | missed | miss rate | safe | false prompts | false-prompt rate |
| ------------------------ | -------: | -----: | --------: | ---: | ------------: | ----------------: |
| macos-automation-privacy |        1 |      1 |      100% |    1 |             0 |                0% |
| process-control          |        1 |      1 |      100% |    1 |             0 |                0% |
| new:change-visibility    |        1 |      1 |      100% |    0 |             0 |                 - |
| persistence-system       |        6 |      5 |       83% |    2 |             0 |                0% |
| exfiltration-network     |        3 |      2 |       67% |    1 |             0 |                0% |
| messaging-spend          |        2 |      1 |       50% |    1 |             0 |                0% |
| secrets-credentials      |        3 |      1 |       33% |    0 |             0 |                 - |
| destructive              |        7 |      2 |       29% |    3 |             1 |               33% |
| publish-release          |        4 |      1 |       25% |    2 |             0 |                0% |
| remote-machine           |        4 |      1 |       25% |    1 |             0 |                0% |
| privilege                |        1 |      0 |        0% |    1 |             0 |                0% |

| evasion            | must_ask | missed | miss rate | safe | false prompts | false-prompt rate |
| ------------------ | -------: | -----: | --------: | ---: | ------------: | ----------------: |
| interpreter        |        1 |      1 |      100% |    0 |             0 |                 - |
| heredoc            |        1 |      1 |      100% |    1 |             0 |                0% |
| config-indirection |        8 |      6 |       75% |    2 |             0 |                0% |
| script-file        |        4 |      3 |       75% |    2 |             0 |                0% |
| indirection        |        3 |      2 |       67% |    0 |             0 |                 - |
| shell-reentry      |        2 |      1 |       50% |    1 |             0 |                0% |
| wrapper            |        2 |      1 |       50% |    0 |             0 |                 - |
| xargs-find         |        2 |      1 |       50% |    1 |             0 |                0% |
| none               |       16 |      6 |       38% |    6 |             1 |               17% |
| chaining           |        1 |      0 |        0% |    1 |             0 |                0% |
| split-steps        |        1 |      0 |        0% |    1 |             0 |                0% |

rules.py would add a prompt to 0 of the 16 harm-gate misses.
