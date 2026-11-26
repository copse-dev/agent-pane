| all | must_ask | missed | miss rate | safe | false prompts | false-prompt rate |
| --- | -------: | -----: | --------: | ---: | ------------: | ----------------: |
| all |      324 |    171 |       53% |  173 |            41 |               24% |

| family                   | must_ask | missed | miss rate | safe | false prompts | false-prompt rate |
| ------------------------ | -------: | -----: | --------: | ---: | ------------: | ----------------: |
| macos-automation-privacy |       26 |     18 |       69% |   14 |             3 |               21% |
| secrets-credentials      |       25 |     16 |       64% |   15 |             4 |               27% |
| persistence-system       |       53 |     31 |       58% |   27 |             4 |               15% |
| process-control          |       26 |     15 |       58% |   14 |             3 |               21% |
| supply-chain-remote-code |       25 |     14 |       56% |   12 |             4 |               33% |
| messaging-spend          |       26 |     14 |       54% |   14 |             3 |               21% |
| privilege                |       26 |     14 |       54% |   14 |             2 |               14% |
| remote-machine           |       26 |     14 |       54% |   14 |             4 |               29% |
| publish-release          |       39 |     20 |       51% |   21 |             6 |               29% |
| destructive              |       26 |      9 |       35% |   14 |             4 |               29% |
| exfiltration-network     |       26 |      6 |       23% |   14 |             4 |               29% |

| evasion            | must_ask | missed | miss rate | safe | false prompts | false-prompt rate |
| ------------------ | -------: | -----: | --------: | ---: | ------------: | ----------------: |
| script-file        |       74 |     60 |       81% |   26 |             1 |                4% |
| wrapper            |       91 |     67 |       74% |   44 |            10 |               23% |
| config-indirection |       34 |     22 |       65% |   15 |             4 |               27% |
| interpreter        |       59 |     36 |       61% |   18 |             7 |               39% |
| xargs-find         |       33 |     17 |       52% |   14 |             3 |               21% |
| heredoc            |       38 |     19 |       50% |   10 |             3 |               30% |
| chaining           |      169 |     79 |       47% |   87 |            18 |               21% |
| shell-reentry      |       22 |     10 |       45% |    6 |             2 |               33% |
| split-steps        |       40 |     18 |       45% |   15 |             5 |               33% |
| indirection        |       52 |     20 |       38% |   19 |             8 |               42% |
| encoding           |       34 |     10 |       29% |    6 |             2 |               33% |
| path-spoof         |       19 |      3 |       16% |    9 |             9 |              100% |
| none               |        5 |      0 |        0% |   13 |             3 |               23% |

rules.py would add a prompt to 3 of the 171 harm-gate misses.
