# Terminal-Bench 2.1 profile ablation

Status: two complete attempts collated; `main-legacy@1` retained as the default. A corrected
`product-aligned@2` targeted follow-up is the next experiment.

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
worker and selects a shard-specific `COPSE_TERMINAL_RESULTS_ROOT` below it. A one-task oracle smoke
must produce reward 1 before redispatching the targeted matrix.

The next factorial should separate four hypotheses instead of changing them as a bundle:

1. workspace-aware `write_file` availability;
2. nonzero shell exits represented as error tool results;
3. generic inspect/edit/verify wording; and
4. authoritative validation-evidence guidance.

Requested-path extraction, provider-forced recovery, and SIGINT-specific warnings remain frozen in
`pr-1149@1`. They should not enter the regular agent without new held-out official-reward evidence.
