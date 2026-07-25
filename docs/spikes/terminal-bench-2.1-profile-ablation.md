# Terminal-Bench 2.1 profile ablation

Status: two complete full-suite attempts and the corrected `product-aligned@2` targeted follow-up
are collated. `main-legacy@1` remains the default; product-aligned v2 is the only candidate worth
carrying into a broader screen.

## Evidence set

The comparison combines 534 scheduled trials: 89 Terminal-Bench 2.1 tasks, three profiles, and two
attempts. Attempt one is the valid union of [run 29992727497](https://github.com/copse-dev/agent-pane/actions/runs/29992727497)
and its four-task [gap fill 30005978222](https://github.com/copse-dev/agent-pane/actions/runs/30005978222).
The gap fill replaces the complete profile blocks for `password-recovery` and
`schemelike-metacircular-eval` and adds the omitted `reshard-c4-data` and `train-fasttext` blocks.
Attempt two is [run 30031236358](https://github.com/copse-dev/agent-pane/actions/runs/30031236358).
All 267 capsules from attempt two were retained even though infrastructure-invalid trials made the
workflow red.

The model, provider, context/output limits, command timeout, and task images were held constant.
An agent timeout is an official zero; other exceptions are infrastructure-invalid and are reported
separately. Solve rates below use all scheduled trials as the denominator.

| Profile             | Attempt one | Attempt two |           Combined | Median total tokens | Median elapsed | Median tool calls |
| ------------------- | ----------: | ----------: | -----------------: | ------------------: | -------------: | ----------------: |
| `main-legacy@1`     |       31/89 |       28/89 | **59/178 (33.1%)** |             234,593 |          317 s |                28 |
| `pr-1149@1`         |       28/89 |       27/89 |     55/178 (30.9%) |             168,963 |      **284 s** |                24 |
| `product-aligned@1` |       29/89 |       28/89 |     57/178 (32.0%) |         **147,753** |          286 s |            **21** |

The task-level bootstrap over the mean of the two attempts found:

- `pr-1149@1 - main-legacy@1`: -2.25 percentage points, 95% CI `[-7.87, +2.81]`.
- `product-aligned@1 - main-legacy@1`: -1.12 points, 95% CI `[-6.74, +5.06]`.

Neither interval excludes zero. The valid-verifier macro rewards were 0.333 for main, 0.316 for
PR #1149, and 0.324 for product-aligned. Product-aligned used 37% fewer median total tokens and 25%
fewer median tool calls than main, but did not improve reward.

## Precommitted held-out result

The 12-task cohort selected by the checked-in hash rule is the default-selection comparison. It
contains 24 scheduled trials per profile across the two attempts and no infrastructure-invalid
outcomes.

| Profile             |   Solves |    Reward | Median total tokens | Median elapsed | Difference from main |
| ------------------- | -------: | --------: | ------------------: | -------------: | -------------------: |
| `main-legacy@1`     | **5/24** | **20.8%** |             288,629 |      **337 s** |                    — |
| `pr-1149@1`         |     4/24 |     16.7% |         **189,225** |          423 s |         -4.17 points |
| `product-aligned@1` |     4/24 |     16.7% |             296,761 |          451 s |         -4.17 points |

Both candidate differences have a task-bootstrap 95% CI of `[-12.5, 0]`. Neither candidate beat
main on a held-out task across these attempts. PR elapsed was 25.7% higher and product-aligned
elapsed was 33.9% higher without additional solves. Neither profile meets the precommitted default
gate, so `main-legacy@1` remains the default.

## Stability and task evidence

- Main solved 22 tasks twice, 15 once, and 52 never.
- PR #1149 solved 21 twice, 13 once, and 55 never.
- Product-aligned solved 20 twice, 17 once, and 52 never.
- Thirteen tasks passed all six trials. Forty-five tasks never passed any profile.
- The four historical #1149 tasks produced one solve out of eight scheduled trials for every
  profile. Every solve was `cancel-async-tasks`; the other three tasks were never solved. These
  2.1 results agree with the historical null result, but are not numerically compared with the 2.0
  development runs in [the #1149 record](terminal-bench-pr-1149.md).

Several trajectories provide useful mechanism hypotheses without establishing general gains:

- `code-from-image`: main failed 0/2, while the two profiles with `write_file` passed 4/4. Explicit
  file-finalization capability is worth isolating.
- `fix-code-vulnerability`: main and product passed 4/4 collectively; PR failed 0/2 after writing
  pretty-printed multiline JSON to a JSONL deliverable. Forced early writes can damage
  format-sensitive outputs.
- `query-optimize`: product passed 2/2; main and PR failed 0/4 on the runtime threshold despite
  correct output. Product-style shell-error and generic guidance remain a plausible isolated
  hypothesis.
- `prove-plus-comm`: main and PR passed 4/4 collectively; product failed 0/2 because its v1
  `write_file` implementation forced `/app` while Harbor's working directory was `/workspace`.

## Invalid outcomes and adapter findings

Seven trials were infrastructure-invalid. Six failed while Python iterated the Node bridge stdout
with `ValueError: Separator is found, but chunk is longer than limit`; asyncio's subprocess reader
used its default 64 KiB line limit. One `mailman` verifier exceeded 1,800 seconds. Another 49 trials
ended in official `AgentTimeoutError` zeroes.

`product-aligned@1` was not the intended product-aligned arm. Its prompt, schema, and write command
hard-coded `/app`, so it could edit the wrong tree when the actual Harbor working directory differed.
Its profile hash also covered the profile flags and prompt but not the shared tool implementation.
Source commit provenance still distinguished runs, but the profile identity was not content-complete.

The corrected `product-aligned@2`:

- receives Harbor's discovered working directory through the bridge;
- describes `write_file` using regular-agent relative-path semantics;
- accepts relative paths and contained absolute paths, creates parent directories, and rejects
  lexical workspace escapes;
- retains generic recovery and nonzero-exit error semantics without requested-output parsing,
  forced tool choice, validation warnings, or task-specific SIGINT guidance;
- hashes an explicit prompt, tool, result, protocol, and recovery implementation contract; and
- raises the bounded subprocess JSONL limit to 8 MiB for all profiles.

Historical `product-aligned@1` profile metadata and hashes remain loadable. The unversioned
`product-aligned` CLI/workflow selection now resolves to v2.

## Relationship to PR #1149

Product-aligned v2 reused one capability hypothesis from #1149: exposing `write_file` alongside
`run_shell` so output finalization does not depend on shell quoting. It did not reuse the #1149
implementation or its benchmark-specific control policy. V2 changed the tool to accept
workspace-relative or contained absolute paths under Harbor's discovered working directory;
#1149's retained tool is rooted at `/app`.

Product-aligned v2 deliberately excludes #1149's requested-output extraction, provider-forced
constrained write, one-call recovery gate, validation-evidence warnings, and SIGINT/cancellation
warnings. Its other distinguishing behavior comes from regular-product semantics: nonzero shell
exits are error tool results, recovery nudges remain generic, and the prompt asks only for brief
inspection, concrete edits, and focused verification.

## Targeted follow-up

Run `code-from-image`, `fix-code-vulnerability`, `prove-plus-comm`, and `query-optimize` with
`main-legacy`, `pr-1149`, and corrected `product-aligned`, paired by task. This is a development
cohort chosen after inspecting the first study, so it can validate the v2 repair and identify
mechanisms for a later precommitted factorial experiment; it cannot justify a general benchmark
improvement by itself.

The first follow-up dispatch, [run 30054221355](https://github.com/copse-dev/agent-pane/actions/runs/30054221355),
was cancelled as infrastructure-invalid. Its first 18 retained trials all raised
`RewardFileNotFoundError`: packed workers remapped a shard-specific host directory onto the fixed
container results path, while Harbor passed that container-visible absolute path to the host Docker
daemon for verifier bind mounts. The verifier and Harbor therefore addressed different host
directories. These trials have no official reward and are excluded from profile comparisons. One
inspected `product-aligned@2` trajectory did write and compile the requested Coq proof under the
actual `/workspace`, which validates the path diagnosis but is not benchmark evidence.

The corrected fleet retains a shared host results parent at the same absolute path inside every
worker and selects a shard-specific `COPSE_TERMINAL_RESULTS_ROOT` below it. The one-task
[reward smoke 30057935988](https://github.com/copse-dev/agent-pane/actions/runs/30057935988)
produced official reward 1 before the matrix was redispatched.

### Corrected v2 result

[Run 30058297595](https://github.com/copse-dev/agent-pane/actions/runs/30058297595) completed all
24 trials, retained every capsule, and verified fleet teardown. All trials had an official reward
and none timed out or failed infrastructure.

| Profile             | Passed attempts | Tasks solved | Macro reward | Median total tokens | Median elapsed | Median tool calls |
| ------------------- | --------------: | -----------: | -----------: | ------------------: | -------------: | ----------------: |
| `main-legacy@1`     |             5/8 |          3/4 |        0.625 |             106,501 |           96 s |              25.5 |
| `pr-1149@1`         |             4/8 |          3/4 |        0.500 |             355,508 |          209 s |                39 |
| `product-aligned@2` |         **7/8** |      **4/4** |    **0.875** |             126,648 |       **90 s** |              26.5 |

| Task                     | `main-legacy@1` | `pr-1149@1` | `product-aligned@2` |
| ------------------------ | --------------: | ----------: | ------------------: |
| `code-from-image`        |             1/2 |         1/2 |             **2/2** |
| `fix-code-vulnerability` |             2/2 |         2/2 |                 2/2 |
| `prove-plus-comm`        |             2/2 |         1/2 |             **2/2** |
| `query-optimize`         |             0/2 |         0/2 |             **1/2** |

Against main, the task-level reward difference was -0.125 for #1149 with bootstrap 95% CI
`[-0.375, 0]`, and +0.250 for product-aligned v2 with CI `[0, 0.5]`. V2 used 18.9% more median
tokens than main but 6.4% less median elapsed time. The interval still includes zero and this is a
post-selected development cohort, so the result is directional evidence rather than a default
change.

The mechanisms are nevertheless informative. Product-aligned was the only profile without a
missing `code-from-image` output. The #1149 validation bundle still produced an unfinished Coq
proof. Five of six `query-optimize` trials produced correct but insufficiently fast SQL; the sole
v2 solve restricted the synset aggregation to qualifying words, but required 841,223 tokens,
84 tool calls, and 1,063 seconds. That is a real solve and a useful trajectory, not evidence that
the expensive search pattern should become normal agent behavior.

### Recommended next comparison

Drop `pr-1149@1` from further broad runs. A one-attempt `product-aligned@2` screen over the other
85 tasks can be compared descriptively with the existing two-attempt main corpus to locate likely
wins and regressions without paying for another baseline immediately. Because those runs differ in
source commit and time, that screen must not be used for the default-selection confidence claim.

If the broad screen remains positive, run `main-legacy@1` and `product-aligned@2` contemporaneously
on the precommitted 12-task cohort for the confirmatory comparison. Re-running both arms is the
cleanest design; reusing the two historical main attempts is acceptable only as a cheaper
exploratory shortcut because the legacy profile hash did not cover every shared adapter detail.

The next factorial should separate four hypotheses instead of changing them as a bundle:

1. workspace-aware `write_file` availability;
2. nonzero shell exits represented as error tool results;
3. generic inspect/edit/verify wording; and
4. authoritative validation-evidence guidance.

Requested-path extraction, provider-forced recovery, and SIGINT-specific warnings remain frozen in
`pr-1149@1`. They should not enter the regular agent without new held-out official-reward evidence.

### Product-aligned v3 reasoning checkpoint study

PR #1195 and a captured Qwen trace motivated a narrower reasoning experiment. The trace repeatedly
re-emitted the same headings, three-item restoration plan, and long prose blocks, while explicitly
observing that it was overcomplicating or confusing itself. Broad lexical markers such as
`actually`, `wait`, and `I need to` were rejected: an offline replay over the 49 valid capsules
available locally would have fired a six-marker-per-4k threshold on 29 trials, including 22 passes.

`product-aligned@3` therefore keeps v2's behavior except for a checkpointed reasoning cap. Every 2k
tokens, a reasoning-dominated stream is checked for first-person self-diagnosis, an exact long block
or heading repeated at least three times, a three-item plan repeated at least three times, or 100
list items. A clean stream continues to another checkpoint up to the product's 32k absolute limit.
A detected circle is recorded and enters the existing recovery path; its one retry remains capped
at 4k. `product-aligned@2` remains selectable for a paired targeted comparison, and checkpoint
decisions are retained separately from stream cuts.

The paired targeted study is [workflow run 30091741763](https://github.com/copse-dev/agent-pane/actions/runs/30091741763),
dispatched from commit `2bba08a35927070de93d5ab2662606ebd2879aa0`. It runs one attempt of v2 and
v3, task-major and order-counterbalanced, on 12 tasks: `code-from-image`,
`fix-code-vulnerability`, `query-optimize`, `prove-plus-comm`, `feal-linear-cryptanalysis`,
`make-mips-interpreter`, `password-recovery`, `mailman`, `circuit-fibsqrt`,
`break-filter-js-from-html`, `chess-best-move`, and `rstan-to-pystan`. Six `PRO2-S` hosts each run
two isolated workers with a 200 GiB volume; model, provider, 2k v2 cap, command timeout, and all
other harness settings are held constant. It completed at 3/12 for v2 and 4/12 for v3.

A second paired run, [workflow run 30099923512](https://github.com/copse-dev/agent-pane/actions/runs/30099923512),
completed at 2/12 for v2 and 5/12 for v3. Across both attempts, v2 solved 5/24 trials and v3 solved
9/24. Mean elapsed time fell from 618 to 512 seconds and median elapsed time from 406 to 391
seconds; provider requests fell from 896 to 746, tool calls from 945 to 922, and runaway cuts from
56 to 27. V3 made 106 checkpoint decisions: 79 clean expansions and 23 circle cuts.

This is directional product evidence, not a claim of statistical significance. Checkpoints fired
on 17 paired tasks; within those pairs v2 solved two and v3 solved three. Three further v3 gains
occurred without a checkpoint, showing the remaining run-to-run variance. The generic mechanism is
still worth carrying into the built-in Copse agent because both paired attempts improved reward
without a time or token-cost regression. Regular primary, parent-continuation, todo-worker, and
subagent loops now use the same reasoning checkpoints while preserving ordinary visible responses
up to the existing 32k product ceiling. ACP and other externally hosted agents remain unchanged;
the #1149 forced-write and task-specific warning mechanisms remain benchmark-only.

## Compact evidence retention

This note is the canonical human-readable findings record for the 2.1 study. It retains run and
commit links, fixed configuration, profile hashes through the linked manifests, aggregate rewards
and costs, confidence intervals, infrastructure exclusions, and mechanism-level conclusions. It
does not duplicate full transcripts or verifier logs in git.

Object Storage currently remains the reproducibility layer for complete capsules. For later runs,
retain the run manifest, shard indexes, machine-readable comparison report, and this findings note
indefinitely. After analysis is reproduced, redundant raw capsules with the same task/profile/outcome
may be expired while keeping discordant outcomes, infrastructure failures, and representative
pass/failure trajectories. No existing capsule deletion or lifecycle change is part of this study.
