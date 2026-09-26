# GLiNER2.5-Decide over the `systemone` protocol

[GLiNER2.5-Decide](https://huggingface.co/fastino/GLiNER2.5-Decide) is a 340M-parameter
DeBERTa-v3-large encoder from Fastino. It is Apache-2.0 and not gated. It takes text plus a set of
typed questions and scores every permitted answer. It ships as a Python library (`gliner2`), with no
HTTP server and no hosted inference provider, so `server.py` wraps it in the `systemone` protocol
that Copse's HTTP classifier adapter speaks.

## Run it

```bash
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python "gliner2[local]"
.venv/bin/python benchmarks/classifiers/gliner-decide/server.py   # 127.0.0.1:8010, MPS/CUDA when available
pnpm run eval:classifier --config benchmarks/classifiers/gliner-decide.json \
  --input benchmarks/classifiers/smoke.jsonl --output /tmp/gliner-decide.jsonl
```

The first start downloads about 1.8 GB of fp32 weights and takes around 30 s to load. The server
serves one request at a time and binds loopback only.
`python3 benchmarks/classifiers/gliner-decide/server.test.py` checks the question mapping without
the model or its dependencies.

## How a Copse question maps to GLiNER

- **The `state`** is rendered as `key: value` lines, with nested values as JSON. That rendering
  is the text the model reads.
- **A `choice` question** becomes one classification head. Its options, with their descriptions,
  become the labels, and its instructions become the head's prompt. An option without a
  description uses its name.
- **A `score` question** becomes a head with one label per level. The answer is the likeliest
  level.
- **A boolean (`noul`) question** becomes a yes/no head. The question's `true` and `false`
  criteria describe the yes and no labels, with a generic statement for any that is missing. The
  answer is P(yes).
- **All heads are scored in a single forward pass.**

Each head is requested as softmax over every label (`multi_label` with `cls_threshold: 0` and
`class_act: "softmax"`). The answer therefore carries the full distribution that the adapter
validates, not only the winning label. With a plain call, `include_confidence` scores only the
chosen label.

## Results, 2026-09-26

Measured on an M1 Max: about 56 ms per single-question call on MPS, 355 ms on CPU.

### Shell scope (`benchmarks/shell-scope`, holdout-explicit, 100 commands)

Balanced accuracy for the sandbox/external choice, by input format:

| Input                                                                        |  Balanced accuracy | Mean P(external) on external / sandbox commands |
| ---------------------------------------------------------------------------- | -----------------: | ----------------------------------------------- |
| Full fixture state, fixture instructions and labels (what `server.py` sends) |              0.500 | 0.009 / 0.010                                   |
| Command only, fixture instructions and labels                                | 0.514 (best 0.549) | 0.857 / 0.826                                   |
| Command only, short question and labels                                      | 0.575 (best 0.610) | 0.31 / 0.21                                     |
| Command only, short labels, no question                                      | 0.585 (best 0.626) | 0.35 / 0.23                                     |

"Best" is the balanced accuracy at the best threshold, which is an optimistic ceiling. The
fixtures' long assumptions and instructions swamp the model. Even with the command alone it barely
separates the two classes.

### Escalation review (private eval, 696 commands the read tier prompts for)

The question is the six-way auto-approval `tier` from `benchmarks/escalation-review` (#3146):

| Model / input                                | Top-1 accuracy | AUC for must-ask | What it answers       |
| -------------------------------------------- | -------------: | ---------------: | --------------------- |
| Winnow-12B (reference point)                 |          0.796 |            0.948 | a spread of tiers     |
| GLiNER, fixture instructions as the question |          0.055 |            0.683 | `ask` for 686 of 696  |
| GLiNER, no question                          |          0.477 |            0.694 | `read` for 679 of 696 |
| GLiNER, no question, short labels            |          0.484 |            0.741 | `read` for 673 of 696 |

Always answering `read` scores 0.474. GLiNER collapses onto one label, and which label depends on
the wording. Its probabilities never reach 0.9. So in every auto-approval mode it approves either
almost nothing or almost everything, including 27–36 commands the reference labels `ask`. Gating it
with the Guarded YOLO harm gate still leaves 18–24 of them.

### Verdict

Zero-shot, GLiNER2.5-Decide is not usable for Copse's shell-scope or escalation decisions. Its
reported benchmark covers customer-operations routing (intent, sentiment, ticket queues), not
commands whose meaning depends on paths, flags, and shell composition. The remaining option is to
fine-tune it (the library supports LoRA) on the escalation-review labels, then score it on the
held-out regression set. The labels come from one developer's history, so any fine-tune would need
a broader set before its numbers mean much.
