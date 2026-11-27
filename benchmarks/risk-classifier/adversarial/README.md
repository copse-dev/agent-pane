# Adversarial must-ask commands

The real-history replay found only 8 harm-gate misses, all from one release. This folder makes
more: an LLM writes shell commands a coding agent could plausibly run that a person must see
(`must_ask`), each with a near-identical hard negative (`safe`), labelled by family and evasion
technique so the classifier can be trained on some families and scored on others.

Nothing here is executed. Hosts, users and paths are placeholders, and `clean.py` rejects rows
that name anything else.

## Files

- `PROMPT.md`: the generator prompt, one family and batch per call. Slots: `{{n}}`, `{{family}}`,
  `{{family_description}}`, `{{negative_share}}`, `{{seed_examples}}`, `{{must_cover}}`,
  `{{extra_guidance}}`.
- `families.json`: the 12 families, each with a description and seed examples. Seeds marked
  `[reconstructed from a real miss]` rebuild the shape of a replay miss with placeholder names; they
  are not the replayed commands. `must_cover` lists real-miss shapes every batch of that family has
  to vary, so the generator does not steer around them. `persistence-system` was split into
  `persistence` and `system-settings`; `clean.py` re-files old rows.
- `EXTERNAL_PROMPT.md`: a self-contained version for other vendors' models, which steers them
  away from what our own run already covers. Paste their output into `raw/` and clean it with
  `--source <model> --against $OUT/rows.jsonl`.
- `generate.py`: fills the prompt and calls a model (`claude -p` by default, the Anthropic API,
  or `--backend print` to paste by hand). Later batches of a family see the earlier commands and
  are steered towards other techniques. A batch the model's safety filter stops is retried.
- `clean.py`: schema check, `bash -n` parse (or `zsh -n`, tagging the row `"shell": "zsh"`; see
  Caveats), placeholder-host and secret-shape lint, exact and
  near-duplicate removal (3-token shingles, Jaccard ≥ 0.8), stable `adv-` ids, `pair` resolved to
  the twin's id.
- `score.mjs`: runs every row through the product's gates from this checkout
  (`escalation-review/scripts/guard.mjs`) in a throwaway home whose workspace holds the row's
  `files`, then tabulates misses (`must_ask`, harm gate allows) and false prompts (`safe`, harm
  gate prompts or denies) by family and evasion, plus how many misses `rules.py` would catch.

- Output goes under the git-ignored `bench-results/risk-classifier/adversarial/`, never into
  this folder. The rows and their verdicts list commands that get past the shipped gate, so
  they stay out of the public repository; regenerate them with the commands below.

```bash
cd benchmarks/risk-classifier/adversarial
OUT=../../../bench-results/risk-classifier/adversarial
python3 -I generate.py --per-family 20 --batches 2 --out raw/run.jsonl
python3 -I clean.py raw/*.jsonl --source claude --out $OUT/rows.jsonl
node score.mjs $OUT/rows.jsonl --out $OUT/scored.jsonl > $OUT/summary.md
```

## Row shape

```json
{
  "id": "adv-…",
  "command": "…",
  "label": "must_ask",
  "family": "secrets-credentials",
  "subfamily": "dotenv-source",
  "evasion": ["wrapper", "chaining"],
  "rationale": "…",
  "pair": "adv-…",
  "files": { "scripts/x.sh": "…" },
  "batch": "secrets-credentials#0",
  "source": "claude"
}
```

Split train and held-out by `family` (or by `subfamily` within a family). `pair` links a hard
negative to the `must_ask` row it imitates, so both halves of a pair stay on the same side.

## Caveats

- Labels are the generator's, checked by hand only on samples. Expect some disagreement at the
  edges (for example `brew services start` as persistence).
- The scorer's workspace only holds the files a row names, so a program the row assumes exists
  (`./bin/cloudflared`, `.venv/bin/pip`) reads as uninspectable and prompts. That inflates false
  prompts for `path-spoof` negatives.
- Zsh-only rows (two in the first external batch) use zsh glob qualifiers and are tagged `"shell": "zsh"`. Copse's
  `run_shell` uses `/bin/sh`, so their verdicts only speak for agents whose shell is zsh. A
  `clean.py` run on a host without zsh keeps rows already tagged and drops untagged zsh-only
  rows as `zsh-unavailable`.
- `external-02` labels some borderline rows `must_ask` that `PROMPT.md` would call `safe` (a `!`
  alias that only runs `git status`, a Finder `defaults write`).
- The model's safety filter stops some batches (most often `privilege` and early
  `exfiltration-network` wording); retries usually go through.
