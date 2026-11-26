| all | must_ask | missed | miss rate | safe | false prompts | false-prompt rate |
| --- | -------: | -----: | --------: | ---: | ------------: | ----------------: |
| all |       40 |     22 |       55% |   20 |             1 |                5% |

| family                   | must_ask | missed | miss rate | safe | false prompts | false-prompt rate |
| ------------------------ | -------: | -----: | --------: | ---: | ------------: | ----------------: |
| macos-automation-privacy |        3 |      3 |      100% |    1 |             0 |                0% |
| process-control          |        1 |      1 |      100% |    1 |             0 |                0% |
| new:change-visibility    |        1 |      1 |      100% |    0 |             0 |                 - |
| persistence-system       |        8 |      7 |       88% |    5 |             0 |                0% |
| exfiltration-network     |        4 |      3 |       75% |    1 |             0 |                0% |
| messaging-spend          |        3 |      2 |       67% |    2 |             0 |                0% |
| destructive              |        7 |      2 |       29% |    3 |             1 |               33% |
| publish-release          |        4 |      1 |       25% |    2 |             0 |                0% |
| remote-machine           |        4 |      1 |       25% |    2 |             0 |                0% |
| secrets-credentials      |        4 |      1 |       25% |    1 |             0 |                0% |
| privilege                |        1 |      0 |        0% |    1 |             0 |                0% |
| new:agent-self-config    |        0 |      0 |         - |    1 |             0 |                0% |

| evasion            | must_ask | missed | miss rate | safe | false prompts | false-prompt rate |
| ------------------ | -------: | -----: | --------: | ---: | ------------: | ----------------: |
| interpreter        |        1 |      1 |      100% |    2 |             0 |                0% |
| heredoc            |        1 |      1 |      100% |    1 |             0 |                0% |
| config-indirection |       10 |      8 |       80% |    5 |             0 |                0% |
| script-file        |        5 |      4 |       80% |    2 |             0 |                0% |
| indirection        |        4 |      3 |       75% |    0 |             0 |                 - |
| shell-reentry      |        2 |      1 |       50% |    1 |             0 |                0% |
| chaining           |        2 |      1 |       50% |    1 |             0 |                0% |
| wrapper            |        2 |      1 |       50% |    0 |             0 |                 - |
| xargs-find         |        2 |      1 |       50% |    1 |             0 |                0% |
| none               |       20 |      9 |       45% |    8 |             1 |               13% |
| split-steps        |        1 |      0 |        0% |    1 |             0 |                0% |

rules.py would add a prompt to 0 of the 22 harm-gate misses.
