# Public-readiness decisions (proposed)

Status: **Proposed — awaiting owner sign-off.** Nothing in this file is an
accepted GA finding or a GA waiver. It exists so the owner can confirm or
rewrite each paragraph in one pass.

The public-readiness review split “this week” into docs anyone can land, and
decisions only the owner can record. The docs half is in this PR. The decision
half is below.

Required fields for an **accepted** residual, from
[security-review-ga.md](security-review-ga.md): owner, date, rationale, review
date. A GA waiver is a separate record and is not requested here.

Owner to confirm: **Jonathan Kingston**. Date to stamp on accept: the day you
reply. Suggested review date: the next release candidate.

---

## D1 — Accept M3 (hook `onFailure` defaults to open)

**Finding.** Privileged hook execution is sandboxed on macOS/Linux. Residual:
`onFailure` defaults to `open` (vendor Claude/Cursor semantics), so a hook that
crashes or times out abstains; Windows hooks stay unconfined.

**Proposed acceptance.** Keep the vendor default. Changing it would break
imported hook files. Compensating control: the Copse `sandbox: false` escape is
the only opt-out and is badged “outside sandbox” in Settings → Sources before
the workspace is trusted. Re-review if we ship a Copse-native hook format that
does not import Claude/Cursor files.

**Ask.** Accept M3 as written?

## D2 — Accept L1 (plaintext API-key fallback)

**Finding.** When OS secure storage is unavailable, Copse may persist a key as
recoverable base64 after explicit consent.

**Proposed acceptance.** Keep the fallback. Removing it strands Linux/headless
sessions with no keyring. Compensating control: refuse until the user consents;
badge the risk; environment-only keys are never written. Re-review if a
supported GA platform has no working key store in normal use (Windows/macOS
should not hit this).

**Ask.** Accept L1 as written?

## D3 — Accept L8 (renderer `style-src 'unsafe-inline'`)

**Finding.** Monaco and mermaid need inline styles, so the renderer CSP allows
`style-src 'unsafe-inline'`.

**Proposed acceptance.** Do not rewrite the editor stack before public. Compensating
control: the rest of the CSP plus HTML sanitizer. Re-review if we replace Monaco
or add a second privileged renderer surface.

**Ask.** Accept L8 as written?

## D4 — Accept N2 (user Shells tab is unsandboxed)

**Finding.** User-directed terminals spawn with `unsandboxed: true` and
`decideTerminalPermission` does not prompt where a sandbox is active. Agent
`run_shell` remains gated.

**Proposed acceptance.** A terminal the user opened is a user decision, not an
agent action. Do not reopen #662. User docs now say this plainly
([docs/user/project-sandbox.md](user/project-sandbox.md),
[docs/user/approvals.md](user/approvals.md)). Re-review when #623 (ACP
client-owned terminals) ships a sandboxed terminal backend.

**Ask.** Accept N2 as written?

## D5 — Record R-10 (GA platform)

**Proposed decision (dated the day you confirm).** General availability is
**macOS 26 or newer** on Apple Silicon (`arm64`) and Intel (`x64`) only.
Linux and Windows remain source-development platforms, not GA targets.
[#802](https://github.com/copse-dev/agent-pane/issues/802) is the public
distribution channel for that Mac app, not a promise of other platforms.
[#1382](https://github.com/copse-dev/agent-pane/issues/1382) tracks Linux/Windows
readiness as post-GA work. Off-desktop hand-off (#659) is a separate product,
not a substitute GA.

This is already how [SUPPORT.md](../SUPPORT.md) and
[docs/releasing-macos.md](releasing-macos.md) read. The missing piece is a
dated owner sentence connecting those files to R-10.

**Ask.** Record R-10 as that paragraph?

## D6 — Record R-21 (no enterprise control plane)

**Proposed decision (dated the day you confirm).** Copse will **not** build
SSO, SCIM provisioning, RBAC, a hosted audit-export appliance, or compliance
attestation. Those features presume a Copse account and a hosted backend. We
have neither, and [docs/privacy-data-flow.md](privacy-data-flow.md) already
records “one person per installation” as a non-goal. Enterprise buyers who need
that plane should not expect it from Copse.

This is not a waiver of [N1](security-review-ga.md) or of local permission
logging (#656). It is a non-goal for a _hosted_ control plane.

**Ask.** Record R-21 as that paragraph?

---

## Not asked here

| Item                                                   | Why it is not a D-question                                                                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| N1 / #1248                                             | Fix, do not waive. Implemented in #1763.                                                                                                      |
| Human security review + ledger SHA refresh             | Release-engineering bucket C.                                                                                                                 |
| Make the repository public (#802)                      | Needs a working download URL.                                                                                                                 |
| Flip `coming-soon` on copse.dev                        | Same gate as #802.                                                                                                                            |
| VitePress vs `scripts/build.mts` for `copse.dev/docs/` | Open question in [docs/plans/docs-site.md](plans/docs-site.md). The seven user pages are Markdown in `docs/user/` until you pick a generator. |

## After you answer

Reply with accept/rewrite per D1–D6. A follow-up change will stamp owner, date,
and review date into [security-review-ga.md](security-review-ga.md) and
[docs/plans/user-control-surface-gaps.md](plans/user-control-surface-gaps.md)
and will **not** mark any `ga-blocker` issue closed.
