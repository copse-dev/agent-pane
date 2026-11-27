"""Does more data teach a model the must-ask families the gate misses? Leave one family out.

  python -I family_holdout.py --repo /repo --private <labelled.jsonl> --redteam <joined.jsonl> \
      --test-machine <name> [--train-machine studio]

`<joined.jsonl>` is `redteam_gen.py`'s output passed through `join_verdicts.mjs`, which adds
`harm_main` and `scope`.

For each must-ask family in the red-team set (`redteam_gen.py`: disguised variants of every family
real history produced), train on the public test set, the red-team variants of every *other*
family (the ones main's harm gate allowed weighted up, as the gate misses a veto exists for), and
real non-ask commands from the Studio. Then score:

- **caught**: of the held-out family's variants main's gate allowed, how many the model scores at or
  above the threshold (a veto would ask);
- **cost**: the share of the MacBook's real prompts, which nothing trained on, that the veto would
  newly ask about among those main's gate allows.

If more data were the limit, caught should rise with it while cost stays low.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from data import load_private, load_public_testset, normalise  # noqa: E402
import train as harness  # noqa: E402

THRESHOLDS = (0.3, 0.5, 0.7)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument("--private", type=Path, required=True)
    ap.add_argument("--redteam", type=Path, required=True)
    ap.add_argument("--train-machine", default="studio", help="extract.py --machine name whose real commands train")
    ap.add_argument("--test-machine", required=True, help="extract.py --machine name scored, never trained on")
    ap.add_argument("--miss-weight", type=int, default=5)
    args = ap.parse_args()

    public = [r for r in load_public_testset(args.repo)]
    private = load_private(args.private)
    raw = {json.loads(line)["id"]: json.loads(line)["command"] for line in args.private.open()}
    for r in private:
        r["raw"] = raw[r["id"]]
    redteam = []
    plain_ids = set()
    for line in args.redteam.open():
        row = json.loads(line)
        if row["wrapper"] == "plain":
            plain_ids.add(row["id"])
        redteam.append(
            {
                "id": row["id"], "family": row["family"], "text": normalise(row["command"], row["workspace"]), "raw": row["command"],
                "tier": "ask", "risky": True, "harm": row["harm_main"], "harm_main": row["harm_main"], "scope": row["scope"],
            }
        )
    studio_negatives = [r for r in private if r["machine"] == args.train_machine and r["tier"] != "ask"]
    macbook = [r for r in private if r["machine"] == args.test_machine]
    macbook_allowed = [r for r in macbook if r["harm_main"] == "allow" and r["tier"] != "ask"]
    macbook_prompts = sum(r["weight"] for r in macbook)

    families = sorted({r["family"] for r in redteam})
    print(f"{'held-out family':20} {'missed by main':>14}  " + "  ".join(f"caught@{t:<4} cost@{t:<4}" for t in THRESHOLDS) + "   model")
    totals: dict = {}
    for family in families:
        held = [r for r in redteam if r["family"] == family and r["harm_main"] == "allow"]
        if not held:
            continue
        others = [r for r in redteam if r["family"] != family]
        weighted = []
        for r in others:
            weighted += [r] * (args.miss_weight if r["harm_main"] == "allow" else 1)
        train_rows = [r for r in public if r["split"] == "train"] + weighted + studio_negatives
        for name, model in (("tfidf", harness.TfidfModel()), ("gbdt", harness.TreeModel())):
            model.fit(train_rows, [])
            predict = model.predict_rows if hasattr(model, "predict_rows") else (lambda rows, m=model: m.predict([r["text"] for r in rows]))
            p_held = [p["p_ask"] for p in predict(held)]
            p_mac = predict(macbook_allowed) if macbook_allowed else []
            cells = []
            for t in THRESHOLDS:
                caught = sum(p >= t for p in p_held)
                cost = sum(r["weight"] for r, p in zip(macbook_allowed, p_mac) if p["p_ask"] >= t)
                totals.setdefault((name, t), [0, 0, 0])
                totals[(name, t)][0] += caught
                totals[(name, t)][1] += len(held)
                totals[(name, t)][2] += cost
                cells.append(f"{caught:3}/{len(held):<3}   {cost / max(1, macbook_prompts):5.0%}  ")
            print(f"{family:20} {len(held):>14}  " + "  ".join(cells) + f"   {name}")
    # Real check: train on public + every red-team variant + MacBook negatives, nothing from the
    # Studio; score the Studio's real gate misses and the Studio prompts the veto would add.
    # Only plain (unwrapped) red-team variants, so no wrapper style can stand in for risk.
    print("\nreal held-out: Studio (trained on public, plain red-team variants, MacBook negatives)")
    plain = [r for r in redteam if r["id"] in plain_ids]
    weighted = []
    for r in plain:
        weighted += [r] * (args.miss_weight if r["harm_main"] == "allow" else 1)
    mac_negatives = [r for r in macbook if r["tier"] != "ask"]
    studio = [r for r in private if r["machine"] == args.train_machine]
    misses = [r for r in studio if r["tier"] == "ask" and r["harm_main"] == "allow"]
    studio_allowed = [r for r in studio if r["harm_main"] == "allow" and r["tier"] != "ask"]
    studio_prompts = sum(r["weight"] for r in studio)
    for name, model in (("tfidf", harness.TfidfModel()), ("gbdt", harness.TreeModel())):
        model.fit([r for r in public if r["split"] == "train"] + weighted + mac_negatives, [])
        predict = model.predict_rows if hasattr(model, "predict_rows") else (lambda rows, m=model: m.predict([r["text"] for r in rows]))
        pm = [p["p_ask"] for p in predict(misses)]
        pa = [p["p_ask"] for p in predict(studio_allowed)]
        for t in THRESHOLDS:
            cost = sum(r["weight"] for r, p in zip(studio_allowed, pa) if p >= t)
            print(f"  {name:6} P(ask) >= {t}: catches {sum(p >= t for p in pm)}/{len(misses)} real misses; asks about {cost / max(1, studio_prompts):.0%} more of the Studio's prompts")
    print()
    for (name, t), (caught, n, cost) in sorted(totals.items()):
        print(f"{name:6} P(ask) >= {t}: caught {caught}/{n} held-out gate misses ({caught / max(1, n):.0%}); mean MacBook cost per fold {cost / max(1, macbook_prompts) / len(families):.0%}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
