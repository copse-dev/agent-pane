"""Validate, lint and dedupe generated rows.

    python3 -I clean.py raw/*.jsonl --out ../../../bench-results/risk-classifier/adversarial/rows.jsonl

Drops a row when it is malformed, when neither bash nor zsh can parse it (zsh-only rows are
tagged `"shell": "zsh"`), when it names a host or address that
is not a placeholder, when it carries something shaped like a real secret, or when it duplicates an
earlier row (exact after normalising whitespace and placeholders, or near: token-shingle Jaccard
at or above --near). Each kept row gets a stable `id` from its command. Reasons for every drop go
to stderr, counted.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
FAMILIES = set(json.loads((HERE / "families.json").read_text()))
# Families that were renamed or split. `persistence-system` became `persistence` (code that runs
# later) and `system-settings` (lasting changes to how the machine behaves); old rows are re-filed by
# subfamily name, then by command. TCC resets moved to `macos-automation-privacy`, and git config keys
# that execute moved to `persistence` from `supply-chain-remote-code`.
SYSTEM_SETTING = re.compile(
    r"quarantine|gatekeeper|spctl|csrutil|defaults|preference|dns|etc-paths|setenv|screensaver|"
    r"macro-validation|go-env|insteadof|ssh-config"
)
SYSTEM_SETTING_COMMAND = re.compile(
    r"defaults\s+write|networksetup|scutil|spctl|csrutil|com\.apple\.quarantine|/etc/paths|launchctl\s+setenv"
)


def refile_family(row: dict) -> str | None:
    fam, sub, command = row.get("family"), str(row.get("subfamily", "")), row.get("command", "")
    if "tcc" in sub or "consent" in sub or re.search(r"\btccutil\b", command):
        return "macos-automation-privacy"
    if fam == "supply-chain-remote-code" and "fsmonitor" in command:
        return "persistence"
    if fam == "persistence-system":
        if SYSTEM_SETTING.search(sub) or (not sub and SYSTEM_SETTING_COMMAND.search(command)):
            return "system-settings"
        return "persistence"
    return fam
LABELS = {"must_ask", "safe"}
EVASIONS = {
    "none", "wrapper", "shell-reentry", "interpreter", "xargs-find", "indirection", "encoding",
    "chaining", "script-file", "config-indirection", "path-spoof", "heredoc", "split-steps",
}

# Hosts a row may name. Anything else that looks like a domain is rejected.
PLACEHOLDER_HOST = re.compile(
    r"(^|\.)(example\.(com|org|net)|invalid|test|localhost|local)$|^(localhost)$", re.I
)
# Real services the prompt allows, because publishing or fetching from them is the point.
ALLOWED_REAL = {
    "registry.npmjs.org", "npmjs.com", "www.npmjs.com", "pypi.org", "upload.pypi.org",
    "files.pythonhosted.org", "ghcr.io", "github.com", "api.github.com", "docker.io",
    "rubygems.org", "crates.io", "index.crates.io", "proxy.golang.org", "formulae.brew.sh",
    "hooks.slack.com", "api.anthropic.com", "appstoreconnect.apple.com", "s3.amazonaws.com",
}
DOMAIN = re.compile(r"(?<![\w.@/-])((?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|co|sh|xyz|ru|cn|me|cloud|ai))(?![\w-])", re.I)
IPV4 = re.compile(r"\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b")
TEST_NETS = (("192", "0", "2"), ("198", "51", "100"), ("203", "0", "113"))
SECRET_SHAPES = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----\s*\n?\s*[A-Za-z0-9+/]{40,}"),
    re.compile(r"\bghp_[A-Za-z0-9]{36}\b"),
    re.compile(r"\bAKIA(?!EXAMPLE)[0-9A-Z]{16}\b"),
    re.compile(r"\bxox[abp]-[0-9]{6,}-[A-Za-z0-9-]{10,}"),
    re.compile(r"\bsk-(?!test)[A-Za-z0-9]{32,}"),
]


def host_problems(text: str) -> list[str]:
    bad = []
    for m in DOMAIN.finditer(text):
        host = m.group(1).lower()
        if host in ALLOWED_REAL or PLACEHOLDER_HOST.search(host):
            continue
        if re.search(r"\.(json|js|mjs|ts|sh|py|md|txt|plist|app|zip|dmg|log|co)$", host) and "/" not in host:
            # file names such as package.json or com.acme.agent.plist, not hosts
            if not host.endswith((".com", ".org", ".net", ".io", ".dev")):
                continue
        if re.match(r"^com\.|^org\.|^io\.|^dev\.", host):  # reverse-DNS bundle ids
            continue
        bad.append(host)
    for m in IPV4.finditer(text):
        octets = m.groups()
        if any(int(o) > 255 for o in octets):
            continue
        if octets[:3] in TEST_NETS or octets[0] in {"127", "0", "10"} or octets[:2] == ("192", "168"):
            continue
        bad.append(".".join(octets))
    return bad


def normalise(command: str) -> str:
    c = command.strip()
    c = re.sub(r"\s+", " ", c)
    c = re.sub(r"\b\d+\.\d+\.\d+\b", "<ver>", c)
    c = re.sub(r"(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+", "<ip>", c)
    return c


def shingles(command: str, k: int = 3) -> set[tuple[str, ...]]:
    tokens = re.findall(r"[A-Za-z0-9_./~$-]+|[|;&<>]", normalise(command).lower())
    return {tuple(tokens[i : i + k]) for i in range(max(1, len(tokens) - k + 1))}


def parsing_shell(command: str) -> str | None:
    """`bash` when bash parses the command, else `zsh` when zsh does, else None.

    Agents on macOS run zsh, and its glob qualifiers (`*(/Nmw+4)`) are not bash syntax, so a
    zsh-only row is kept and tagged `"shell": "zsh"`. Copse's own `run_shell` uses `/bin/sh`, so a
    gate verdict on such a row only speaks for agents that run zsh. Without zsh installed a
    zsh-only row cannot be told apart from a broken one and is dropped as `zsh-unavailable`.
    """
    if subprocess.run(["bash", "-n"], input=command, capture_output=True, text=True).returncode == 0:
        return "bash"
    if shutil.which("zsh") is None:
        return None
    done = subprocess.run(["zsh", "-n"], input=command, capture_output=True, text=True)
    return "zsh" if done.returncode == 0 else None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--near", type=float, default=0.8)
    ap.add_argument("--source", default=None, help="tag kept rows with this source, e.g. the model name")
    ap.add_argument("--against", type=Path, nargs="*", default=[], help="already-kept rows: new rows that duplicate them are dropped")
    args = ap.parse_args(argv)

    dropped: Counter[str] = Counter()
    kept: list[dict] = []
    seen_exact: set[str] = set()
    kept_shingles: list[tuple[str, set]] = []
    for path in args.against:
        for line in path.read_text().splitlines():
            prior = json.loads(line)
            seen_exact.add(normalise(prior["command"]))
            kept_shingles.append((normalise(prior["command"]), shingles(prior["command"])))
    for path in args.inputs:
        for line in path.read_text().splitlines():
            line = line.strip().strip(",")
            if not line.startswith("{"):
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                dropped["bad-json"] += 1
                continue
            command = row.get("command")
            if not isinstance(command, str) or not command.strip():
                dropped["no-command"] += 1
                continue
            fam = row["family"] = refile_family(row)
            if row.get("label") not in LABELS or not (fam in FAMILIES or (isinstance(fam, str) and fam.startswith("new:"))):
                dropped["bad-label-or-family"] += 1
                continue
            ev = row.get("evasion") or ["none"]
            if isinstance(ev, str):
                ev = [ev]
            row["evasion"] = [e for e in ev if e in EVASIONS or str(e).startswith("new:")] or ["none"]
            files = row.get("files") or {}
            if not isinstance(files, dict) or not all(isinstance(v, str) for v in files.values()):
                dropped["bad-files"] += 1
                continue
            row["files"] = files
            blob = command + "\n" + "\n".join(files.values())
            # A row already tagged zsh was checked when it was first cleaned.
            shell = "zsh" if row.get("shell") == "zsh" else parsing_shell(command)
            if shell is None:
                zsh_missing = shutil.which("zsh") is None
                dropped["zsh-unavailable" if zsh_missing else "shell-parse"] += 1
                continue
            if shell == "zsh":
                row["shell"] = "zsh"
            else:
                row.pop("shell", None)
            hosts = host_problems(blob)
            if hosts:
                dropped["non-placeholder-host"] += 1
                print(f"drop host {sorted(set(hosts))}: {command[:100]}", file=sys.stderr)
                continue
            if any(p.search(blob) for p in SECRET_SHAPES):
                dropped["secret-shaped"] += 1
                continue
            norm = normalise(command)
            if norm in seen_exact:
                dropped["duplicate-exact"] += 1
                continue
            sh = shingles(command)
            near = next(
                (other for other, osh in kept_shingles if len(sh & osh) / max(1, len(sh | osh)) >= args.near),
                None,
            )
            if near is not None:
                dropped["duplicate-near"] += 1
                continue
            seen_exact.add(norm)
            kept_shingles.append((norm, sh))
            if args.source:
                row["source"] = args.source
            row["id"] = "adv-" + hashlib.sha256(norm.encode()).hexdigest()[:12]
            kept.append(row)

    # `pair` is a 0-based line in the model's output for one batch; resolve it to the twin's id.
    batches: dict[str, list[str]] = {}
    for path in args.inputs:
        for line in path.read_text().splitlines():
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            batches.setdefault(r.get("batch", ""), []).append(normalise(str(r.get("command", ""))))
    ids = {normalise(r["command"]): r["id"] for r in kept}
    for row in kept:
        p, order = row.get("pair"), batches.get(row.get("batch", ""), [])
        row["pair"] = ids.get(order[p]) if isinstance(p, int) and 0 <= p < len(order) else None

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w") as f:
        for row in kept:
            f.write(json.dumps(row) + "\n")
    labels = Counter(r["label"] for r in kept)
    print(f"kept {len(kept)} ({dict(labels)}); dropped {sum(dropped.values())} {dict(dropped)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
