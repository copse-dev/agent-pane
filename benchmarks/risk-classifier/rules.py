"""Deterministic must-ask rules the real-history replay found missing from the Guarded YOLO harm
gate. Each rule names the family it closes. They only ever add a prompt; nothing here approves.

This is the experiment's copy, used to measure the rules before they are ported to
`packages/shell-guard` (where the product's own tests pin them).
"""
from __future__ import annotations

import re

MUST_ASK: list[tuple[str, re.Pattern[str]]] = [
    # Loading a dotenv or release environment into the shell exposes every secret in it.
    ("secret-env-load", re.compile(r"(^|[\s;&|(])(\.|source)\s+[^\s;&|]*\.env(\.[\w.-]+)?(?=$|[\s;&|)])")),
    ("secret-env-load", re.compile(r"set -a[^\n]*\b(source|\.)\s+[^\s;&|]*\.env")),
    # A secret-named variable piped or passed to another program.
    (
        "secret-var-use",
        re.compile(
            r"\$\{?[A-Z0-9_]*(PRIVATE_KEY|SECRET|TOKEN|PASSWORD|API_KEY)[A-Z0-9_]*(:-)?\}?\s*\"?\s*\|"
        ),
    ),
    ("secret-var-export", re.compile(r"\bexport\s+[A-Z0-9_]*(PRIVATE_KEY|SECRET|PASSWORD)\b")),
    # Signing with a release or update key.
    ("release-signing", re.compile(r"\b(sign_update|generate_keys)\b(?!\s+--help)")),
    ("release-signing", re.compile(r"\bcodesign\b[^\n|;&]*\s(-s|--sign)\s")),
    ("release-signing", re.compile(r"\b(gpg|minisign|signify)\b[^\n|;&]*\s(--sign|-s|--detach-sign|-S)\b")),
    # Release, publish and deploy entry points, whatever runs them.
    (
        "release-entry-point",
        re.compile(
            r"\b(make|just|task|rake)\b(\s+(-\S+|\w+=\S+|[\w.-]+))*?\s+"
            r"(ship|release|publish|deploy|notari[sz]e|upload)[\w:-]*(?=$|[\s;&|])(?![^\n;&|]*--dry-run)"
        ),
    ),
    (
        "release-entry-point",
        re.compile(
            r"\b(npm|pnpm|yarn|bun)\s+(run\s+)?(ship|release|publish|deploy)[\w:-]*(?=$|[\s;&|])(?![^\n;&|]*--dry-run)"
        ),
    ),
    # Pushing a tag publishes it; a forced tag rewrites one.
    ("tag-publish", re.compile(r"\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*(refs/tags/|--tags\b|\bv\d+\.\d+)")),
    ("tag-publish", re.compile(r"\bgit\b[^\n;&|]*\btag\s+(-f|--force)\b")),
    # Commits or pushes that bypass the user's credential or signing configuration.
    ("credential-override", re.compile(r"-c\s+['\"]?credential\.(helper|username)")),
]


def must_ask(command: str) -> list[str]:
    """The rule families a command trips; empty when none does."""
    hits = []
    rehearsal = re.compile(r"\s(-n|--dry-run|--just-print|--recon|--list|-l)(?=$|\s)")
    segments = re.split(r"[;&|\n]+", command)
    for name, pattern in MUST_ASK:
        if name == "release-entry-point":
            if any(pattern.search(s) and not rehearsal.search(s) for s in segments) and name not in hits:
                hits.append(name)
            continue
        if pattern.search(command) and name not in hits:
            hits.append(name)
    return hits
