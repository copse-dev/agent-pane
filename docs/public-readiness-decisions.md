# Public-readiness decisions

Status: **Owner decisions recorded 2026-08-27.**

Owner: **Jonathan Kingston**. Accepted security residuals below are reviewed again at
the next release candidate, and no later than 2026-09-30. These records are not GA
waivers and do not close a `ga-blocker` issue.

## D1 — Blocking command hooks default fail-closed

M3 is being remediated rather than accepted. Copse defaults blocking command-hook
execution failures to closed: crash, timeout, spawn failure, and invalid output deny the
gated action. Cursor `failClosed: false` and Copse `onFailure: "open"` remain explicit
per-hook compatibility escapes. Claude has no per-hook escape. All external hooks remain
off by default, and Settings → Sources keeps the global control available so a user can
disable an incompatible hook set.

Decision owner/date: Jonathan Kingston, 2026-08-27.

## D2 — Plaintext secret persistence is process-opt-in

L1 is being remediated rather than accepted. When no OS keyring is available, plaintext
secret persistence is disabled by default. The exceptional compatibility path requires
starting Copse with `COPSE_ALLOW_PLAINTEXT_SECRETS=1`; after that process-level opt-in,
the existing per-save plaintext confirmation is still required. Environment-only provider
keys remain unwritten.

Decision owner/date: Jonathan Kingston, 2026-08-27.

## D3 — Accept L8 (`style-src 'unsafe-inline'`)

Accepted for GA. Monaco and mermaid require inline styles, and replacing the editor/rendering
stack is not a pre-public-release change. Compensating controls are the remaining renderer
CSP, strict mermaid handling, and HTML sanitization. Re-review if Monaco/mermaid rendering,
the CSP, or the privileged renderer boundary changes.

Acceptance owner/date: Jonathan Kingston, 2026-08-27. Review: next RC or 2026-09-30.

## D4 — Accept N2 (user Shells tabs are unsandboxed)

Accepted for GA as intentional design. A terminal the user opened is a user-directed shell,
not an agent action; agent `run_shell` and `run_background` remain permission-gated and
contained where the project sandbox is available. Re-review when #623 ships a sandboxed ACP
terminal backend or the product allows an agent to open/drive this surface without a fresh
user action.

Acceptance owner/date: Jonathan Kingston, 2026-08-27. Review: next RC or 2026-09-30.

## D5 — GA platform boundary

General availability is **macOS 26 or newer** on Apple Silicon (`arm64`) and Intel (`x64`)
only. Linux and Windows remain source-development platforms, not GA targets. #802 is the
public distribution channel for that Mac app. #1382 tracks Linux/Windows readiness after GA;
off-desktop hand-off (#659) is separate.

Decision owner/date: Jonathan Kingston, 2026-08-27.

## D6 — No enterprise control plane

Copse will not build SSO, SCIM provisioning, RBAC, a hosted audit-export appliance, or
compliance attestation for GA. Those features presume a Copse account and hosted backend;
Copse has neither. This does not waive local permission logging or any local security finding.

Decision owner/date: Jonathan Kingston, 2026-08-27.

## D7 — Accept N3 (Guarded YOLO)

Accepted for GA as an explicit user-armed faster mode. In plain terms: while armed for one
thread and app session, some low-risk commands that need outside-workspace or network access
may run without their usual extra scope prompt. Credential/broad-path reads and destructive
forms remain denied; writes, opaque GitHub CLI calls, and dedicated GitHub write tools still
prompt; contained work keeps the OS sandbox. Re-review if the mode becomes persistent,
project-wide, remotely armable, or the host-owned harm gate weakens.

Acceptance owner/date: Jonathan Kingston, 2026-08-27. Review: next RC or 2026-09-30.

## D8 — Electron-only first GA

First GA is the Electron app published by `release-mac.yml`. The opt-in Servo/Tauri prototype
is a development surface, is not packaged by the GA workflow, and makes no GA security or
support claim until it receives a separate renderer/sidecar/origin review.

Decision owner/date: Jonathan Kingston, 2026-08-27.

## D9 — Public distribution sequence

GitHub Releases is the canonical public download host. Before a stable GA tag, publish and
install-test a signed and notarized public prerelease from the same release workflow. The
repository and `copse.dev` download link do not go public until that artifact exists and has
passed the release checklist.

Decision owner/date: Jonathan Kingston, 2026-08-27.

## Human review assignment

Jonathan Kingston is the human security reviewer and release owner. D1/D2 are merged and were
re-reviewed on the 2026-08-28 product-code candidate. Jonathan authorized cutting and validating
beta releases on 2026-08-28. Stable-GA sign-off remains pending until a signed, notarized
prerelease has been produced and installed successfully and the public/update gates are evidenced.
