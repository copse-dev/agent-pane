"""Train and score risk classifiers for shell commands, and replay them as approval policies.

  python -I train.py --repo /repo --hf /data/hf --private /data/private.jsonl --out /out \
      [--models tfidf,encoder] [--encoder huggingface/CodeBERTa-small-v1]

Every model answers two questions about a command: its rubric tier, and P(ask) (a person must see
it). A policy auto-approves a command only when the product's harm gate allows it, no must-ask rule
fires, P(ask) is below a threshold and the predicted tier is within the approval mode. The scorer
reports, per policy and held-out set, how many of today's prompts it removes and how many
commands labelled `ask` it would have let through. The second number has to be zero.

Training never sees a held-out row: the public test set's holdout split, any private machine named
in --heldout-machines, and agent-approve's sealed holdout.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from data import (  # noqa: E402
    TIERS,
    load_agent_approve,
    load_cli_risk,
    load_private,
    load_public_testset,
    load_shell_safety,
)
from rules import must_ask  # noqa: E402

MODES = {
    "local-write": {"read", "local-write"},
    "outside-read": {"read", "local-write", "outside-read"},
    "remote-write": {"read", "local-write", "remote-write"},
    "outside-write": {"read", "local-write", "outside-read", "outside-write"},
}
THRESHOLDS = [0.02, 0.05, 0.1, 0.2, 0.3, 0.5]


# ----------------------------------------------------------------------------- models


class TfidfModel:
    """Character and word n-grams with two logistic heads: tier (tiered rows only) and ask
    (every row, including the public risk datasets)."""

    name = "tfidf-lr"

    def fit(self, tiered: list[dict], risk: list[dict]) -> "TfidfModel":
        from scipy.sparse import hstack
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.linear_model import LogisticRegression

        self.char = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 5), min_df=2, sublinear_tf=True, max_features=200_000)
        self.word = TfidfVectorizer(token_pattern=r"[A-Za-z_][\w.-]+|--?[\w-]+", ngram_range=(1, 2), min_df=2, sublinear_tf=True, max_features=100_000)
        corpus = [r["text"] for r in tiered + risk]
        self.char.fit(corpus)
        self.word.fit(corpus)
        self._hstack = hstack
        x_tier = self._x([r["text"] for r in tiered])
        y_tier = [r["tier"] for r in tiered]
        self.tier = LogisticRegression(max_iter=4000, C=4.0, class_weight="balanced").fit(x_tier, y_tier)
        import numpy as np

        both = tiered + risk
        weights = np.array([3.0 if r.get("tier") else 1.0 for r in both])
        self.ask = LogisticRegression(max_iter=4000, C=4.0, class_weight="balanced").fit(
            self._x([r["text"] for r in both]), [bool(r["risky"]) for r in both], sample_weight=weights
        )
        return self

    def _x(self, texts):
        return self._hstack([self.char.transform(texts), self.word.transform(texts)]).tocsr()

    def predict(self, texts: list[str]) -> list[dict]:
        x = self._x(texts)
        tier_p = self.tier.predict_proba(x)
        ask_p = self.ask.predict_proba(x)[:, list(self.ask.classes_).index(True)]
        classes = list(self.tier.classes_)
        out = []
        for row, p_ask in zip(tier_p, ask_p):
            probs = dict(zip(classes, row))
            out.append({"tier": classes[int(row.argmax())], "probs": probs, "p_ask": float(max(p_ask, probs.get("ask", 0.0)))})
        return out


class EncoderModel:
    """A small pretrained code encoder fine-tuned with the same two heads. CPU only; the ask head
    trains on every row, the tier head only where a tier is known."""

    name = "encoder"

    def __init__(self, checkpoint: str, epochs: int, max_len: int, seed: int, device: str = "cpu"):
        self.checkpoint, self.epochs, self.max_len, self.seed = checkpoint, epochs, max_len, seed
        self.device = device

    def fit(self, tiered: list[dict], risk: list[dict]) -> "EncoderModel":
        import torch
        from torch import nn
        from transformers import AutoModel, AutoTokenizer

        torch.manual_seed(self.seed)
        self.torch = torch
        self.tok = AutoTokenizer.from_pretrained(self.checkpoint)
        base = AutoModel.from_pretrained(self.checkpoint)
        hidden = base.config.hidden_size

        class Net(nn.Module):
            def __init__(self):
                super().__init__()
                self.base = base
                self.drop = nn.Dropout(0.1)
                self.tier = nn.Linear(hidden, len(TIERS))
                self.ask = nn.Linear(hidden, 1)

            def forward(self, **enc):
                h = self.base(**enc).last_hidden_state[:, 0]
                h = self.drop(h)
                return self.tier(h), self.ask(h).squeeze(-1)

        self.net = Net().to(self.device)
        rows = tiered * 3 + risk  # tiered rows are scarcer and carry both labels
        random.Random(self.seed).shuffle(rows)
        tier_counts = Counter(r["tier"] for r in tiered)
        tier_weight = torch.tensor([len(tiered) / (len(TIERS) * max(1, tier_counts[t])) for t in TIERS], dtype=torch.float).to(self.device)
        pos = sum(1 for r in rows if r["risky"])
        ask_pos_weight = torch.tensor((len(rows) - pos) / max(1, pos)).to(self.device)
        opt = torch.optim.AdamW(self.net.parameters(), lr=3e-5, weight_decay=0.01)
        batch = 32
        steps = self.epochs * ((len(rows) + batch - 1) // batch)
        sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=3e-5, total_steps=steps, pct_start=0.1)
        ce = nn.CrossEntropyLoss(weight=tier_weight, reduction="none")
        bce = nn.BCEWithLogitsLoss(pos_weight=ask_pos_weight)
        self.net.train()
        step = 0
        for epoch in range(self.epochs):
            random.Random(self.seed + epoch).shuffle(rows)
            for i in range(0, len(rows), batch):
                chunk = rows[i : i + batch]
                enc = self.tok([r["text"] for r in chunk], truncation=True, max_length=self.max_len, padding=True, return_tensors="pt").to(self.device)
                tier_logits, ask_logits = self.net(**enc)
                has_tier = torch.tensor([r.get("tier") is not None for r in chunk], device=self.device)
                tier_y = torch.tensor([TIERS.index(r["tier"]) if r.get("tier") else 0 for r in chunk], device=self.device)
                ask_y = torch.tensor([1.0 if r["risky"] else 0.0 for r in chunk], device=self.device)
                loss = bce(ask_logits, ask_y)
                if has_tier.any():
                    loss = loss + (ce(tier_logits, tier_y) * has_tier).sum() / has_tier.sum()
                opt.zero_grad()
                loss.backward()
                torch.nn.utils.clip_grad_norm_(self.net.parameters(), 1.0)
                opt.step()
                sched.step()
                step += 1
                if step % 200 == 0:
                    print(f"  encoder epoch {epoch} step {step}/{steps} loss {loss.item():.3f}", flush=True)
        self.net.eval()
        return self

    def predict(self, texts: list[str]) -> list[dict]:
        torch = self.torch
        out = []
        with torch.no_grad():
            for i in range(0, len(texts), 64):
                enc = self.tok(texts[i : i + 64], truncation=True, max_length=self.max_len, padding=True, return_tensors="pt").to(self.device)
                tier_logits, ask_logits = self.net(**enc)
                tier_p = torch.softmax(tier_logits, -1).cpu().numpy()
                ask_p = torch.sigmoid(ask_logits).cpu().numpy()
                for row, p_ask in zip(tier_p, ask_p):
                    probs = dict(zip(TIERS, row.tolist()))
                    out.append({"tier": TIERS[int(row.argmax())], "probs": probs, "p_ask": float(max(p_ask, probs["ask"]))})
        return out


# Structured signals for the tree model: the product's own verdicts plus what the command does.
FEATURE_PATTERNS = {
    "network": r"\b(curl|wget|ssh|scp|rsync|nc|gh|git (push|fetch|pull|clone)|npm (publish|install)|pip install)\b",
    "remote_shell": r"\b(ssh|scp|sftp|mosh)\b",
    "delete": r"\brm\s+-\S*[rf]|\bfind\b[^\n]*-delete|\bgit (reset --hard|clean -f)",
    "privilege": r"\b(sudo|doas|su -|launchctl|osascript|screencapture|pkill|killall|security)\b",
    "secret": r"(?<![\w])\.env\b|id_(rsa|ed25519)|\.ssh\b|TOKEN|SECRET|PRIVATE_KEY|PASSWORD|keychain",
    "publish": r"\b(publish|release|deploy|ship)\b|refs/tags|--tags",
    "interpreter_inline": r"\b(python3?|node|ruby|perl|bash|sh|zsh)\s+(-c|-e|--eval|-)\b|<<",
    "pipe_to_shell": r"\|\s*(sudo\s+)?(ba|z)?sh\b",
    "substitution": r"\$\(|`",
    "home_path": r"(^|[\s\"'=])(~|\$HOME)",
    "abs_outside": r"(^|[\s\"'=])/(?!dev/null)(etc|usr|opt|Applications|Library|tmp|private|var)\b",
    "tmp": r"/tmp\b|\$TMPDIR|mktemp",
    "redirect_write": r"[^2&]>\s*[^&\s]",
    "package_install": r"\b(npm (i|install|ci)|pnpm (i|install|add)|yarn add|pip3? install|brew install|cargo install)\b",
    "build_test": r"\b(test|build|check|lint|typecheck|tsc|cargo (build|check|test)|make|swift (build|test))\b",
    "git_local": r"\bgit (status|log|diff|show|add|commit|checkout|switch|branch|stash|rev-parse)\b",
    "toolchain": r"\b(corepack|fnm|nvm|rustup|xcrun|DEVELOPER_DIR)\b",
    "read_only": r"^\s*(ls|cat|head|tail|grep|rg|sed -n|wc|find|git (status|log|diff|show))\b",
}


USE_VERDICTS = True


def structured_features(row: dict) -> list[float]:
    import re

    text = row.get("raw") or row["text"]
    feats = [1.0 if re.search(p, text) else 0.0 for p in FEATURE_PATTERNS.values()]
    segments = [s for s in re.split(r"&&|\|\||;|\n|\|", text) if s.strip()]
    feats += [len(segments), min(len(text), 4000) / 100.0]
    if not USE_VERDICTS:
        return feats
    # Real rows carry `harm_main`, the gate before this study's rules: a veto is measured on the
    # families no rule knows yet, so it must not see the verdict those rules produce.
    harm = row.get("harm_main", row.get("harm"))
    feats += [1.0 if harm == v else 0.0 for v in ("allow", "prompt", "deny")]
    feats += [1.0 if row.get("scope") == v else 0.0 for v in ("sandbox", "ambiguous", "external")]
    return feats


class TreeModel:
    """Gradient-boosted trees over structured signals (product verdicts and command shape), not
    raw text. Only tiered rows carry the product verdicts, so the public risk sets are not used."""

    name = "gbdt"

    def fit(self, tiered: list[dict], risk: list[dict]) -> "TreeModel":
        from sklearn.ensemble import HistGradientBoostingClassifier

        x = [structured_features(r) for r in tiered]
        self.tier = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, class_weight="balanced", random_state=7).fit(x, [r["tier"] for r in tiered])
        self.ask = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, class_weight="balanced", random_state=7).fit(x, [r["tier"] == "ask" for r in tiered])
        return self

    def predict_rows(self, rows: list[dict]) -> list[dict]:
        x = [structured_features(r) for r in rows]
        tier_p = self.tier.predict_proba(x)
        ask_p = self.ask.predict_proba(x)[:, list(self.ask.classes_).index(True)]
        classes = list(self.tier.classes_)
        return [
            {"tier": classes[int(t.argmax())], "probs": dict(zip(classes, t)), "p_ask": float(max(a, dict(zip(classes, t)).get("ask", 0.0)))}
            for t, a in zip(tier_p, ask_p)
        ]


# ----------------------------------------------------------------------------- policies


def decide(row: dict, pred: dict | None, mode: str, threshold: float, use_rules: bool, harm_key: str = "harm") -> bool:
    """True when the policy would run the command without asking. `harm_key` picks the harm
    gate: "harm" is this branch's, "harm_main" the one it was measured against."""
    if row.get(harm_key, row.get("harm")) != "allow":
        return False
    if use_rules and must_ask(row.get("raw") or row["text"]):
        return False
    if pred is None:  # harm gate (+ rules) alone
        return True
    return pred["p_ask"] < threshold and pred["tier"] in MODES[mode]


def score(rows: list[dict], preds: list[dict | None], mode: str, threshold: float, use_rules: bool, harm_key: str = "harm") -> dict:
    prompts = sum(r.get("weight", 1) for r in rows)
    approved = approved_ask = over_tier = 0
    for row, pred in zip(rows, preds):
        if decide(row, pred, mode, threshold, use_rules, harm_key):
            approved += row.get("weight", 1)
            if row["tier"] == "ask":
                approved_ask += 1
            elif row["tier"] not in MODES[mode]:
                over_tier += 1
    return {"prompts": prompts, "removed": approved, "removed_pct": round(100 * approved / max(1, prompts), 1), "ask_approved": approved_ask, "over_tier": over_tier}


def tier_metrics(rows: list[dict], preds: list[dict]) -> dict:
    labelled = [(r, p) for r, p in zip(rows, preds) if r.get("tier")]
    acc = sum(r["tier"] == p["tier"] for r, p in labelled) / max(1, len(labelled))
    asks = [(r, p) for r, p in labelled if r["tier"] == "ask"]
    from sklearn.metrics import roc_auc_score

    y = [r["tier"] == "ask" for r, _ in labelled]
    auc = roc_auc_score(y, [p["p_ask"] for _, p in labelled]) if 0 < sum(y) < len(y) else None
    return {"n": len(labelled), "tier_accuracy": round(acc, 3), "asks": len(asks), "ask_auc": None if auc is None else round(auc, 3)}


# ----------------------------------------------------------------------------- main


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument("--hf", type=Path, required=True)
    ap.add_argument("--private", type=Path)
    ap.add_argument("--heldout-machines", default="KingstonSlicedMax,test-mac-box")
    ap.add_argument("--train-private", action="store_true", help="also train on private machines not held out")
    ap.add_argument("--models", default="tfidf")
    ap.add_argument("--encoder", default="huggingface/CodeBERTa-small-v1")
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--max-len", type=int, default=160)
    ap.add_argument("--hf-sample", type=int, default=12000)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--no-verdicts", action="store_true", help="tree model sees command shape only, not the gate's verdicts")
    ap.add_argument("--save", action="store_true", help="write the trained gbdt model to --out")
    ap.add_argument("--device", default="cpu", help="cpu, or mps for the Apple GPU (host runs only)")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)
    global USE_VERDICTS
    USE_VERDICTS = not args.no_verdicts
    args.out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)

    public = load_public_testset(args.repo)
    risk = load_shell_safety(args.hf / "shellsafety") + load_cli_risk(args.hf / "clirisk") + load_agent_approve(args.hf / "agentapprove")
    risk_train = [r for r in risk if r["split"] == "train"]
    # Balance the risk corpus and cap its size so it cannot drown the tiered rows.
    pos = [r for r in risk_train if r["risky"]]
    neg = [r for r in risk_train if not r["risky"]]
    rng.shuffle(pos)
    rng.shuffle(neg)
    half = args.hf_sample // 2
    risk_train = pos[:half] + neg[:half]
    risk_eval = [r for r in risk if r["split"] == "holdout"]

    private = load_private(args.private) if args.private and args.private.exists() else []
    raw = {}
    if private:
        for line in args.private.open():
            row = json.loads(line)
            raw[row["id"]] = row["command"]
    for r in private:
        r["raw"] = raw.get(r["id"])
    held_machines = set(filter(None, args.heldout_machines.split(",")))
    tiered_train = [r for r in public if r["split"] == "train"]
    if args.train_private:
        tiered_train += [r for r in private if r["machine"] not in held_machines]

    eval_sets = {"public-holdout": [r for r in public if r["split"] == "holdout"]}
    for machine in sorted({r["machine"] for r in private}):
        rows = [r for r in private if r["machine"] == machine]
        tag = "held-out" if machine in held_machines or not args.train_private else "seen"
        eval_sets[f"real:{machine} ({tag})"] = rows
    eval_sets["agent-approve-holdout (ask only)"] = risk_eval

    print(f"train: {len(tiered_train)} tiered + {len(risk_train)} risk rows", flush=True)
    report = {"train": {"tiered": len(tiered_train), "risk": len(risk_train), "train_private": args.train_private}, "sets": {}}
    models = []
    for name in args.models.split(","):
        started = time.monotonic()
        if name == "tfidf":
            models.append(TfidfModel().fit(tiered_train, risk_train))
        elif name == "encoder-mlx":
            from mlx_encoder import MlxEncoderModel

            models.append(MlxEncoderModel(args.encoder, args.epochs, args.max_len, args.seed).fit(tiered_train, risk_train))
        elif name == "gbdt":
            models.append(TreeModel().fit(tiered_train, risk_train))
        elif name == "encoder":
            models.append(EncoderModel(args.encoder, args.epochs, args.max_len, args.seed, args.device).fit(tiered_train, risk_train))
        print(f"trained {name} in {time.monotonic() - started:.0f}s", flush=True)
        if args.save and name == "gbdt":
            import joblib

            # Trained on private labels when --train-private is set: the file stays private.
            joblib.dump(models[-1], args.out / "gbdt.joblib")
            os.chmod(args.out / "gbdt.joblib", 0o600)

    for set_name, rows in eval_sets.items():
        entry = {"rows": len(rows), "policies": {}, "models": {}}
        if set_name.startswith("agent-approve"):
            for model in models:
                if hasattr(model, "predict_rows"):
                    continue  # no product verdicts on these rows
                preds = model.predict([r["text"] for r in rows])
                from sklearn.metrics import roc_auc_score

                y = [bool(r["risky"]) for r in rows]
                entry["models"][model.name] = {"ask_auc": round(roc_auc_score(y, [p["p_ask"] for p in preds]), 3)}
            report["sets"][set_name] = entry
            continue
        none = [None] * len(rows)
        for mode in MODES:
            entry["policies"][f"harm gate (main) | {mode}"] = score(rows, none, mode, 1.0, False, "harm_main")
            entry["policies"][f"harm gate | {mode}"] = score(rows, none, mode, 1.0, False)
            entry["policies"][f"harm gate + rules | {mode}"] = score(rows, none, mode, 1.0, True)
        for model in models:
            preds = model.predict_rows(rows) if hasattr(model, "predict_rows") else model.predict([r["text"] for r in rows])
            entry["models"][model.name] = tier_metrics(rows, preds)
            for mode in MODES:
                for threshold in THRESHOLDS:
                    entry["policies"][f"{model.name} t<{threshold} + harm + rules | {mode}"] = score(rows, preds, mode, threshold, True)
                    entry["policies"][f"{model.name} t<{threshold} + harm | {mode}"] = score(rows, preds, mode, threshold, False)
                    entry["policies"][f"{model.name} t<{threshold} + harm (main) | {mode}"] = score(rows, preds, mode, threshold, False, "harm_main")
            if set_name.startswith("real"):
                with (args.out / f"preds-{model.name}-{set_name.split()[0].replace(':', '_')}.jsonl").open("w") as handle:
                    for r, p in zip(rows, preds):
                        handle.write(json.dumps({"id": r["id"], "tier": r["tier"], "pred": p["tier"], "p_ask": round(p["p_ask"], 4), "harm": r.get("harm")}) + "\n")
        report["sets"][set_name] = entry
    (args.out / "report.json").write_text(json.dumps(report, indent=2))
    for set_name, entry in report["sets"].items():
        print(f"\n== {set_name}: {entry['rows']} rows  {entry['models']}")
        for policy, s in entry["policies"].items():
            if "outside-read" in policy or "harm gate" in policy:
                print(f"  {policy:58} removes {s['removed']:4}/{s['prompts']} ({s['removed_pct']:5}%)  ask approved {s['ask_approved']:2}  over-tier {s['over_tier']}")


if __name__ == "__main__":
    main()
