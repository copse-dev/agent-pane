"""Train the shipped ask veto on public data only and export it for the product.

  python -I benchmarks/risk-classifier/export_veto.py --repo . \
      --out src/main/services/security/ask-veto-model.json [--split dev] [--private <labelled.jsonl>]

The model is gradient-boosted trees over `structured_features` (the harm gate's and scope
classifier's verdicts plus command-shape flags), predicting only P(ask). It trains on the public
escalation-review test set and nothing private, so the JSON can be committed. `--split dev` trains
on the dev split only, for scoring on holdout; the shipped model uses both splits.

Next to the model it writes `ask-veto-parity.json`: the features and probability for every public
case, which the TypeScript port must reproduce exactly. With `--private`, it also prints the veto's
effect on those held-out rows (they are never written).
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from data import load_public_testset  # noqa: E402
from train import FEATURE_PATTERNS, structured_features  # noqa: E402

VERDICT_FEATURES = ["harm=allow", "harm=prompt", "harm=deny", "scope=sandbox", "scope=ambiguous", "scope=external"]


def feature_names() -> list[str]:
    return list(FEATURE_PATTERNS) + ["segments", "length_per_100"] + VERDICT_FEATURES


def export(model) -> dict:
    trees = []
    for (predictor,) in model._predictors:
        nodes = predictor.nodes
        trees.append(
            [
                {"leaf": True, "value": float(n["value"])}
                if n["is_leaf"]
                else {"leaf": False, "feature": int(n["feature_idx"]), "threshold": float(n["num_threshold"]), "left": int(n["left"]), "right": int(n["right"])}
                for n in nodes
            ]
        )
    return {
        "version": 1,
        "kind": "gradient-boosted-trees/binary-logistic",
        "features": feature_names(),
        "patterns": {name: pattern for name, pattern in FEATURE_PATTERNS.items()},
        "baseline": float(model._baseline_prediction.ravel()[0]),
        "trees": trees,
    }


def predict(spec: dict, features: list[float]) -> float:
    raw = spec["baseline"]
    for tree in spec["trees"]:
        node = tree[0]
        while not node["leaf"]:
            node = tree[node["left"] if features[node["feature"]] <= node["threshold"] else node["right"]]
        raw += node["value"]
    return 1 / (1 + math.exp(-raw))


def main() -> int:
    from sklearn.ensemble import HistGradientBoostingClassifier

    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--split", choices=["dev", "all"], default="all")
    ap.add_argument("--private", type=Path)
    args = ap.parse_args()

    cases = load_public_testset(args.repo)
    train = [c for c in cases if args.split == "all" or c["split"] == "train"]
    model = HistGradientBoostingClassifier(
        max_iter=300, learning_rate=0.05, class_weight="balanced", random_state=7
    ).fit([structured_features(c) for c in train], [c["tier"] == "ask" for c in train])
    spec = export(model)
    args.out.write_text(json.dumps(spec, separators=(",", ":")) + "\n")

    parity = []
    for c in cases:
        f = structured_features(c)
        p = predict(spec, f)
        reference = float(model.predict_proba([f])[0][list(model.classes_).index(True)])
        assert abs(p - reference) < 1e-9, (c["id"], p, reference)
        parity.append({"id": c["id"], "command": c["text"], "harm": c["harm"], "scope": c["scope"], "features": f, "p": p})
    args.out.with_name("ask-veto-parity.json").write_text(json.dumps(parity, separators=(",", ":")) + "\n")
    print(f"{len(spec['trees'])} trees, {sum(len(t) for t in spec['trees'])} nodes, trained on {len(train)} public cases")

    if args.private:
        from train import load_private

        raw = {json.loads(line)["id"]: json.loads(line) for line in args.private.open()}
        rows = load_private(args.private)
        for row in rows:
            row["raw"] = raw[row["id"]]["command"]
        for machine in sorted({r["machine"] for r in rows}):
            subset = [r for r in rows if r["machine"] == machine]
            total = sum(r["weight"] for r in subset)
            for threshold in (0.05, 0.1, 0.2):
                allowed = [r for r in subset if r["harm_main"] == "allow" and predict(spec, structured_features({**r, "harm": r["harm_main"]})) < threshold]
                removed = sum(r["weight"] for r in allowed)
                asks = sum(1 for r in allowed if r["tier"] == "ask")
                print(f"  {machine:18} veto P(ask) < {threshold}: removes {removed / max(1, total):.0%} of prompts, ask approved {asks}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
