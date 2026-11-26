"""Extract every shell command an agent ran from a Copse store, joined to the prompts it raised.

  python3 -I benchmarks/risk-classifier/extract.py --copse-dir ~/.copse --machine studio \
      --out bench-results/risk-classifier/data

Writes `<machine>-calls.jsonl` (one row per tool call) and `<machine>-unique.jsonl` (one row per
unique working directory and command, with how often it ran and prompted). Both stay on this
machine with 0600 permissions: they hold real commands, paths and sometimes secrets.

A store copied from another machine works the same way; untar it into an empty directory and pass
that as --copse-dir. Native threads, ACP-bridged calls (`mcp.copse.run_shell`) and legacy Guarded
YOLO `permission_decision` lines are all read. Prompts are joined by tool-call or bridge id; an old
decision line without either is attached to the next shell call in the same thread and marked
`approxJoin`.
"""
from __future__ import annotations

import argparse
import collections
import glob
import hashlib
import json
import os
import re

FIXTURE_PROJECT = re.compile(
    r"^(e2e-|headless-project-|proj-|project-|copse-apple-smoke$|tmp$|_global$|acp-|other-project$|"
    r"shell-tool-yield$|remote-p1$|p-local$|skill-|identity-fixture$|scratch-project$|"
    r"review-current-request$|read-retry$|project$)"
)
SHELL_NAMES = {"run_shell", "run_background"}


def _read_json(path: str):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def _tool(name: str | None) -> str | None:
    """`run_shell` for `run_shell`, `mcp__copse__run_shell`, `mcp.copse.run_shell` and `Bash`."""
    if not name:
        return None
    if name == "Bash":
        return "run_shell"
    short = name.split(".")[-1].replace("mcp__copse__", "")
    return short if short in SHELL_NAMES else None


def _command(args) -> str | None:
    if not isinstance(args, dict):
        return None
    command = args.get("command")
    if not isinstance(command, str) and isinstance(args.get("arguments"), dict):
        command = args["arguments"].get("command")
    return command if isinstance(command, str) and command.strip() else None


def calls_in_thread(events_path: str, base: dict) -> list[dict]:
    thread_dir = os.path.dirname(events_path)
    calls: dict[str, dict] = {}
    by_bridge: dict[str, str] = {}
    order: list[str] = []
    legacy: list[dict] = []
    pending: list[dict] = []
    with open(events_path, encoding="utf-8", errors="ignore") as handle:
        lines = handle.readlines()
    for line in lines:
        try:
            event = json.loads(line)
        except ValueError:
            continue  # a torn final line from a live writer
        kind = event.get("type")
        if kind == "message":
            for call in event.get("toolCalls") or []:
                tool, command = _tool(call.get("name")), _command(call.get("args"))
                if tool is None or command is None:
                    continue
                key = call.get("id") or f"m{len(order)}"
                calls[key] = dict(base, tool=tool, command=command, prompts=[], yolo=[])
                order.append(key)
                if pending:
                    calls[key]["prompts"].append(dict(pending.pop(0), approxJoin=True))
        elif kind == "decision" and event.get("kind") == "bridge-request" and event.get("detail"):
            if event.get("subject") not in SHELL_NAMES:
                continue
            command = _command(_read_json(os.path.join(thread_dir, event["detail"]["ref"])) or {})
            if command is None:
                continue
            key = "b:" + event["bridgeExecutionId"]
            by_bridge[event["bridgeExecutionId"]] = key
            calls[key] = dict(base, tool=event["subject"], command=command, prompts=[], yolo=[])
            order.append(key)
        elif kind == "decision" and event.get("actor") == "user" and event.get("kind") == "shell":
            detail = (_read_json(os.path.join(thread_dir, event["detail"]["ref"])) if event.get("detail") else None) or {}
            record = {k: event.get(k) for k in ("verdict", "remembered", "cause", "reasons", "subject")}
            keys = list(detail.get("toolCallIds") or []) + [by_bridge.get(b) for b in detail.get("bridgeExecutionIds") or []]
            keys.append(event.get("toolCallId"))
            hit = False
            for key in keys:
                if key in calls:
                    calls[key]["prompts"].append(record)
                    hit = True
            if not hit and not detail:
                pending.append(record)
        elif kind == "permission_decision":
            legacy.append(event)
    by_command = collections.defaultdict(list)
    for key in order:
        by_command[calls[key]["command"]].append(key)
    for event in legacy:
        keys = by_command.get(event.get("originalCommand"))
        if not keys:
            continue
        call = calls[keys[0]]
        call["yolo"].append({k: event.get(k) for k in ("originalMode", "sandboxState", "harmDecision", "policyDecision", "userResponse")})
        if event.get("userResponse") not in (None, "none", "auto", "not-required"):
            call["prompts"].append({"verdict": event.get("userResponse"), "cause": "guarded-yolo", "reasons": event.get("harmReasons")})
    return [calls[key] for key in order]


def extract(copse_dir: str, machine: str) -> list[dict]:
    config = _read_json(os.path.join(copse_dir, "user-data", "config.json")) or {}
    roots = {p["id"]: p.get("path") for p in config.get("projects", []) if p.get("id")}
    out = []
    for project_dir in sorted(glob.glob(os.path.join(copse_dir, "workspace", "*"))):
        project = os.path.basename(project_dir)
        root = roots.get(project)
        if FIXTURE_PROJECT.match(project) or not os.path.isdir(project_dir):
            continue
        if root and root.startswith(("/private/tmp", "/tmp")):
            continue
        for events in sorted(glob.glob(os.path.join(project_dir, "*", "events.jsonl"))):
            meta = _read_json(os.path.join(os.path.dirname(events), "meta.json")) or {}
            workspace = (meta.get("worktree") or {}).get("path") or root or meta.get("cwd")
            base = dict(machine=machine, project=project, root=root, workspace=workspace, thread=os.path.basename(os.path.dirname(events)))
            out.extend(calls_in_thread(events, base))
    return out


def unique(calls: list[dict]) -> list[dict]:
    rows: dict[str, dict] = {}
    for call in calls:
        workspace = call["workspace"] or ""
        key = hashlib.sha256(f"{workspace}\0{call['command']}".encode()).hexdigest()[:16]
        row = rows.setdefault(
            key,
            dict(id=key, machine=call["machine"], project=call["project"], command=call["command"], workspace=workspace, root=call["root"], occurrences=0, prompts=0, reasons=set(), unsandboxedAutoRun=0),
        )
        row["occurrences"] += 1
        row["prompts"] += 1 if call["prompts"] else 0
        for prompt in call["prompts"]:
            row["reasons"].update(prompt.get("reasons") or [])
        row["unsandboxedAutoRun"] += sum(1 for y in call["yolo"] if y.get("sandboxState") == "unsandboxed" and y.get("userResponse") == "not-required")
    for row in rows.values():
        row["reasons"] = sorted(row["reasons"])
    return list(rows.values())


def _write(path: str, rows: list[dict]) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--copse-dir", default=os.environ.get("COPSE_DIR", os.path.expanduser("~/.copse")))
    ap.add_argument("--machine", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    os.makedirs(args.out, mode=0o700, exist_ok=True)
    calls = extract(args.copse_dir, args.machine)
    rows = unique(calls)
    _write(os.path.join(args.out, f"{args.machine}-calls.jsonl"), calls)
    _write(os.path.join(args.out, f"{args.machine}-unique.jsonl"), rows)
    prompted = sum(1 for c in calls if c["prompts"])
    print(f"{args.machine}: {len(calls)} shell calls, {prompted} prompted ({prompted / max(1, len(calls)):.0%}); {len(rows)} unique commands")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
