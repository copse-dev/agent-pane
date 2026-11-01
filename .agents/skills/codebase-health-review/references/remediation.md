# Fixes and PR validation

Use this reference when the campaign includes implementation or PR completion. Repository rules
and the user's requested gates remain authoritative; this reference does not add a new approval
process or permit weakening them.

## Establish a small fix

Before editing, confirm the causal path and observable acceptance criteria. Prefer a regression
that fails for the reported bug and passes for the fix. For races, control the relevant completion
order; test the state visible to the user or the real persistence/cancellation boundary, not a copy
of the implementation. Preserve adjacent behavior and use an independent reviewer for risky fixes.

Use the standard scripts and the lowest useful tier from
[`docs/testing-strategy.md`](../../../../docs/testing-strategy.md), then run the broader gates
required by `AGENTS.md` and the oracle. Use the documented background mechanism for long checks;
if unavailable, retain an owned session and complete log. Coordinate expensive native/Electron
work so parallel agents do not manufacture resource failures.

Once a check passes, repeat it when a relevant change, failure or unresolved concern justifies it.
A new label or description is not a source-code change. A rebase still needs the repository's
current-head integration gates; explicitly revalidate any reusable evidence against the actual
delta rather than blindly repeating every local experiment or transferring a green result.

For local full-check failures, follow
[`docs/host-environment-test-noise.md`](../../../../docs/host-environment-test-noise.md).
Match exact diagnostics and relevant producer/test versions. Use a bounded clean-base or harmless
dirty-tree control where needed. "Also fails on base" does not make a real product defect harmless.
Report a no-new-failures local result accurately; never describe it as a zero-failure run.

## Keep source and evidence aligned

Maintain a small per-PR validation record, alongside the campaign's finding record:

- live state, source head, branch/base and owner;
- acceptance criteria, focused tests and independent review findings;
- required checks and results, with immutable run/job links;
- the actual checked-out/tested merge or tree when making integration claims;
- visual evidence and review coverage when applicable;
- current reference-only head, if different from the validated implementation head;
- remaining blocker, next action and final draft/ready/merged state.

Read the live PR state before pushing, applying evidence or changing readiness. CI green for an old
head is not green for a changed implementation. `CI Passed` alone does not prove which later base
commits were tested; use immutable checkout logs or identity artifacts for that claim. Do not claim
that an earlier tested merge is the final merged tree without comparing them.

Preserve a user's external merge or branch update. Do not resurrect or overwrite a merged branch.
If authorized work remains after an external merge, preserve it and prepare only the remaining
follow-up against the current base, with its own validation and clear provenance.

## Triage CI before spending another run

Read the failed step and logs, then identify whether the problem is a product regression, fixture,
environment, dependency/audit finding, infrastructure failure, or advisory report.

- Fix a genuine regression and validate its focused case before another broad run.
- For a demonstrated transient infrastructure failure, such as artifact upload failing after tests
  passed, retry the failed job and necessary dependents once. Preserve the diagnosis; if it recurs,
  investigate or report the external blocker instead of retrying indefinitely.
- For a dependency gate, first check main and existing PRs for the same repair. Prefer a scoped
  compatible update, preserve local patches and unrelated policy, and verify the installed tree,
  audit and relevant tests. Do not hide a finding with new exceptions or a lower threshold.
- Distinguish required gates from advisory checks using current repository policy. The
  [base-freshness workflow](../../../../.github/workflows/base-freshness.yml) currently defines
  `Base Current` as a report, not a required check. Re-read the definition and applicable branch
  rules. Investigate its overlap and state the result honestly; do not invent a merge requirement
  or pretend its failure is green. A required up-to-date-branch rule, explicit user requirement or
  a real conflict still needs resolution.

Recheck main before duplicating a shared repair. If it already supplies the fix, drop the duplicate
and verify the remaining patch. Do not chase every unrelated base advancement. Update the branch
for actual conflicts, applicable required or user-requested gates, or a demonstrated integration concern, preserving
reviewed work and using the repository's normal integration process.

## Review images through the owning workflow

For visible changes, use the focused visual workflow referenced by `AGENTS.md`. For baseline
decisions, use [`pr-screenshot-review`](../../pr-screenshot-review/SKILL.md); keep its packet and
receipts across handoffs. Passing CI, an identical image on another PR or a small pixel count is
not by itself visual approval. Reproducing a variation on base locates its origin; it does not
establish that it is healthy or deterministic.

Fix observed capture instability at a supported boundary, retain the behavioral assertions and
rerun the focused state before the broad tier. Do not add a test-only product API, mask missing UI,
accept alternating baselines, or rerun until a preferred image happens to appear. Accept only
reviewed references that belong to the fix; leave understood unrelated drift to its owner.

If the base advanced, a direct base-tree versus branch-tree inventory can report an upstream-added
reference as absent. Inspect the actual PR diff/merge base and the tested merge before claiming the
PR deleted it. Record preservation evidence and review the image; do not waive a real removal.

A reference-only follow-up may legitimately skip another render under repo policy when its actual
source parent has completed the required rendering. Verify the parent, exact subset, image hashes
and resulting head. Never manufacture a reference-only head to skip an untested implementation.

## Finish without a validation loop

Keep PR descriptions about the final behavior and relevant evidence. Batch metadata updates at
natural checkpoints instead of rewriting the body on every status poll. Prefer a shared backlog
snapshot for coordination; use live state for decisions.

Watch the authoritative current-head runs. Cancel only a proven obsolete or duplicate run owned
by this campaign, preserving the required validation run. Do not cancel unrelated work, copy a
success status or alter CI policy to obtain a green badge.

Mark ready only within existing authorization, after the fix, required and user-requested current-head gates,
independent findings and applicable visual/reference review are complete. Recheck live head and
state immediately before the mutation and verify its result. Observe any required follow-up runs
the readiness event launches without creating additional reruns yourself.

A green aggregate on a reference-only follow-up does not replace required source coverage that its
parent never completed. Establish that coverage before readiness; the optimization is not evidence.

At completion, report required CI separately from optional/advisory results, plus any unverified
behavior. Respect external merges; readiness is not merge authorization. Preserve reports and
evidence, release only campaign-owned temporary protections, and leave unrelated files, branches
and worktrees alone.
