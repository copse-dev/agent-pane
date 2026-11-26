"""Load every labelled source into one record shape.

A record is a dict with:
  id, source, text (the normalised tool call), tier (rubric tier or None),
  risky (bool or None: a source's own "should a person see this" label),
  split ("train" | "dev" | "holdout"), group (keeps near-duplicates together),
  harm / scope / auto (the product's deterministic verdicts, when known).

Private rows (a developer's real history) are read from a directory the caller mounts; they are
never written anywhere but the caller's own output directory.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

TIERS = ["read", "local-write", "remote-write", "outside-read", "outside-write", "ask"]

_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"


def normalise(command: str, workspace: str | None = None, home: str | None = None) -> str:
    """Make a command comparable across machines: the workspace, Copse worktrees and the home
    directory become placeholders, so a model never learns one developer's paths."""
    text = command
    if workspace:
        text = text.replace(workspace, "$WS")
    text = re.sub(rf"(/Users/[^/\s\"']+|~)/\.copse/worktrees/{_UUID}/{_UUID}", "$WT", text)
    if home:
        text = text.replace(home, "~")
    text = re.sub(r"/Users/[^/\s\"']+", "~", text)
    text = re.sub(r"/home/[^/\s\"']+", "~", text)
    return text


def _jsonl(path: Path):
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)


def load_public_testset(repo: Path) -> list[dict]:
    """The committed, anonymised escalation-review test set (rubric tiers, dev/holdout split)."""
    base = repo / "benchmarks" / "escalation-review" / "testset"
    verdicts = {row["id"]: row for row in _jsonl(base / "deterministic.jsonl")}
    out = []
    for case in _jsonl(base / "cases.jsonl"):
        verdict = verdicts.get(case["id"], {})
        auto = verdict.get("autoApproval") or {}
        out.append(
            {
                "id": case["id"],
                "source": f"testset:{case['source']}",
                "text": normalise(case["command"], case.get("workspace"), "/Users/dev"),
                "tier": case["tier"],
                "risky": case["tier"] == "ask",
                "split": "holdout" if case["split"] == "holdout" else "train",
                "group": f"testset:{case['id'].split('-')[0]}",
                "harm": verdict.get("harm"),
                "scope": verdict.get("scope"),
                "auto": max((t for t, v in auto.items() if v), key=TIERS.index, default=None),
            }
        )
    return out


def load_shell_safety(root: Path) -> list[dict]:
    """tomngdev/shell-safety-v1.1 (MIT): allow / ask / deny under its own policy."""
    out = []
    for split in ("train", "validation", "test"):
        path = root / f"{split}.jsonl"
        if not path.exists():
            continue
        for i, row in enumerate(_jsonl(path)):
            command = row.get("command") or row.get("cmd")
            if not isinstance(command, str):
                continue
            label = row.get("label")
            out.append(
                {
                    "id": f"ss-{split}-{i}",
                    "source": "hf:shell-safety",
                    "text": normalise(command),
                    "tier": None,
                    "risky": label in ("ask", "deny"),
                    "split": "train" if split != "test" else "dev",
                    "group": f"ss-{i % 997}",
                }
            )
    return out


def load_cli_risk(root: Path) -> list[dict]:
    """yannelli/cli-command-risk (CC BY 4.0): safe … critical. High and critical read as risky."""
    import pandas as pd

    out = []
    for split in ("train", "validation", "test"):
        path = root / "data" / f"{split}.parquet"
        if not path.exists():
            continue
        frame = pd.read_parquet(path, columns=["id", "command", "risk_level"])
        frame = frame.drop_duplicates("command")
        for row in frame.itertuples():
            out.append(
                {
                    "id": f"cr-{row.id}",
                    "source": "hf:cli-command-risk",
                    "text": normalise(row.command),
                    "tier": None,
                    "risky": row.risk_level in ("high", "critical"),
                    "split": "train" if split != "test" else "dev",
                    "group": f"cr-{hash(row.command) % 997}",
                }
            )
    return out


def load_agent_approve(root: Path) -> list[dict]:
    """agentapprove/coding-agent-tool-call-safety (CC BY 4.0): any positive tool-only rule is
    risky. These include non-shell tools (Write, Edit, MCP), rendered as `tool <json>`."""
    out = []
    for path in sorted((root / "data").glob("*/*.jsonl")):
        for row in _jsonl(path):
            truth = row.get("truth_tool_only") or {}
            if isinstance(truth, str):
                truth = json.loads(truth)
            positive = any(v == "true" for v in truth.values())
            if all(v in ("unknown", "excluded") for v in truth.values()):
                continue
            args = row.get("tool_arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    pass
            if isinstance(args, dict) and isinstance(args.get("command"), str):
                text = args["command"]
            else:
                text = f"{row.get('tool_name')} {json.dumps(args, sort_keys=True)[:2000]}"
            out.append(
                {
                    "id": f"aa-{row['id']}",
                    "source": "hf:agent-approve",
                    "text": normalise(text),
                    "tier": None,
                    "risky": positive,
                    # Its sealed holdout stays out of training.
                    "split": "holdout" if row.get("split") == "holdout" else "train",
                    "group": f"aa-{row.get('family')}",
                }
            )
    return out


def load_private(path: Path) -> list[dict]:
    """Real prompted commands from one or more machines, labelled against the rubric.

    Each line: id, machine, project, command, workspace, tier, prompts (how many times it
    prompted), harm, scope, auto."""
    out = []
    for row in _jsonl(path):
        out.append(
            {
                "id": row["id"],
                "source": f"real:{row['machine']}",
                "machine": row["machine"],
                "project": row["project"],
                "text": normalise(row["command"], row.get("workspace")),
                "tier": row["tier"],
                "risky": row["tier"] == "ask",
                "split": "real",
                "group": f"{row['machine']}:{row['project']}",
                "weight": row.get("prompts", 1),
                "harm": row.get("harm"),
                "harm_main": row.get("harm_main", row.get("harm")),
                "scope": row.get("scope"),
                "auto": row.get("auto"),
            }
        )
    return out
