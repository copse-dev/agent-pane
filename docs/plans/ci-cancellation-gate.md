# CI cancellation gate — #2520

Task baseline: `main` at `0a7a0967002da98b6055dc9f87544e91c8ad501b`,
20 September 2026. Owner: [#2520](https://github.com/copse-dev/agent-pane/issues/2520).
This is the cancellation slice of SDLC roadmap R11. Base-retarget triggers,
current-base enforcement, and independent acceptance are separate work.

## Problem and acceptance

`CI Passed` must never accept a run whose required work was canceled, including
supersession by another run. Cancellation must also release the workflow's
concurrency slot without waiting for unavailable self-hosted capacity.

The old gate uses `!cancelled()` at job level and explicitly returns success for
some canceled dependencies when it finds a newer tip/run. GitHub documents
[skipped checks as satisfying required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).
Whether a particular cancellation reports `skipped` or `cancelled` must be
observed, not inferred from workflow text. The originally reported PR #1723 is
closed **unmerged**; it is not evidence of an actual bypass merge.

Acceptance cases:

- Cancel while upstream work is queued for an unavailable worker.
- Cancel while upstream work is running.
- Supersede a dependency or a whole run; old work cannot authorize the new run.
- Successful work and intentional heavy-tier skips still pass.
- Fork and trunk-push contexts remain distinct from `CI Passed`.

## Implementation contract

The aggregate remains named `CI Passed`, `Fork CI Passed`, or `Develop CI Passed`
under the existing rules. No production branch rules change.

- Run the aggregate with `always()` on **fixed GitHub-hosted capacity**, never
  `SELF_HOSTED_CHECKS`. The old #1669 stall was an always-running gate queued
  behind the self-hosted fleet.
- Keep it to shell built-ins, with no checkout, install, network call, or token
  permissions and a five-minute execution cap. Hosted queue time is not bounded
  by that cap; a GitHub-wide runner outage remains outside this change.
- Use a separate conditional step for whole-run cancellation. Status functions
  such as `cancelled()` are not supported in step environment expressions.
- Reject every canceled dependency before fork or skip-mode acceptance. A newer
  tip/run explains cancellation but supplies no evidence for the canceled run.
- Require successful precheck and the same-repository unit job; reject missing
  plans and preserve the existing PR e2e dispatch contract.
- Let screenshot collection stop on cancellation. It must not keep a superseded
  run queued behind the fleet while the hosted aggregate waits on it.

This follows GitHub's [cancellation behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation)
and uses `always()` only for the bounded, dependency-free final decision.

## Validation evidence

The shell decision tests execute the actual workflow scripts. Structural tests
pin context names, result bindings, hosted routing, zero token permissions, and
the cancellation conditions. Full pre-commit validation is recorded in the PR.

Real Actions probes use the isolated branch
`codex/ci-cancellation-probe-20260920` and a same-commit `-superseder` branch.
Their trees contain only synthetic workflow fixtures and a README; no application
source or stored credentials. The legacy gate uses a read-only Actions token for
its original API lookups; the proposed gate has no token permissions. No merge is attempted
and no required-check rule is modified. The proposed decision script is copied
from this implementation; fixture job results replace the production needs.

| Case                                           | Evidence                                                                            | Result                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unavailable worker, manual cancel              | [Run 35526988401](https://github.com/copse-dev/agent-pane/actions/runs/35526988401) | Worker canceled; legacy check canceled; proposed check failed on canceled dependency. Hosted gate finished four seconds after worker cancellation. This case does not reproduce a skipped-check bypass.                                     |
| Running worker, manual cancel                  | [Run 35527125699](https://github.com/copse-dev/agent-pane/actions/runs/35527125699) | Legacy check canceled; proposed check failed. Hosted gate finished five seconds after the worker canceled.                                                                                                                                  |
| Whole-run supersession                         | [Run 35527210198](https://github.com/copse-dev/agent-pane/actions/runs/35527210198) | Legacy check canceled; proposed check failed. The canceled run finished and the replacement dispatched; no fleet queue stall.                                                                                                               |
| Dependency-only supersession, identical commit | [Run 35527247950](https://github.com/copse-dev/agent-pane/actions/runs/35527247950) | **Legacy check succeeded with its precheck canceled; proposed check failed.** Both used commit `4d27ebb28cab88ae2183758d6792d44fd7773514`. The legacy gate was green at 17:53:55 UTC, before the competing worker finished at 17:54:06 UTC. |
| Replacement completes its own work             | [Run 35527303185](https://github.com/copse-dev/agent-pane/actions/runs/35527303185) | Precheck and both gates succeeded; the proposed gate was green only after the worker finished.                                                                                                                                              |

The initial fixture failed workflow validation because it placed `cancelled()`
in an environment expression. That failure happened before dispatch, led to the
conditional-step design, and is not counted as a cancellation probe result.
Both temporary branches were deleted and the probe workflow was disabled after
the probes completed; the run links retain their evidence.

For the dependency-only case, two branches pointing at the identical synthetic
commit run concurrently. Their worker jobs share a separate concurrency group;
starting the second cancels only the first worker, leaving its aggregate runnable.
The legacy script is copied from the audited main revision, with its workflow
lookup path changed from `ci.yml` to the probe workflow's filename. It sees a newer
run on the same SHA and returns success. The candidate scripts and step conditions
are identical to the implementation; only fixture needs and context names differ.

This proves the premature-success path at the check-conclusion level. The live
main rule requires `CI Passed` from GitHub Actions (integration 15368); no actual
merge or branch-protection bypass was attempted. The manual-cancel probes did not
produce the historical `skipped` conclusion, so they are not claimed as reproduction
of that specific behavior. They verify the candidate's blocking outcome and liveness.

Fork/trunk naming, draft and screenshot/zero-shard policy are covered by local
workflow/decision tests. Retarget-only events, base freshness, independent review,
and behavior during a GitHub-wide hosted-runner outage remain outside this slice.
