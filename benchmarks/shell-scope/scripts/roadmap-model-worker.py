"""JSONL adapters for public decision models. Historical kind semif is OpenJev NLI, NOT actual SemIf. See ../README.md."""
import argparse
import contextlib
import importlib.metadata
import json
import os
import re
from pathlib import Path
import sys
import time

os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


class ContextOverflow(ValueError):
    pass


def safe_error(error):
    message = re.sub(r"https?://\S+", "[URL omitted]", str(error))
    message = re.sub(r"(?:Bearer\s+|hf_|sk-)[A-Za-z0-9_.-]+", "[credential omitted]", message)
    return type(error).__name__ + ": " + message[:600]


def check_laya_input(agent, state, question):
    """Mirror the pinned SDK's budgets, rejecting every truncating path."""
    from laya.common import render_options, serialize_state
    tok = agent.tok
    mask = tok.mask_token
    internal = {"t": question["type"], "ins": question["instructions"], "crit": question["criteria"]}
    encode = lambda text: tok(text.replace(mask, " "), add_special_tokens=False)["input_ids"]
    head = encode("choice question: " + question["instructions"])
    options = [encode(" " + option) for option in render_options(internal)]
    if any(len(option) > 48 for option in options):
        raise ContextOverflow("Option exceeds Laya's 48-token limit")
    head_size = len(head) + sum(1 + len(option) for option in options)
    # SDK reserves at least 16 instruction tokens before shrinking option text.
    option_budget = agent.cfg.get("head_max_len", 192) - sum(1 + len(option) for option in options)
    if option_budget < 16 or len(head) > max(8, option_budget):
        raise ContextOverflow("Instructions or criteria exceed Laya head budget")
    total = 4 + head_size + len(encode(serialize_state(state)))
    if total > agent.cfg.get("max_len", 512):
        raise ContextOverflow("Evidence exceeds Laya context budget")
    return total


def snapshot(args, patterns, subfolder=""):
    from huggingface_hub import model_info, snapshot_download
    revision = args.revision if re.fullmatch(r'[a-f0-9]{40}', args.revision) else model_info(args.model, revision=args.revision, token=False).sha
    prefix = subfolder + "/" if subfolder else ""
    directory = snapshot_download(
        args.model, revision=revision, token=False, cache_dir=args.cache_dir,
        allow_patterns=[prefix + pattern for pattern in patterns],
        ignore_patterns=["multilingual/*", "typed-decisions/*"] if args.kind == "laya" and not subfolder else None,
    )
    return Path(directory) / subfolder, revision


def sync_device(torch, device):
    if device == "cuda":
        torch.cuda.synchronize()
    elif device == "mps":
        torch.mps.synchronize()


def load_backend(args):
    import torch
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("cuda-unavailable")
    if args.device == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("mps-unavailable")
    details = {
        "python": sys.version.split()[0], "torch": torch.__version__,
        "transformers": importlib.metadata.version("transformers"), "device": args.device,
        "offline": os.environ.get("HF_HUB_OFFLINE") == "1",
    }
    if args.kind == "nimble-demo":
        from gradio_client import Client
        client = Client("hugging-apps/bespoke-nimble-9b-demo", verbose=False)
        revision = "hosted-unverified"
        details.update(device="remote-cuda", space="hugging-apps/bespoke-nimble-9b-demo",
                       gradioClient=importlib.metadata.version("gradio_client"),
                       modelEvidence="Published demo model ID; served checkpoint not independently verified")
        def predict(payload):
            q = payload["questions"]["resolution"]
            schema = {"resolution": {
                "type": "enum", "description": q["instructions"],
                "choices": list(q["criteria"]), "choice_descriptions": q["criteria"],
            }}
            output = client.predict(json.dumps(payload["state"], ensure_ascii=False),
                                    json.dumps(schema, ensure_ascii=False), [], api_name="/decide")
            answer = json.loads(output[2])["resolution"]
            return answer["prediction"], answer["probabilities"], None, {"reportedGpuTime": output[3]}
    elif args.kind == "laya":
        import laya
        if importlib.metadata.version("laya") != "0.3.3":
            raise RuntimeError("laya-version-must-be-0.3.3")
        directory, revision = snapshot(args, [
            "model.safetensors", "rl_agent_config.json", "tokenizer/*", "encoder/*",
        ], args.subfolder or "")
        agent = laya.load(str(directory), device=args.device)
        details.update(laya="0.3.3", device=str(agent.device),
                       maxTokens=agent.cfg.get("max_len", 512), subfolder=args.subfolder or "")
        def predict(payload):
            count = check_laya_input(agent, payload["state"], payload["questions"]["resolution"])
            result = agent.predict(payload["state"], payload["questions"])
            answer = result["answers"]["resolution"]
            return answer["choice"], answer["probabilities"], result.get("usage"), {"inputTokens": count, "device": str(agent.device)}
    elif args.kind == "semif":
        from transformers import AutoTokenizer, AutoModelForSequenceClassification
        subfolder = args.subfolder or "qwen3.5-4b-nli-v2"
        directory, revision = snapshot(args, ["*.json", "*.safetensors", "*.model", "tokenizer*"], subfolder)
        tok = AutoTokenizer.from_pretrained(directory, trust_remote_code=False)
        model = AutoModelForSequenceClassification.from_pretrained(
            directory, trust_remote_code=False, dtype=torch.float32 if args.device != "cuda" else torch.bfloat16,
        ).to(args.device).eval()
        template = getattr(model.config, "nli_template", None) or "Premise: {premise}\nHypothesis: {hypothesis}"
        if tok.pad_token is None:
            tok.pad_token = tok.eos_token
        tok.padding_side = "right"
        text_config = model.config.get_text_config()
        if text_config.pad_token_id is None:
            text_config.pad_token_id = tok.pad_token_id
        details.update(subfolder=subfolder, decisionRule="argmax entailment; not a categorical probability distribution")
        def predict(payload):
            q = payload["questions"]["resolution"]
            premise = json.dumps(payload, ensure_ascii=False)
            names = list(q["criteria"])
            texts = [template.format(premise=premise, hypothesis="The correct answer is: " + name + ". " + q["criteria"][name]) for name in names]
            lengths = [len(tok(text, truncation=False)["input_ids"]) for text in texts]
            if max(lengths) > 4096:
                raise ContextOverflow("SemIf input exceeds 4096 tokens")
            encoded = tok(texts, truncation=False, padding=True, return_tensors="pt").to(args.device)
            with torch.inference_mode():
                scores = model(**encoded).logits.float().softmax(-1)[:, 1].cpu().tolist()
            index = max(range(len(scores)), key=scores.__getitem__)
            return names[index], None, {"input_tokens": sum(lengths)}, {
                **{"entailment_" + name: score for name, score in zip(names, scores)},
                "decisionRule": "argmax entailment; scores are not normalized across verdicts",
            }
    elif args.kind == "nimble":
        if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
            raise RuntimeError("nimble-requires-cuda-bf16")
        directory, revision = snapshot(args, [
            "*.json", "*.safetensors", "tokenizer*", "*.model", "inference.py", "parallel_schema.py", "*.jinja",
        ])
        sys.path.insert(0, str(directory))
        from inference import NimbleModel
        agent = NimbleModel(str(directory))
        details.update(device="cuda", decisionRule="official allowed-answer token scoring")
        def predict(payload):
            q = payload["questions"]["resolution"]
            result = agent.score(
                context=json.dumps(payload["state"], ensure_ascii=False),
                schema={"resolution": {
                    "type": "enum", "description": q["instructions"],
                    "choices": list(q["criteria"]), "choice_descriptions": q["criteria"],
                }},
            )
            answer = result["fields"]["resolution"]
            return answer["prediction"], answer["probabilities"], None, {}
    elif args.kind == "kev":
        if args.source_dir:
            sys.path.insert(0, args.source_dir)
        from kev.evaluate import load
        from kev.api import SystemOneRequest, to_record, to_answers
        directory, revision = snapshot(args, [
            "head.pt", "adapter_config.json", "adapter_model.safetensors", "*.json", "tokenizer*",
            "merges.txt", "vocab.json",
        ])
        os.environ["KEV_LORA_SCALE"] = "1"
        tok, model = load(str(directory), args.device, dtype=torch.float32)
        details.update(decisionRule="official Kev typed-question encoding; checkpoint revision pinned", dtype="float32", loraScale=1)
        def predict(payload):
            request = SystemOneRequest(model=args.model, **payload)
            record, meta = to_record(request)
            try:
                encoded = model.encode(tok, record, max_state=8192, max_branch=8192, strict=True)
            except ValueError as error:
                raise ContextOverflow("Kev input exceeds the token budget") from error
            with torch.inference_mode():
                probabilities = [p.tolist() for p in model.probs(encoded)]
            answer = to_answers(probabilities, meta)["resolution"]
            raw_probabilities = dict(zip(payload["questions"]["resolution"]["criteria"], probabilities[0]))
            return answer["choice"], raw_probabilities, {"input_tokens": len(encoded["ids"])}, {"probabilityPrecision": "raw float32 before official wire rounding"}
    else:
        raise RuntimeError("unsupported-local-model")
    selected_subfolder = details.get("subfolder", "")
    identity = args.model + "@" + revision + ("/" + selected_subfolder if selected_subfolder else "")
    details["revision"] = revision
    return identity, details, predict


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", choices=["laya", "semif", "nimble", "nimble-demo", "kev"], required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--revision", default="main")
    parser.add_argument("--subfolder")
    parser.add_argument("--device", choices=["cpu", "mps", "cuda"], default="cpu")
    parser.add_argument("--source-dir")
    parser.add_argument("--cache-dir", required=True)
    args = parser.parse_args()
    os.environ["HF_HOME"] = str(Path(args.cache_dir).resolve())
    started = time.perf_counter()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            model, details, predict = load_backend(args)
    except Exception as error:
        # Bound and redact local diagnostics before returning them to the report.
        safe_codes = {"cuda-unavailable", "mps-unavailable", "nimble-requires-cuda-bf16", "laya-version-must-be-0.3.3"}
        code = str(error) if str(error) in safe_codes else type(error).__name__
        print(json.dumps({"ready": False, "error": code, "detail": safe_error(error)}), flush=True)
        return 1
    print(json.dumps({"ready": True, "model": model, "setupMs": (time.perf_counter() - started) * 1000, "details": details}), flush=True)
    for line in sys.stdin:
        try:
            payload = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                import torch
                sync_device(torch, details["device"])
                call_started = time.perf_counter()
                verdict, probabilities, usage, info = predict(payload)
                sync_device(torch, details["device"])
                info["inferenceMs"] = (time.perf_counter() - call_started) * 1000
            result = {"verdict": verdict, "probabilities": probabilities, "model": model,
                      "usage": usage, "error": None, "fatal": False, "details": info}
        except ContextOverflow:
            result = {"verdict": None, "probabilities": None, "model": model, "usage": None,
                      "error": "Input exceeds model context; no truncation allowed", "fatal": False}
        except Exception as error:
            result = {"verdict": None, "probabilities": None, "model": model, "usage": None,
                      "error": "Local inference failed: " + safe_error(error), "fatal": True}
        print(json.dumps(result, allow_nan=False), flush=True)
        if result["fatal"]:
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
