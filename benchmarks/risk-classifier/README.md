# Risk classifier benchmark

Which shell commands that prompt today could run without asking, and which must always reach a
person? This harness answers that on real Copse history from several machines, using held-out
machines rather than a random split, and compares three kinds of approver:

- the product's **deterministic gates** (scope, auto-approval tiers, the Guarded YOLO harm gate),
  replayed from source by [`../escalation-review/scripts/replay.mjs`](../escalation-review/scripts/replay.mjs);
- **learned models** trained here: TF-IDF with logistic heads, and a fine-tuned code encoder;
- **blends**: a model may only remove a prompt the harm gate already allows, and never one a
  must-ask rule names.

Each policy gets two numbers per held-out set: the share of today's prompts it removes, and how
many commands labelled `ask` it would have run unasked. The second must be zero. Results and the
design they support are in [`docs/plans/risk-classifier.md`](../../docs/plans/risk-classifier.md).

## Data

| Source                                                                                                                   | Licence   | Used for                                                                   |
| ------------------------------------------------------------------------------------------------------------------------ | --------- | -------------------------------------------------------------------------- |
| [`../escalation-review/testset`](../escalation-review/testset/README.md)                                                 | this repo | Rubric tiers; `dev` trains, `holdout` scores                               |
| [tomngdev/shell-safety-v1.1](https://huggingface.co/datasets/tomngdev/shell-safety-v1.1)                                 | MIT       | `ask`/`deny` as risky (its own policy), training only                      |
| [yannelli/cli-command-risk](https://huggingface.co/datasets/yannelli/cli-command-risk)                                   | CC BY 4.0 | `high`/`critical` as risky, training only                                  |
| [agentapprove/coding-agent-tool-call-safety](https://huggingface.co/datasets/agentapprove/coding-agent-tool-call-safety) | CC BY 4.0 | Any positive rule as risky; its sealed holdout is scored, never trained on |
| Your own Copse history                                                                                                   | private   | Rubric-labelled held-out sets; optionally training                         |

The public risk datasets follow their own policies, so they only train the `ask` head. Only rows
labelled against [`../escalation-review/rubric.md`](../escalation-review/rubric.md) train the tier
head.

Private rows never leave the machine. Everything private is written under the git-ignored
`bench-results/risk-classifier/` with `0600` permissions, and training runs in a container with
`--network none`.

## Running it

```bash
# 1. Extract each machine's shell calls and prompts (a copied store works: untar it first).
python3 -I benchmarks/risk-classifier/extract.py --machine studio --out bench-results/risk-classifier/data
python3 -I benchmarks/risk-classifier/extract.py --copse-dir /path/to/other/.copse --machine laptop \
  --out bench-results/risk-classifier/data

# 2. Label the prompted commands (and any that ran unsandboxed without a prompt) against the
#    rubric, then replay the product's gates over them with replay.mjs. The labelled file has one
#    row per command: id, machine, project, command, workspace, tier, prompts, harm, harm_main.

# 3. Train and score in a CPU container (Colima, Lima or Linux Docker).
docker build -t copse-risk:dev benchmarks/risk-classifier
docker run --rm --network none -v "$PWD":/repo:ro -v "$PWD/bench-results/risk-classifier/data":/data:ro \
  -v "$PWD/bench-results/risk-classifier/out/run":/out -v "$PWD/bench-results/risk-classifier/hf-cache":/root/.cache/huggingface \
  -e HF_HUB_OFFLINE=1 copse-risk:dev /work/train.py --repo /repo --hf /data/hf \
  --private /data/private-labelled.jsonl --out /out --models tfidf,encoder
```

The Hugging Face datasets and the encoder checkpoint are fetched once, in a step that mounts no
private data. `--train-private` adds the machines not named in `--heldout-machines` to the tier
training set. `report.json` holds every policy at every threshold and approval mode.

## Files

- `data.py` loads every source into one record shape and normalises paths (workspace, Copse
  worktrees and home become placeholders), so no model learns one developer's layout.
- `rules.py` is the experiment's copy of the must-ask rules the replay found missing; the product
  rules live in [`packages/shell-guard/src/release-actions.ts`](../../packages/shell-guard/src/release-actions.ts).
- `train.py` trains the models and replays every policy.
- `extract.py` reads a Copse store.
- `harness.test.py` checks the rules and the policy logic without any data:
  `python3 -I benchmarks/risk-classifier/harness.test.py`.
