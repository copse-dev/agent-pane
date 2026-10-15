# Recovery lessons and development throughput

Status: **Partial / deferred**. Recovery tooling has shipped; the process and CI
proposals below are not new merge policy. Compiled 14 October 2026 against main
`05a9b9a4d`. Follow [AGENTS.md](../../AGENTS.md) and required repository checks
until an explicit policy change lands. Recheck live PR states before taking work.

## Outcome and evidence

The backlog recovery combined related work into reviewable batches, preserved
original heads, isolated blockers and retired originals after verified landing.
These batches landed: [Activity #3744](https://github.com/copse-dev/agent-pane/pull/3744),
[Settings/providers #3745](https://github.com/copse-dev/agent-pane/pull/3745),
[Chat/composer #3747](https://github.com/copse-dev/agent-pane/pull/3747),
[Desktop/context #3752](https://github.com/copse-dev/agent-pane/pull/3752), and
[Settings setup #3758](https://github.com/copse-dev/agent-pane/pull/3758).
This is evidence for bounded recovery batches, not a claim that all remaining
PRs are ready or that large integration branches should become the default.

| Shipped improvement                                        | What it established                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#3739](https://github.com/copse-dev/agent-pane/pull/3739) | R2 stores immutable screenshot objects; Git carries baseline metadata. Old tracked PNGs require migration when recovering branches.                           |
| [#3741](https://github.com/copse-dev/agent-pane/pull/3741) | Review packets and per-pair receipts preserve progress and expose evidence that requires revalidation.                                                        |
| [#3746](https://github.com/copse-dev/agent-pane/pull/3746) | Trusted sparse checkouts must include package metadata that controls imported helpers' module format. Tests now exercise the actual sparse layout.            |
| [#3749](https://github.com/copse-dev/agent-pane/pull/3749) | Walk invariant protection history once per filter batch, rather than once per image.                                                                          |
| [#3751](https://github.com/copse-dev/agent-pane/pull/3751) | Classify against HEAD before loading historical renders. Only genuine comparable changes need flap history.                                                   |
| [#3766](https://github.com/copse-dev/agent-pane/pull/3766) | Route stack reconciliation to affected PRs and connected stacks, retain queued edits and preserve full repair sweeps. Mutable approval evidence remains live. |

## Lessons to carry into the next batch

- Assign one integration owner to a related batch. Other agents can prepare
  independent work, but must not rewrite the same branches. Start each new batch
  in a fresh chat with a compact evidence handoff instead of carrying the whole
  recovery history in one context window.
- Preserve original heads before rebasing. A clean rebase is only integration
  evidence: inspect range-diff, resulting tree, protocol changes and screenshot
  migration. Use an explicit expected-head lease when pushing rewritten history.
  If a bot or another owner has moved the branch, stop that push and reassess.
- Inspect existing failure logs before rerunning. Settings had an IPC contract
  failure; automation had a dispatch assertion and scenario timeout. Canvas had
  a cancelled run. Those require different responses; none should be called
  flaky without reproduction evidence.
- Separate passing CI, visual approval, security/runtime acceptance and product
  decisions. Vault lease ownership and native acceptance remained blockers even
  after focused tests passed. Isolate a separable blocker instead of making the
  whole backlog wait for it.
- A main advance need not cause every agent to restack every original. Integrate
  once per batch, refresh the evidence affected by that integration, and perform
  the final required validation on the actual candidate that will land.
- Screenshot review uncovered real layout defects and capture defects. Fix
  framing, settled-state waits and viewport setup without weakening assertions.
  Do not accept unrelated drift just to clear a gate. Hundreds of candidates
  on a small PR indicate a pipeline problem worth measuring.
- Review receipts are durable observations, not transferable approvals. An
  identical image pair at a different base/head/run/context needs revalidation;
  an unreviewed pair remains unreviewed. Include committed baseline changes in
  cumulative review, not only freshly generated candidates.
- Use a prepared host for native acceptance. Missing Xvfb, native headers,
  toolchains and incompatible dependencies consumed time in cloud checkouts.
  Compare failures with the same base/environment; report gaps precisely rather
  than labeling an incomplete local gate green.
- Check ancillary publication as well as CI. #3766 itself had green CI but its
  screenshot status was missing because the publisher hit the installation API
  rate limit. Retrying only that failed workflow completed the gate; a new full
  CI run was unnecessary.
- Retire originals only after verifying included changes landed. Keep exclusions
  explicit, and replace obsolete stack declarations when recovering an excluded
  PR independently. Closed tips otherwise leave old stack gates blocked.

## Branch flow: recovery and ordinary development

**Recovery:** use a disposable integration branch to expose interactions, then
land bounded batches that have one owner and a coherent review. A branch holding
everything can be useful for exploration, but must not require every feature to
ship together. Security, hardware and product blockers need independent paths.

**Ordinary work, proposed:** prefer independent PRs and shallow stacks for real
dependencies. Use an integration branch when a feature genuinely needs coordinated
development, with explicit membership and an owner. Do not make permanent omnibus
merge branches the default; that just moves the dependency bottleneck.

Squashing child PRs into an integration branch and normally merging that branch
to main can preserve the integration commits if the repository permits it. It
does not preserve the original child commit identities, eliminate conflicts, or
remove cumulative validation. Protected squash landing also works, but requires
preserved source provenance and deliberate retirement/reparenting of descendants.
Choose the method from live repository rules, not a blanket ancestry preference.

The recovery used protected squash merges. The older
[base-freshness plan](ci-base-freshness.md) describes an available/configured merge
queue. Verify live rules and supported merge methods before designing automation;
reconcile that documentation discrepancy in the implementation PR. Never bypass
required checks to emulate a queue.

## Proposed next improvements, in priority order

### 1. Measure and reduce repeated screenshot work

First record candidate counts, unique image-pair counts, review/revalidation time,
publisher duration and API calls per event. Count time to land and retired original
PRs, not just recovery PRs opened. Existing #3766 selected/eligible counts provide
one measurement; unknown workflow associations still trigger full sweeps.

Investigate why small independent changes produce hundreds of candidate pairs.
Separate new owned changes, committed reference changes, already observed pairs,
unrelated drift and capture instability in the review presentation. Reuse the
[existing packet/receipt mechanism](../screenshot-review-packets.md); do not build
a competing ledger or silently approve repeated pixels across PRs.

Acceptance: compare representative small and batch PRs before/after. Show fewer
redundant renders or review operations while retaining complete evidence for
owned changes, additions, deletions, shared components and unexpected drift.
Include a regression that deliberately changes a shared visual dependency.

### 2. Small main gate, complete release gate

Propose affected visual specs plus a small stable cross-app smoke suite for entry
to main. Keep full required static/unit/security checks and full visual coverage
for broad or uncertain impact. A low-confidence selector must expand coverage,
not omit unknown surfaces. Test count alone is not a useful selection rule.

Run the complete visual/native release tier on an immutable promotion candidate
and release exactly that tested candidate. A changed candidate needs fresh
validation; a failed release gate blocks promotion and produces a bisectable fix
or revert. Preserve ordinary main validation while this design is evaluated.

The existing main-to-release flow already provides a foundation. Audit what it
actually runs before adding another branch or suite. Define the smoke inventory,
ownership mapping, broad-change fallback and promotion attestation, then compare
escaped regressions and main/release latency in a shadow run before changing gates.

### 3. Reuse evidence when rendering inputs are unchanged

Audit existing manifest-only acceptance and
[bounded base-refresh planning](ci-base-freshness.md#bounded-oracle-refresh-planning--3-october-2026)
before extending them. Some baseline-only acceptance already reuses completed
source evidence; this is not an entirely missing capability.

Any extension needs a trusted rendering-input identity covering source, fixtures,
assets, dependencies, browser/runtime, viewport/fonts and capture configuration.
Bind reused evidence to its exact source run and candidate. Equal PNG hashes or
equal source paths alone are insufficient. Negative tests must reject changes to
each relevant input and forged or incomplete provenance. Final review decisions
remain tied to the actual landing head under the repository's policy.

### 4. Make ownership and handoff cheap

Use one concise batch record containing owner, original PR/head SHAs, candidate
head/base, included/excluded features, exact CI evidence, screenshot packet/receipt
locations, unresolved findings and next action. Store durable references somewhere
the next agent can access; a temporary directory on another machine is not a
handoff. Refresh existing status instead of appending contradictory validation
histories. Only hand off at a recoverable checkpoint.

Provide a read-only backlog view separating ready work, failing checks, missing
visual decisions, substantive acceptance holds and superseded originals. Avoid
polling every PR from every agent; share bounded snapshots and react to events.

## Next-agent brief

Start with item 1: measure screenshot review amplification on current main and
propose one bounded repair. Inspect the shipped tooling and current PR ownership
first. Do not disturb active recovery branches or assume this snapshot is current.
Record baseline measurements, implement the smallest useful change, exercise its
failure/provenance cases, and open one reviewable PR with observed results.

Keep main/release gate changes as a separate proposal until selection and fallback
behavior have evidence. Update this plan's status and link delivered work. Required
tests, visual/security reviews and supported-platform acceptance remain in force.
