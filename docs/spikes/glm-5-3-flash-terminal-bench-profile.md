# GLM-5.3-Flash Terminal-Bench profile

Status: **evidence-backed experimental product recommendation**. The recommendation is opt-in; it is not a
claim about the model's published limits and is not yet suitable as the automatic default.

Every run recorded below was collected against the stealth route `openrouter:stealth/ox-alpha`, before
Zhipu revealed it on 26 August 2026 as GLM-5.3-Flash (`zai-org/GLM-5.3-Flash`, MIT, 320B total / 18B
active). The weights are the same model, so the observations carry, but they were gathered against the
pre-release endpoint and have not been re-run against the released one. A repeat on
`openrouter:z-ai/glm-5.3-flash` is the first thing to do before this profile is argued up to a default,
because serving configuration — not just weights — decides where a response ceiling bites.

## Profile

- route: `openrouter:z-ai/glm-5.3-flash` (formerly the stealth route `openrouter:stealth/ox-alpha`)
- reasoning effort: `medium`
- maximum output per provider response: 16,384 tokens, including hidden reasoning
- sampling: `temperature` 1, `top_p` 0.95 — Z.ai's published recommendation, not a Copse finding
- agent instruction used by the external screen: generic artifact/contract-first guidance

Copse exposes the route, reasoning level, sampling, and output cap in Settings. The instruction remains
benchmark-only until its mechanisms are isolated from the parameter change.

## Vendor recipe, and where this profile departs from it

Z.ai's [developer documentation](https://docs.z.ai/guides/llm/glm-5.3-flash) publishes a Recommended
Settings block: `temperature: 1`, `top_p: 0.95`, and `reasoning_effort: max`. The profile takes the
sampling pair verbatim — no run below varied sampling, so there is no Copse evidence that disagrees
with the vendor, and pinning the pair keeps an aggregator's own default from drifting underneath us.

It deliberately does not take `reasoning_effort: max`. The counterbalanced screen below scored
`medium` plus a response cap at 4/6 against 2/6 for a max-effort, uncapped baseline on the shell-agent
loop Copse actually runs. The vendor recommends a general-purpose depth for the model; this row
recommends a depth for one scenario, on evidence of that scenario, and says so on the affordance.

The [model card](https://huggingface.co/zai-org/GLM-5.3-Flash) publishes no usage recipe of its own —
only per-benchmark evaluation settings, which disagree with each other (`top_p` 0.95 for HLE, 1.0 for
NL2Repo and Terminal-Bench 2.1; `temperature` 0.95 for DeepSWE). Those are eval configuration, not a
recommendation, and nothing here is inferred from them. One is worth recording as context rather than
as a source: Zhipu's own Terminal-Bench 2.1 evaluation ran `max_new_tokens=65536`, four times the cap
this profile recommends, which is a reminder that the 16,384 figure is a Copse execution budget for an
interactive agent loop and not a claim about the model's capability ceiling.

## Evidence and limitations

The initial Terminal-Bench 2.1 run on an Apple M4 completed 7/24 tasks. Nineteen trials reached the
agent timeout, and remote provider calls accounted for most agent time. The Docker task VM was
Linux/arm64 while several task images were Linux/amd64, so native-build and nested-virtualization
tasks are excluded from profile-selection evidence.

Early paired observations were mixed but useful:

- `openssl-selfsigned-cert`: baseline and `high8k` both passed; `high8k` reduced agent time from
  about 190 seconds to 100 seconds.
- `cobol-modernization`: baseline and `high8k` failed; `medium8k` passed in about 526 seconds.
- `torch-tensor-parallelism`: baseline and `medium8k` both failed with different contract mistakes.

The final task-major, counterbalanced six-task screen compared the provider-default baseline
(`reasoning=max`, no output cap or added instruction) with `medium8k` (`reasoning=medium`, 8,192-token
cap, and artifact-first instruction):

| Terminal-Bench 2.1 task            | Baseline     | `medium8k`   | Observation                                                                                                              |
| ---------------------------------- | ------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `regex-log`                        | pass         | pass         | Baseline agent time was about 5:35 versus 6:02.                                                                          |
| `log-summary-date-ranges`          | pass         | pass         | Baseline agent time was about 2:36 versus 3:54.                                                                          |
| `merge-diff-arc-agi-task`          | fail         | pass         | `medium8k` finished in about 11:20; baseline failed verification after about 13:39.                                      |
| `llm-inference-batching-scheduler` | timeout/fail | timeout/fail | Both used the 30-minute limit; `medium8k` did not improve execution progress.                                            |
| `model-extraction-relu-logits`     | timeout/fail | timeout/fail | Both used the 15-minute limit; total completion tokens fell from 15,406 to 6,482.                                        |
| `cobol-modernization`              | timeout/fail | timeout/pass | The medium artifact passed despite timeout; baseline spent most of its budget investigating and saved a faulty artifact. |

Aggregate reward was **2/6 for baseline versus 4/6 for `medium8k`**. The cap also bounded an observed
long-tail model-extraction response: baseline used 11,524 completion tokens in one response, while the
largest observed `medium8k` response used 5,204. Latency was not consistently better on tasks both
profiles passed.

### Instruction ablation

A follow-up held reasoning (`medium`) and the provider-response cap (8,192 tokens) constant, changing
only whether the generic artifact/contract-first instruction was present. The first three-task screen
was followed by two additional counterbalanced `cobol-modernization` pairs because that was the only
task whose result differed:

| Terminal-Bench 2.1 task        | No guidance                        | Artifact-first guidance            | Observation                                                                                          |
| ------------------------------ | ---------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `log-summary-date-ranges`      | pass, 5m, 5,681 output tokens      | pass, 7m, 9,735 output tokens      | Guidance was unnecessary and slower in this trial.                                                   |
| `merge-diff-arc-agi-task`      | pass, 11m, 10,975 output tokens    | pass, 14m, 13,572 output tokens    | Both passed; the unguided arm was faster.                                                            |
| `cobol-modernization`, trial 1 | timeout/fail, 9,183 output tokens  | timeout/pass, 18,658 output tokens | The unguided final response hit the 8K cap and was truncated before a usable artifact was preserved. |
| `cobol-modernization`, trial 2 | timeout/fail, 12,754 output tokens | timeout/fail, 8,736 output tokens  | Guidance produced an artifact, but it did not pass the verifier.                                     |
| `cobol-modernization`, trial 3 | timeout/fail, 21,768 output tokens | timeout/pass, 16,713 output tokens | The guided artifact passed six differential cases and the verifier despite the timeout.              |

The three-task screen was **3/3 guided versus 2/3 unguided**. Across the three repeated COBOL trials,
the result was **2/3 guided versus 0/3 unguided**. Unguided COBOL runs repeatedly spent most of the
15-minute budget probing edge cases and deferred writing the deliverable; the guidance made artifact
preservation more likely, but still did not reliably finish before timeout. The instruction was not a
general latency improvement on the two control tasks.

Several trials encountered transient OpenRouter shared-pool 429 responses, including the final guided
COBOL pass. Treat timing and token-count comparisons as noisy; verifier reward and the repeated
artifact-preservation pattern are the stronger observations.

These results continue to justify an editable experimental preset, not an automatic default. They did
not validate `medium`+8K as a default because Copse does not add the benchmark-only instruction, and
the 8K cap itself caused a truncated command payload in one unguided COBOL trial. That result motivated
the output-cap ablation below. The stronger product opportunity is a model-agnostic deadline policy:
checkpoint a runnable artifact before extended exploration, narrow validation as the task budget
expires, and preserve the best-known artifact before the final response. That behavior should be
evaluated separately from model settings.

### Output-cap ablation

An overnight follow-up began a no-guidance `medium` reasoning comparison of 8,192 versus 16,384 output
tokens per provider response. The first counterbalanced screen used architecture-light tasks so Docker
continued to provide Linux isolation without making AMD64 emulation the dominant variable:

| Terminal-Bench 2.1 task  | 8K cap                         | 16K cap                    | Interpretation                                                                                     |
| ------------------------ | ------------------------------ | -------------------------- | -------------------------------------------------------------------------------------------------- |
| `kv-store-grpc`          | pass, 14m, 6,229 output tokens | infrastructure error       | The 16K container failed while installing `tmux`; rerun required.                                  |
| `write-compressor`       | timeout/fail, 6,212 tokens     | timeout/fail, 1,832 tokens | Both stalled in long model responses; the 16K arm also recorded a shared-pool 429.                 |
| `pytorch-model-recovery` | timeout/fail, 8,822 tokens     | timeout/fail, 4,877 tokens | Both deferred the artifact during architecture exploration; the 8K arm retried after a rate limit. |

This screen is not sufficient to choose a cap. No completed response in these trials reached either
ceiling; the largest recorded response was 3,621 tokens. It does show that merely allowing a larger
response does not correct late artifact commitment. Transient OpenRouter rate limits and one container
setup failure prevent causal interpretation of the score. Repair runs should first restore the missing
16K control under a quieter provider window, then use short passing tasks before repeating
differentiated boundary cases.

Short repair/control runs under a later provider window produced cleaner parity evidence:

| Terminal-Bench 2.1 task   | 8K cap                             | 16K cap                           | Observation                                                               |
| ------------------------- | ---------------------------------- | --------------------------------- | ------------------------------------------------------------------------- |
| `kv-store-grpc`           | pass, 14m18s, 6,229 output tokens  | pass, 11m59s, 3,258 output tokens | The repaired 16K arm passed; neither arm approached its response ceiling. |
| `openssl-selfsigned-cert` | pass, 9m47s, 4,974 output tokens   | pass, 8m25s, 4,199 output tokens  | Both preserved and verified the artifact well before the closing turn.    |
| `pypi-server`             | infrastructure error; rerun needed | pass, 7m10s, 2,627 output tokens  | The 8K container failed before the model; 16K passed despite later 429s.  |

The missing PyPI control and final counterbalanced regex pair completed after the secure runner was
isolated under a stable local app identity:

| Terminal-Bench 2.1 task | 8K cap                                  | 16K cap                            | Observation                                                                                     |
| ----------------------- | --------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pypi-server`           | pass, 4m20s, 5,415 output tokens        | pass, 7m10s, 2,627 output tokens   | Both passed; the repaired 8K arm confirms the earlier failure was infrastructure-only.          |
| `regex-log`             | timeout/pass, 15m, 23,284 output tokens | pass, 11m05s, 15,906 output tokens | The 8K arm preserved a passing artifact but timed out; 16K finished almost four minutes sooner. |

The largest completed response in the earlier controls was 4,229 tokens. Passing reward parity below
both ceilings is useful regression evidence, but the repeated 8K truncation risk and the cleaner 16K
regex completion make 16K the safer opt-in experimental profile. This does not establish 16K as a
product default: the next parameter experiment should compare 12K with 16K on the COBOL boundary,
`merge-diff-arc-agi-task`, and a short control. Secure-runner startup failures that created neither a
Harbor job nor a runner log were excluded from model evidence.

### Product experiment: delayed checkpoint nudge

The instruction ablation favors artifact-first behavior on the repeated COBOL boundary, but applying
that instruction at turn start added latency and tokens to easy controls. A narrower product experiment
is a once-per-run, model-agnostic checkpoint nudge after approximately eight minutes of wall-clock work:

> The run is taking longer than expected. Preserve the best runnable artifact now before further
> exploration. Then use the remaining time for focused validation and fixes.

This timing would have avoided changing the short control tasks while firing before the 15-minute
boundary failures repeatedly deferred their deliverable. Copse already owns in-loop `stepBoundary`
nudges and a hard run deadline, but the canonical payload does not currently expose elapsed or
remaining wall time. A product implementation therefore belongs in that hook path: add deterministic
time-budget signals to the payload, keep a once-per-run gate in the harness, and record the applied
nudge in the thread spine. It must follow the hooks/feature-pack decisions log rather than adding a
separate continuation mechanism.

Validate the behavior behind an experimental switch before enabling it broadly:

1. Unit-test threshold, once-only, abort, and short-run abstention behavior with a fake clock.
2. Run a product-loop A/B on the COBOL boundary and two long tasks, holding model parameters constant.
3. Keep short passing controls to detect latency or premature-finalization regressions.
4. Promote only if artifact reward improves across repeats without reducing control-task reward.

Canonical benchmark comparisons should use native AMD64 Linux when available. Without such a host,
continue task-major, counterbalanced paired runs on Apple Silicon, favor architecture-light tasks, and
treat native-build or nested-virtualization results as diagnostic rather than profile-selection
evidence. Terminal-Bench remains the primary product benchmark because it exercises the shell-agent
loop directly; FrontierBench is useful as a supplemental generalization check.

## Product boundary

The 16K value is a user-selected execution cap, not the model's capability ceiling. Clearing it sends
no `max_tokens` field and restores the provider default. Per-chat reasoning can still override the
saved `medium` level.
