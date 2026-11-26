# Adversarial must-ask commands

The real-history replay found only 8 harm-gate misses, all from one release. This folder makes
more: an LLM writes shell commands a coding agent could plausibly run that a person must see
(`must_ask`), each with a near-identical hard negative (`safe`), labelled by family and evasion
technique so the classifier can be trained on some families and scored on others.

Nothing here is executed. Hosts, users and paths are placeholders, and `clean.py` rejects rows
that name anything else.

## Files

- `PROMPT.md`: the generator prompt, one family and batch per call. Slots: `{{n}}`, `{{family}}`,
  `{{family_description}}`, `{{negative_share}}`, `{{seed_examples}}`, `{{extra_guidance}}`.
- `families.json`: the 11 families, each with a description and seed examples (`[real miss]`
  from the replay, `[illustrative]` otherwise).
- `EXTERNAL_PROMPT.md`: a self-contained version for other vendors' models, which steers them
  away from what our own run already covers. Paste their output into `raw/` and clean it with
  `--source <model> --against sample/rows.jsonl`.
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

- `sample/`: the cleaned rows, their verdicts (`*scored.jsonl`) and summaries (`*summary.md`)
  for three sources. `rows.jsonl` is 497 rows from Claude through `generate.py`. `external-01`
  and `external-02` are 60 rows each from two other vendors' models through
  `EXTERNAL_PROMPT.md`, deduped against `rows.jsonl` and each other.

```bash
cd benchmarks/risk-classifier/adversarial
python3 -I generate.py --per-family 20 --batches 2 --out raw/run.jsonl
python3 -I clean.py raw/*.jsonl --source claude --out sample/rows.jsonl
node score.mjs sample/rows.jsonl --out sample/scored.jsonl
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
- Two `external-01` rows use zsh glob qualifiers and are tagged `"shell": "zsh"`. Copse's
  `run_shell` uses `/bin/sh`, so their verdicts only speak for agents whose shell is zsh. A
  `clean.py` run on a host without zsh keeps rows already tagged and drops untagged zsh-only
  rows as `zsh-unavailable`.
- `external-02` labels some borderline rows `must_ask` that `PROMPT.md` would call `safe` (a `!`
  alias that only runs `git status`, a Finder `defaults write`).
- The model's safety filter stops some batches (most often `privilege` and early
  `exfiltration-network` wording); retries usually go through.
