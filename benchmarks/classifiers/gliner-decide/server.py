"""Serve GLiNER2.5-Decide over Copse's `systemone` classifier protocol.

POST {base}/systemone  {"model", "state", "questions": {id: {type, instructions, criteria}}}
  -> {"model", "answers": {id: {...}}, "latency_ms"}

Each Copse question becomes one GLiNER classification head, all scored in one
forward pass: the question's options (with their descriptions) become labels,
its instructions become the head's prompt, and `state` is rendered as the text.
Heads are requested as softmax over every label (`multi_label` with a zero
threshold keeps all of them), so each answer carries the full distribution the
Copse adapter validates, not just the winning label.

    python server.py --port 8010 [--device auto|cpu|mps|cuda] [--model fastino/GLiNER2.5-Decide]

Binds 127.0.0.1 only. The model is not thread-safe, so requests are serialised.
"""

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from gliner2 import AutoExtractor

MAX_BODY_BYTES = 1024 * 1024


def render_state(state):
    """Readable key: value lines; nested values as compact JSON."""
    if isinstance(state, str):
        return state
    if not isinstance(state, dict):
        return json.dumps(state, ensure_ascii=False)
    lines = []
    for key, value in state.items():
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        lines.append(f"{key}: {text}")
    return "\n".join(lines)


def head_for(question):
    """GLiNER head config and a decoder back to Copse's answer shape."""
    kind = question.get("type")
    instructions = question.get("instructions") or ""
    criteria = question.get("criteria")
    head = {"multi_label": True, "cls_threshold": 0.0, "class_act": "softmax"}
    if instructions:
        head["prompt"] = instructions
    if kind == "choice":
        if not isinstance(criteria, dict) or len(criteria) < 2:
            raise ValueError("choice question needs at least two options")
        head["labels"] = {str(k): str(v) for k, v in criteria.items()}

        def decode(probs):
            choice = max(probs, key=probs.get)
            return {"type": "choice", "choice": choice, "probabilities": probs}

        return head, decode
    if kind == "score":
        if not isinstance(criteria, list) or len(criteria) < 2:
            raise ValueError("score question needs at least two levels")
        head["labels"] = {str(i): str(level) for i, level in enumerate(criteria)}

        def decode(probs):
            best = max(probs, key=probs.get)
            legend = {str(i): str(level) for i, level in enumerate(criteria)}
            return {"type": "score", "score": int(best), "probabilities": probs, "legend": legend}

        return head, decode
    if kind == "noul":
        head["labels"] = {
            "yes": criteria if isinstance(criteria, str) and criteria else "The statement holds.",
            "no": "The statement does not hold.",
        }

        def decode(probs):
            return {"type": "noul", "noul": probs["yes"]}

        return head, decode
    raise ValueError(f"unsupported question type: {kind!r}")


class Classifier:
    def __init__(self, model_id, device):
        self.model_id = model_id
        self.model = AutoExtractor.from_pretrained(model_id)
        if device != "cpu":
            self.model = self.model.to(device)
        self.model.eval()
        self.lock = threading.Lock()

    def answer(self, body):
        questions = body.get("questions")
        if not isinstance(questions, dict) or not questions:
            raise ValueError("questions must be a non-empty object")
        heads, decoders = {}, {}
        for qid, question in questions.items():
            heads[qid], decoders[qid] = head_for(question)
        started = time.perf_counter()
        with self.lock:
            raw = self.model.classify_text(
                render_state(body.get("state")), heads, include_confidence=True
            )
        answers = {}
        for qid, decode in decoders.items():
            scored = {item["label"]: float(item["confidence"]) for item in raw[qid]}
            probs = {label: scored.get(label, 0.0) for label in heads[qid]["labels"]}
            total = sum(probs.values()) or 1.0
            answers[qid] = decode({k: v / total for k, v in probs.items()})
        return {
            "model": self.model_id,
            "answers": answers,
            "latency_ms": round((time.perf_counter() - started) * 1000, 1),
        }


def handler_for(classifier):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, status, payload):
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if self.path.rstrip("/").split("/")[-1] != "systemone":
                return self.reply(404, {"error": "not found"})
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY_BYTES:
                return self.reply(413, {"error": "body too large or empty"})
            try:
                body = json.loads(self.rfile.read(length))
                return self.reply(200, classifier.answer(body))
            except (ValueError, KeyError, TypeError) as error:
                return self.reply(400, {"error": str(error)})

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8010)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--model", default="fastino/GLiNER2.5-Decide")
    args = parser.parse_args()
    device = args.device
    if device == "auto":
        import torch

        device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
    classifier = Classifier(args.model, device)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler_for(classifier))
    print(f"{args.model} on http://127.0.0.1:{args.port}/v1/systemone ({device})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
