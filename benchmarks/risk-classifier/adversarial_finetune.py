"""Fine-tune on the adversarial must-ask set and test on what training never saw.

  python -I adversarial_finetune.py --repo /repo --private <labelled.jsonl> --adversarial <joined.jsonl> \
      --test-machine <name> [--train-machine studio] [--models tfidf,encoder-mlx] [--with-files]

Rows come from the adversarial generator (`adversarial/`: one Claude source, two external models),
passed through `join_verdicts.mjs`, which adds this branch's `harm` and `scope`. Two held-out designs, pairs always on the same side because a pair shares
its family and source:

- **family**: train on every other family (all sources), test on one;
- **source**: train on the Claude rows, test on the external models' rows.

Training adds the public test set and the Studio's real commands (its `ask` rows as positives, the
rest as negatives). For each test set it reports, at several thresholds, the must-ask rows the gate
let through that the model would stop (`caught`), the hard negatives it would flag, and the prompts
a veto would add on the test machine's real history, which nothing trains on. `--with-files` appends the
contents of any script a row ships, to show what a model loses by seeing only the command line.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from data import load_private, load_public_testset, normalise  # noqa: E402
import train as harness  # noqa: E402

THRESHOLDS = (0.3, 0.5, 0.7)


def adversarial_rows(path: Path, with_files: bool) -> list[dict]:
    rows = []
    for line in path.open():
        r = json.loads(line)
        text = normalise(r["command"])
        if with_files and r["files"]:
            text += "\n" + "\n".join(f"# {name}\n{body[:1500]}" for name, body in r["files"].items())
        rows.append(
            {
                "id": r["id"], "source": r["source"], "family": r["family"], "text": text, "raw": r["command"],
                "tier": "ask" if r["label"] == "must_ask" else "local-write", "risky": r["label"] == "must_ask",
                "harm": r["harm"], "harm_main": r["harm"], "scope": r["scope"], "has_files": bool(r["files"]),
            }
        )
    return rows


def build(name: str, args):
    if name == "tfidf":
        return harness.TfidfModel()
    if name == "encoder-mlx":
        from mlx_encoder import MlxEncoderModel

        return MlxEncoderModel(args.encoder, args.epochs, 192 if args.with_files else 160, 7)
    raise SystemExit(f"unknown model {name}")


def evaluate(label: str, model, test: list[dict], mac_allowed: list[dict], mac_prompts: int) -> list[str]:
    misses = [r for r in test if r["risky"] and r["harm"] == "allow"]
    safe = [r for r in test if not r["risky"]]
    p_miss = [p["p_ask"] for p in model.predict([r["text"] for r in misses])] if misses else []
    p_safe = [p["p_ask"] for p in model.predict([r["text"] for r in safe])] if safe else []
    p_mac = [p["p_ask"] for p in model.predict([r["text"] for r in mac_allowed])]
    lines = []
    for t in THRESHOLDS:
        caught = sum(p >= t for p in p_miss)
        hidden = sum(1 for r, p in zip(misses, p_miss) if p < t and r["has_files"])
        added = sum(r["weight"] for r, p in zip(mac_allowed, p_mac) if p >= t)
        lines.append(
            f"{label:34} t={t}: caught {caught:3}/{len(misses):<3} gate misses"
            f" (still missed with a script file: {hidden:2}); hard negatives flagged {sum(p >= t for p in p_safe):2}/{len(safe):<3};"
            f" MacBook prompts added {added}/{mac_prompts}"
        )
    return lines


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument("--private", type=Path, required=True)
    ap.add_argument("--adversarial", type=Path, required=True)
    ap.add_argument("--train-machine", default="studio", help="extract.py --machine name whose real commands train")
    ap.add_argument("--test-machine", required=True, help="extract.py --machine name scored, never trained on")
    ap.add_argument("--models", default="tfidf")
    ap.add_argument("--designs", default="source,family")
    ap.add_argument("--with-files", action="store_true")
    ap.add_argument("--encoder", default="huggingface/CodeBERTa-small-v1")
    ap.add_argument("--epochs", type=int, default=3)
    args = ap.parse_args()

    public = [r for r in load_public_testset(args.repo) if r["split"] == "train"]
    private = load_private(args.private)
    studio = [r for r in private if r["machine"] == args.train_machine]
    mac = [r for r in private if r["machine"] == args.test_machine]
    mac_prompts = sum(r["weight"] for r in mac)
    # A veto only acts where the gate allowed; occurrences stand in for unprompted auto-runs.
    mac_allowed = [dict(r, weight=max(1, r["weight"])) for r in mac if r["harm"] == "allow" and r["tier"] != "ask"]
    adv = adversarial_rows(args.adversarial, args.with_files)
    print(f"{len(adv)} adversarial rows {Counter(r['source'] for r in adv)}; MacBook prompts {mac_prompts}")

    def fit(name: str, rows: list[dict]):
        return build(name, args).fit(public + studio + rows, [])

    for name in args.models.split(","):
        print(f"\n## {name}{' + script files' if args.with_files else ''}")
        if "source" in args.designs:
            model = fit(name, [r for r in adv if r["source"] == "claude"])
            for line in evaluate("source: train claude, test external", model, [r for r in adv if r["source"] != "claude"], mac_allowed, mac_prompts):
                print(line)
        if "family" in args.designs:
            totals = Counter()
            for family in sorted({r["family"] for r in adv if not r["family"].startswith("new:")}):
                model = fit(name, [r for r in adv if r["family"] != family])
                for line in evaluate(f"family held out: {family}", model, [r for r in adv if r["family"] == family], mac_allowed, mac_prompts):
                    print(line)
                    if " t=0.5:" in line:
                        caught, of = line.split("caught ")[1].split(" gate")[0].split("/")
                        totals["caught"] += int(caught)
                        totals["of"] += int(of)
            print(f"family folds, t=0.5: caught {totals['caught']}/{totals['of']} gate misses in total")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
