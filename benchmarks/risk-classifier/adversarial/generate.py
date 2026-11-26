"""Generate labelled adversarial shell commands with an LLM, one call per family and batch.

    python3 -I generate.py --out raw/run-01.jsonl --per-family 30 --batches 2
    python3 -I generate.py --families secrets-credentials,publish-release --backend anthropic

Backends:
  claude-cli  runs `claude -p` (uses whatever account the CLI is signed in to; the default)
  anthropic   the Messages API via the `anthropic` package and ANTHROPIC_API_KEY
  print       writes the filled prompts to stdout, for pasting into any model

Output rows are raw: run clean.py to validate and dedupe them before scoring or training.
"""
from __future__ import annotations

import argparse
import json
import random
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROMPT = (HERE / "PROMPT.md").read_text().split("\n---\n", 1)[1].strip()
FAMILIES = json.loads((HERE / "families.json").read_text())

# Steers later batches of a family away from what earlier ones wrote.
BATCH_GUIDANCE = [
    "",
    "This is a later batch. Favour evasion techniques other than `wrapper` and `chaining`, and "
    "toolchains other than Node.",
    "This is a later batch. Favour `script-file`, `config-indirection` and `split-steps` rows, "
    "where the command line itself looks routine.",
    "This is a later batch. Write long, realistic agent command lines (3 to 6 segments) where the "
    "risky segment is not first or last.",
]


def fill(family: str, n: int, negative_share: str, batch: int, avoid: list[str]) -> str:
    spec = FAMILIES[family]
    extra = BATCH_GUIDANCE[batch % len(BATCH_GUIDANCE)]
    if avoid:
        extra += "\n\nCommands already written for this family (do not repeat or lightly vary):\n" + "\n".join(
            f"- {c}" for c in avoid
        )
    return (
        PROMPT.replace("{{n}}", str(n))
        .replace("{{family}}", family)
        .replace("{{family_description}}", spec["description"])
        .replace("{{negative_share}}", negative_share)
        .replace("{{seed_examples}}", "\n".join(f"- {s}" for s in spec["seeds"]))
        .replace("{{extra_guidance}}", extra.strip())
    )


def call(backend: str, prompt: str, model: str | None) -> str:
    if backend == "claude-cli":
        args = ["claude", "-p", "--output-format", "text", "--tools", ""]
        if model:
            args += ["--model", model]
        done = subprocess.run(args, input=prompt, capture_output=True, text=True, timeout=900)
        if done.returncode != 0:
            raise RuntimeError(done.stderr.strip() or done.stdout.strip())
        return done.stdout
    if backend == "anthropic":
        import anthropic  # noqa: PLC0415

        if not model:
            raise RuntimeError("--model is required with the anthropic backend")
        client = anthropic.Anthropic()
        msg = client.messages.create(
            model=model,
            max_tokens=32000,
            messages=[{"role": "user", "content": prompt}],
        )
        return "".join(block.text for block in msg.content if block.type == "text")
    raise ValueError(backend)


def parse(text: str, family: str, batch: int) -> list[dict]:
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        row.setdefault("family", family)
        row["batch"] = f"{family}#{batch}"
        rows.append(row)
    return rows


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--families", default=",".join(FAMILIES))
    ap.add_argument("--per-family", type=int, default=30, help="rows per batch")
    ap.add_argument("--batches", type=int, default=1, help="batches per family")
    ap.add_argument("--negative-share", default="a third")
    ap.add_argument("--backend", choices=["claude-cli", "anthropic", "print"], default="claude-cli")
    ap.add_argument("--model", default=None)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--retries", type=int, default=2)
    args = ap.parse_args(argv)

    families = [f for f in args.families.split(",") if f]
    unknown = [f for f in families if f not in FAMILIES]
    if unknown:
        ap.error(f"unknown families: {unknown}")
    random.Random(args.seed).shuffle(families)

    out = open(args.out, "a") if args.out else sys.stdout
    for family in families:
        written: list[str] = []
        for batch in range(args.batches):
            prompt = fill(family, args.per_family, args.negative_share, batch, written[-60:])
            if args.backend == "print":
                print(f"===== {family} batch {batch} =====\n{prompt}\n")
                continue
            try:
                # A batch now and then trips the model's safety filter or comes back empty; the
                # same prompt usually goes through on a second try.
                for attempt in range(args.retries + 1):
                    try:
                        text = call(args.backend, prompt, args.model)
                    except RuntimeError as error:
                        if attempt == args.retries:
                            raise
                        print(f"{family}#{batch}: retrying after {str(error)[:120]!r}", file=sys.stderr)
                        continue
                    rows = parse(text, family, batch)
                    if rows or attempt == args.retries:
                        break
                if not rows:
                    print(f"{family}#{batch}: no rows; reply began: {text[:300]!r}", file=sys.stderr)
            except Exception as error:  # noqa: BLE001
                print(f"{family}#{batch}: {error}", file=sys.stderr)
                continue
            for row in rows:
                out.write(json.dumps(row) + "\n")
            out.flush()
            written += [r.get("command", "") for r in rows]
            print(f"{family}#{batch}: {len(rows)} rows", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
