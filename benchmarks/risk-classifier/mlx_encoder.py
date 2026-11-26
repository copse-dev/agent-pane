"""The fine-tuned encoder, in MLX, so it trains on the Apple GPU inside the host sandbox.

PyTorch's MPS backend compiles some kernels at runtime through Apple's MTLCompilerService, which
refuses to write its cache for a client under `sandbox-exec`; MLX ships its kernels precompiled and
trains there. Same model (a RoBERTa encoder loaded from the Hugging Face checkpoint), same two heads
and losses as `EncoderModel` in train.py, so the two are comparable.
"""
from __future__ import annotations

import glob
import json
import os
import random
from collections import Counter

from data import TIERS


def _checkpoint_files(checkpoint: str) -> tuple[dict, str]:
    """Config and safetensors for a cached checkpoint, read offline from HF_HOME."""
    root = os.path.join(os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface")), "hub")
    repo = os.path.join(root, "models--" + checkpoint.replace("/", "--"), "snapshots")
    configs = glob.glob(os.path.join(repo, "*", "config.json"))
    weights = glob.glob(os.path.join(repo, "*", "model.safetensors"))
    if not configs or not weights:
        raise FileNotFoundError(f"{checkpoint} is not in {root}; fetch it in the container step first")
    with open(configs[0], encoding="utf-8") as handle:
        return json.load(handle), weights[0]


def _build(config: dict):
    import mlx.core as mx
    import mlx.nn as nn

    hidden, heads = config["hidden_size"], config["num_attention_heads"]
    eps = config.get("layer_norm_eps", 1e-5)
    pad = config.get("pad_token_id", 1)

    class Layer(nn.Module):
        def __init__(self):
            super().__init__()
            self.query = nn.Linear(hidden, hidden)
            self.key = nn.Linear(hidden, hidden)
            self.value = nn.Linear(hidden, hidden)
            self.attn_out = nn.Linear(hidden, hidden)
            self.attn_norm = nn.LayerNorm(hidden, eps=eps)
            self.intermediate = nn.Linear(hidden, config["intermediate_size"])
            self.output = nn.Linear(config["intermediate_size"], hidden)
            self.out_norm = nn.LayerNorm(hidden, eps=eps)
            self.drop = nn.Dropout(config.get("hidden_dropout_prob", 0.1))

        def __call__(self, x, mask):
            b, t, _ = x.shape
            split = lambda y: y.reshape(b, t, heads, hidden // heads).transpose(0, 2, 1, 3)
            q, k, v = split(self.query(x)), split(self.key(x)), split(self.value(x))
            a = mx.fast.scaled_dot_product_attention(q, k, v, scale=(hidden // heads) ** -0.5, mask=mask)
            a = a.transpose(0, 2, 1, 3).reshape(b, t, hidden)
            x = self.attn_norm(x + self.drop(self.attn_out(a)))
            return self.out_norm(x + self.drop(self.output(nn.gelu(self.intermediate(x)))))

    class Net(nn.Module):
        def __init__(self):
            super().__init__()
            self.word = nn.Embedding(config["vocab_size"], hidden)
            self.position = nn.Embedding(config["max_position_embeddings"], hidden)
            self.token_type = nn.Embedding(config.get("type_vocab_size", 1), hidden)
            self.embed_norm = nn.LayerNorm(hidden, eps=eps)
            self.layers = [Layer() for _ in range(config["num_hidden_layers"])]
            self.drop = nn.Dropout(0.1)
            self.tier = nn.Linear(hidden, len(TIERS))
            self.ask = nn.Linear(hidden, 1)

        def __call__(self, ids, attention):
            # RoBERTa positions count real tokens from padding_idx + 1.
            positions = (mx.cumsum(attention, axis=1) * attention + pad).astype(mx.int32)
            x = self.word(ids) + self.position(positions) + self.token_type(mx.zeros_like(ids))
            x = self.embed_norm(x)
            mask = ((1 - attention) * -1e9)[:, None, None, :].astype(x.dtype)
            for layer in self.layers:
                x = layer(x, mask)
            h = self.drop(x[:, 0])
            return self.tier(h), self.ask(h).squeeze(-1)

    return Net()


def _load_weights(net, path: str, layers: int) -> None:
    import mlx.core as mx

    raw = mx.load(path)
    names = {
        "word.weight": "roberta.embeddings.word_embeddings.weight",
        "position.weight": "roberta.embeddings.position_embeddings.weight",
        "token_type.weight": "roberta.embeddings.token_type_embeddings.weight",
        "embed_norm.weight": "roberta.embeddings.LayerNorm.weight",
        "embed_norm.bias": "roberta.embeddings.LayerNorm.bias",
    }
    parts = {
        "query": "attention.self.query",
        "key": "attention.self.key",
        "value": "attention.self.value",
        "attn_out": "attention.output.dense",
        "attn_norm": "attention.output.LayerNorm",
        "intermediate": "intermediate.dense",
        "output": "output.dense",
        "out_norm": "output.LayerNorm",
    }
    for i in range(layers):
        for ours, theirs in parts.items():
            for p in ("weight", "bias"):
                names[f"layers.{i}.{ours}.{p}"] = f"roberta.encoder.layer.{i}.{theirs}.{p}"
    net.load_weights([(ours, raw[theirs]) for ours, theirs in names.items()], strict=False)


class MlxEncoderModel:
    name = "encoder-mlx"

    def __init__(self, checkpoint: str, epochs: int, max_len: int, seed: int):
        self.checkpoint, self.epochs, self.max_len, self.seed = checkpoint, epochs, max_len, seed

    def _batch(self, texts):
        import mlx.core as mx

        enc = self.tok(texts, truncation=True, max_length=self.max_len, padding=True, return_tensors="np")
        return mx.array(enc["input_ids"]), mx.array(enc["attention_mask"])

    def fit(self, tiered: list[dict], risk: list[dict]) -> "MlxEncoderModel":
        import mlx.core as mx
        import mlx.nn as nn
        import mlx.optimizers as optim
        from transformers import AutoTokenizer

        mx.random.seed(self.seed)
        self.tok = AutoTokenizer.from_pretrained(self.checkpoint)
        config, weights = _checkpoint_files(self.checkpoint)
        self.net = _build(config)
        _load_weights(self.net, weights, config["num_hidden_layers"])
        rows = tiered * 3 + risk
        counts = Counter(r["tier"] for r in tiered)
        tier_weight = mx.array([len(tiered) / (len(TIERS) * max(1, counts[t])) for t in TIERS])
        pos = sum(1 for r in rows if r["risky"])
        pos_weight = (len(rows) - pos) / max(1, pos)
        batch = 32
        steps = self.epochs * ((len(rows) + batch - 1) // batch)
        schedule = optim.join_schedules(
            [optim.linear_schedule(1e-7, 3e-5, max(1, steps // 10)), optim.cosine_decay(3e-5, steps)],
            [max(1, steps // 10)],
        )
        opt = optim.AdamW(learning_rate=schedule, weight_decay=0.01)

        def loss_fn(net, ids, attention, tier_y, has_tier, ask_y):
            tier_logits, ask_logits = net(ids, attention)
            ask_loss = -(pos_weight * ask_y * nn.log_sigmoid(ask_logits) + (1 - ask_y) * nn.log_sigmoid(-ask_logits)).mean()
            ce = nn.losses.cross_entropy(tier_logits, tier_y, reduction="none") * tier_weight[tier_y]
            tier_loss = (ce * has_tier).sum() / mx.maximum(has_tier.sum(), 1)
            return ask_loss + tier_loss

        step_fn = nn.value_and_grad(self.net, loss_fn)
        self.net.train()
        step = 0
        for epoch in range(self.epochs):
            random.Random(self.seed + epoch).shuffle(rows)
            for i in range(0, len(rows), batch):
                chunk = rows[i : i + batch]
                ids, attention = self._batch([r["text"] for r in chunk])
                has_tier = mx.array([1.0 if r.get("tier") else 0.0 for r in chunk])
                tier_y = mx.array([TIERS.index(r["tier"]) if r.get("tier") else 0 for r in chunk])
                ask_y = mx.array([1.0 if r["risky"] else 0.0 for r in chunk])
                loss, grads = step_fn(self.net, ids, attention, tier_y, has_tier, ask_y)
                grads, _ = optim.clip_grad_norm(grads, 1.0)
                opt.update(self.net, grads)
                mx.eval(self.net.parameters(), opt.state, loss)
                step += 1
                if step % 200 == 0:
                    print(f"  encoder-mlx epoch {epoch} step {step}/{steps} loss {loss.item():.3f}", flush=True)
        self.net.eval()
        return self

    def predict(self, texts: list[str]) -> list[dict]:
        import mlx.core as mx

        out = []
        for i in range(0, len(texts), 64):
            ids, attention = self._batch(texts[i : i + 64])
            tier_logits, ask_logits = self.net(ids, attention)
            tier_p = mx.softmax(tier_logits, axis=-1).tolist()
            ask_p = mx.sigmoid(ask_logits).tolist()
            for row, p_ask in zip(tier_p, ask_p):
                probs = dict(zip(TIERS, row))
                out.append({"tier": max(probs, key=probs.get), "probs": probs, "p_ask": float(max(p_ask, probs["ask"]))})
        return out
