# Resumable screenshot review

`pnpm screenshots:review` collects a complete local inventory of **base → head**
reference changes and **head → candidate** changes. It saves verified PNGs,
dimensions, immutable Git revisions and per-image working notes outside tracked
baselines. It supports both tracked PNG history and R2 manifests.

This is an evidence and progress tool, not an approval service. It never changes
PR labels, comments, statuses, branches or baselines. A recorded finding may still
be a blocker. Required CI and screenshot acceptance workflows remain authoritative.

## Collect

First identify the CI run linked from the trusted screenshot evidence comment.
With authenticated `gh`, a same-repository PR with a published compare branch needs:

```bash
pnpm screenshots:review collect --repo copse-dev/agent-pane --pr 3702 \
  --run 123456789 --mode batch \
  --context 'Linux canonical CI; reviewed stack membership and fixture/browser versions'
```

The example run ID is a placeholder. Use the actual run linked by the publisher.
The command reads PR/run metadata, checks that the run is current-head CI that
rendered the screenshots (a green run, or a red one whose `screenshot-artifacts` job
passed), fetches the compare branch and base/head commits, and verifies that the compare
commit has exactly one parent (the head) and only screenshot evidence changes.
It does not execute code from those commits or change the checkout.

The reviewer must still verify the trusted publisher, matching run/artifact,
capture environment and stack coverage. A run ID alone does not bind a compare
commit to that run. The context records that review; it is not a machine attestation.
Modes (`pr`, `batch`, `release`) label and isolate review records, not change CI
selection or relax acceptance. For a stack/batch, base must be its cumulative base,
not an intermediate parent. GitHub discovery uses the PR's current base tip; pass
explicit refs when a different verified cumulative/evidence base is required.

For already-fetched, independently verified evidence, pass all three full commit
SHAs (abbreviations and branch names are rejected):

```bash
pnpm screenshots:review collect --repo copse-dev/agent-pane --pr 3702 \
  --base <base-sha> --head <head-sha> --compare <compare-sha> \
  --run <run-id> --mode batch --context '<capture environment and coverage evidence>'
```

This path makes no GitHub API call and does not verify the run remotely. Fork or
artifact-only reviews without a valid compare commit still use the existing manual
review path; do not fabricate a compare commit or report them as collected.

Output is `.tmp/screenshot-review/<PR>/`:

- `current.json`: current complete inventory and evidence fingerprint.
- `<fingerprint>.json`: archived inventory for each evidence revision.
- `images/<sha256>.png`: verified, deduplicated image bytes.
- `review.md`: links to full-size before/after images, dimensions and progress.
- `receipts.json`: working decisions, created on the first `record` command.

R2 reads use the configured public URL (or the repository default), require HTTPS,
and verify byte length and SHA-256. A network denial, missing object or corrupt
cache fails collection rather than silently omitting an image. Retry after fixing
access; verified images already downloaded are reused. No R2 write credentials are
needed. If your environment requires an HTTP proxy, use its supported Node fetch
proxy configuration (for example `NODE_USE_ENV_PROXY=1`); do not bypass the proxy.
Run one writer per packet directory. Preserve the directory when handing work to
another agent or machine; it is ignored local state, not automatically uploaded.

## Inspect, record and resume

Open `review.md`, then open both images for each item at readable resolution.
Contact sheets and dimensions do not substitute for visual inspection. Use the
owning specs and intended behavior to classify the difference.

```bash
pnpm screenshots:review record --pr 3702 --item candidate/activity-home.png \
  --classification intentional --note 'Reviewed full images: controls remain visible at the new breakpoint; fixture asserts column count.'
pnpm screenshots:review status --pr 3702
```

Classifications are `intentional`, `drift`, `instability`, `breakage`, `unresolved`.
Use `committed/<filename>` for a base → head item and `candidate/<filename>` for
a head → candidate item. Each comparison is reviewed separately. Include the visible
cause, relevant code/spec and any follow-up in the note. Do not put secrets in notes.

Run `collect` again after interruption or changed evidence:

- **recorded**: the exact image pair and entire evidence fingerprint match.
- **revalidate**: an identical pair was reviewed, but base/head/compare/run/context
  changed. Prior notes remain visible; verify current provenance, intent, environment
  and coverage before explicitly recording a current decision. Image equality alone
  does not prove unchanged behavior. If those checks cannot establish equivalence,
  reinspect or mark unresolved.
- **unreviewed**: no matching pair for this repository, PR, mode and comparison.
  Inspect it. An altered image is never automatically accepted by a prior decision.

Old notes and archived packets are retained when candidates disappear or change.
An invalid ledger fails visibly instead of resetting completed work. Progress is
not a pass count: recorded breakage, instability and unresolved findings still block.
A zero-item packet is not proof of no candidates or complete stack coverage.

## Bound investigation and finish

Use existing full-resolution artifacts first. If the cause remains unclear, run
the owning spec on base/head in the same environment. Escalate to broader testing
only when shared changes or unexplained interactions warrant it. Record the result
once so another reviewer does not repeat the investigation.

Record inherited defects separately from introduced/worsened defects in notes,
including base evidence and follow-up. This tool does not create a waiver: existing
repository blocking policy still applies. Likewise, targeted-main/full-release
testing needs workflow and policy changes; selecting a packet mode does not enable it.

Before acceptance, refresh the live PR/evidence and finish all required comparisons,
including cumulative stack coverage and already-committed references. Follow
`pr-screenshot-review` to select/accept/decline through the repository's existing
workflow. Verify that workflow's result. Never treat this local ledger as a trusted
status or an automatic authorization to merge.
