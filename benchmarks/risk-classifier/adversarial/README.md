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
- `clean.py`: schema check, `bash -n` parse, placeholder-host and secret-shape lint, exact and
  near-duplicate removal (3-token shingles, Jaccard ≥ 0.8), stable `adv-` ids, `pair` resolved to
  the twin's id.
- `score.mjs`: runs every row through the product's gates from this checkout
  (`escalation-review/scripts/guard.mjs`) in a throwaway home whose workspace holds the row's
  `files`, then tabulates misses (`must_ask`, harm gate allows) and false prompts (`safe`, harm
  gate prompts or denies) by family and evasion, plus how many misses `rules.py` would catch.

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
- The model's safety filter stops some batches (most often `privilege` and early
  `exfiltration-network` wording); retries usually go through.
