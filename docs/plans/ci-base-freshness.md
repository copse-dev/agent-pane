# CI base freshness — #2520

Task baseline: `main` at `883ff2e`, 22 September 2026. Owner:
[#2520](https://github.com/copse-dev/agent-pane/issues/2520). This is the
**base-advancement reporting** slice of Shipping quality roadmap R11. It
reports the condition; it is not the enforcement, and the enforcement choice
remains open (see _Why this cannot be the enforcement_). The cancellation
slice landed in [#2722](https://github.com/copse-dev/agent-pane/pull/2722); the
retarget-only trigger is [#2970](https://github.com/copse-dev/agent-pane/pull/2970).
Independent acceptance (R06) remains separate work.

## Problem and acceptance

`CI Passed` is a check run attached to a head SHA. GitHub tests
`refs/pull/N/merge` — the head merged into the base branch **as it stood when the
run was dispatched** — but branch protection reads only the check's name and
conclusion. Nothing in that record says which base was merged.

So after the base branch advances, an untouched pull request keeps a green
`CI Passed` describing a merge result that no longer exists. Merging it
authorizes a combination CI never executed. R11's done-when names this case
directly: "base advancement ... cannot authorize an untested candidate".

Two structural constraints shape the fix:

- **No merge queue.** GitHub's merge queue requires Enterprise Cloud for a
  private repository and this org is on Team (see ci.yml's `merge_group` note),
  so the `main` → `release` promotion flow stands in for one.
- **Re-running is unaffordable.** Re-dispatching CI for every open pull request
  on each push to `main` would multiply the day's load across an ephemeral
  self-hosted fleet that already serves both tiers.

A further constraint is timing, and it decides the shape: **the staleness appears
after a run has finished**, so no job inside that run can observe it. `ci-passed`
cannot be patched to cover this. The control has to be re-triggered by the base
moving, which only a separate `push` workflow sees.

Acceptance cases:

- A push to `main` or `release` re-evaluates every mergeable open pull request
  targeting it.
- A pull request that contains every commit on its base reports current.
- A pull request behind its base reports the exact deficit.
- A base retarget without a push re-evaluates, because the merge result changed.
- A comparison that cannot be established reports failure, never a quiet pass
  and never `neutral` or `skipped`.
- `CI Passed`, its fork/trunk siblings, and every production branch rule keep
  their current meaning.

## Implementation contract

A new check context, `Base Current`, published by
`.github/workflows/base-freshness.yml` from `scripts/base-freshness.mts`.

- **Advisory, and never a required check.** This reports; it does not
  authorize. The reason is structural, not a gap to be tightened later — see
  _Why this cannot be the enforcement_ below.
- **Additive.** Nothing renames or republishes `CI Passed`, so no existing rule
  or consumer changes meaning and no merge window that was closed can open.
- **Re-evaluate, never re-run.** One comparison and one check run per candidate.
  No checkout of candidate code, no build, no test, no fleet.
- **Fixed hosted capacity**, never `SELF_HOSTED_CHECKS`, and inside a timeout —
  the same rule `ci-passed` follows. A report on whether a candidate is current
  must not queue behind the fleet it reports on (#1669).
- **Dependency-free.** The script imports node builtins only — no `src/` import,
  no workspace package, no `node_modules`. A report a reviewer reads before
  merging must not be able to fail because a dependency restore did.
- **`behind_by`, not a local guess.** The verdict is GitHub's own count of
  commits on the base the head does not contain: the same measure
  "Require branches to be up to date before merging" uses.
- **Two conclusions only.** `neutral` and `skipped` both _satisfy_ a required
  status check, so the policy emits `success` or `failure` and nothing else.
  An unestablished comparison is `failure`: at merge time it is
  indistinguishable from a stale one.
- **Self-healing.** Every failure path is re-evaluated by the next push to the
  base and by the pull request's own next push, retarget or reopen, so a
  transient API failure cannot park a pull request.
- **Least privilege.** Top-level `permissions: {}`; the job takes
  `checks: write` and `pull-requests: read` and nothing else.
- **`pull_request_target` without candidate code.** The trigger is needed for
  the same two reasons as `review-trigger.yml`: it resolves the workflow from
  the default branch, and its token can write a check run where a fork's
  `pull_request` token cannot. As there, the workflow never checks out or
  executes pull request code; the check run's entire content is derived from
  GitHub's comparison API. A workflow invariant pins that the checkout carries
  no `ref:` and that no install or build step exists.

Cost control: drafts are skipped on the push fan-out (they cannot merge, and
`ready_for_review` re-evaluates them the moment they can), and the concurrency
group collapses a burst of merges into a single evaluation whose answer is the
current one.

## Why this cannot be the enforcement

An earlier revision of this plan proposed requiring `Base Current` once its
verdicts had been observed. Review of [#2974](https://github.com/copse-dev/agent-pane/pull/2974)
established that it must not be, and the reasoning belongs here because it is a
property of the mechanism rather than of this implementation.

The authorizing artifact would be a `success` check run already attached to a
head SHA. The only way to withdraw one is to successfully POST a newer check run
to that same head: check runs have no expiry, and there is no atomic bulk
invalidation. So any failure of the fan-out leaves earlier `success` results in
place on every head it did not reach —

- a single check-run POST failing,
- the pull request listing failing before one candidate is reached,
- the runner being lost or the run aborted,
- the workflow never dispatching at all.

Each of those leaves untouched pull requests carrying an authorizing `success`
across a base that has moved, which is exactly the case this was written to
expose. The run's own red is attached to the base commit, not to those heads, so
nothing on the candidate reflects it. Requiring the context would therefore
reintroduce stale authorization in a form that is harder to see than the one it
replaced.

Continuing past per-candidate failures (and reddening the run while naming the
candidates that were not refreshed) narrows the window to the candidates that
individually failed, and makes the incompleteness visible. It does not close it.
Revocation by push is best-effort by construction.

Sound enforcement of the same property already exists, needs no revocation
because GitHub evaluates it at merge time, and is a repository-settings
decision:

- **"Require branches to be up to date before merging"** — the branch-protection
  setting, using the same `behind_by` relation this reports on. The cost is
  throughput: on a busy `main` every candidate must refresh before it merges.
  Applying it to `release` only is the cheaper option, and a stale promotion is
  the expensive case.
- **A merge queue** — unavailable on this plan (Enterprise Cloud for a private
  repository; see ci.yml's `merge_group` note).

That choice is the remaining R11 base-advancement work. This workflow's job is
to make the condition visible while it is being made, and afterwards to explain
on the pull request what the rule is blocking on.

## Validation evidence

`scripts/base-freshness.test.ts` covers the policy, the decoders, the fan-out,
and the workflow's structural invariants — 24 tests. The policy tests assert the
two-conclusion property directly, because a `neutral` here would be a silent
regression to the behavior this control exists to remove.

Full local validation is recorded in the pull request.

## Not covered by this slice

- **Real Actions probes.** R11's bar is explicit that workflow-text assertions
  alone are insufficient and live GitHub behavior must be observed, as
  `ci-cancellation-gate.md` did for cancellation. The equivalent probes here —
  publishing `Base Current` on a disposable branch, advancing its base, and
  recording the check-run conclusions either side — need repository write
  access to dispatch and were not run for this change.
- **The enforcement decision.** Still open, and it is a repository-settings
  choice rather than workflow work — see below.
- **Fork pull requests.** They already have no `CI Passed` and must go through a
  same-repository branch, so `Base Current` adds nothing to that path.
- **Independent acceptance (R06).** Unchanged by this slice.
