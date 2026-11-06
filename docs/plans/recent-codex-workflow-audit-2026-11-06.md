# Cross-project conversation and CI workflow audit

## Task brief

Test whether recent cross-project review and CI-follow-up workflows can be completed through
Copse's native tools. Reproduce gaps before changing behavior. Base:
`d57af855e16db5534ae1781317b9ea1e8cc16269`.

Acceptance examples:

- The latest matching conversation belongs to the last configured project: return it before
  older matches from earlier projects. Exclude the caller before taking a result page.
- Bound default discovery to 50 matches, allow up to 200, and keep older matches reachable through
  an offset. Permit narrowing to a configured project before applying pagination.
- Cancelled or unfamiliar CI checks cannot establish success. Preserve a pending signal even
  when some checks already passed.
- Implicit failure-log lookup for a known PR commit cannot substitute another commit's run.
- Preserve the existing cross-thread read/send consent and durable CI watch restart behavior.

Risk: read-tool result ordering and GitHub status classification. No new permission, persisted
format, DOM, layout, automatic retry or continuation budget. Validate the actual tool and service
boundaries with focused tests, the standard static/full check, build and existing runtime coverage.
Detailed chat evidence remains local; no private conversations are needed by the regression fixtures.

## Findings

`list_threads` already supports consented cross-project discovery and returns readable transcript
paths. It concatenated per-project catalogs, so global recency was wrong, and returned every match.
Sort the combined matches by update time with stable project/thread tie breakers, then page them.
The result stays an array with the existing spine paths. Pagination is over live data; concurrent
updates can move entries between requests, so this is not a frozen snapshot.

CI tools already support durable waits and restart recovery. However, cancelled and unknown check
buckets fell through to success. Keep unknown checks pending until they resolve or the existing
watch expires, and classify cancellation as a failed completion. Preserve pending-before-failure
precedence and existing skipped-check handling. This is conservative status classification, not a
full branch-protection model: historical cancelled duplicates and advisory checks may still need
inspection.

Implicit workflow selection also substituted the newest listed run when no run matched the PR
commit. Return no match instead; the failure-log caller already reports that no run was found.
Explicitly requested run IDs remain usable.

An additional exit-code hypothesis was rejected after live CLI reads and inspection of
[GitHub CLI's JSON export path](https://github.com/cli/cli/blob/trunk/pkg/cmd/pr/checks/checks.go).
JSON export precedes its non-JSON failure/pending exit handling. No speculative parser change is
included.

## Existing work and remaining gaps

- Paired-browser parity belongs to [#4095](https://github.com/copse-dev/agent-pane/pull/4095).
  Closing a desktop window is different from quitting or sleeping its host.
- Bounded native workers and persistent child orchestration belong to
  [#4096](https://github.com/copse-dev/agent-pane/pull/4096) and
  [#4072](https://github.com/copse-dev/agent-pane/pull/4072). An active PR does not establish that
  its validation is finished.
- Background consent/retry work belongs to
  [#4158](https://github.com/copse-dev/agent-pane/pull/4158) and
  [#4159](https://github.com/copse-dev/agent-pane/pull/4159).
- Copse's catalog searches its own store. Reviewing history that exists only in another app needs
  an explicit read-only import/connector with bounded retrieval and separate consent.
- Host storage administration and external account management still need their appropriate
  scopes and user authorization. Missing credentials cannot be repaired by weakening containment.

## Validation

Two conversation-discovery regressions fail with the original product code. Three CI regression
cases fail on the original service. Focused tool/service and durable-watch tests pass with the fixes
(29 tests). All static gates and the production build pass. The existing Electron thread-reference
spec passes on the rebuilt source; its screenshot was inspected and the sent reference remains
inline and readable.

The full local check completed: 17,060 passed, 11 failed, one skipped. Eight failures reproduce on
unchanged main with the same dependencies: one Bash 3.2 CI-protocol fixture, six screenshot-review
fixtures rejecting macOS's `/var` alias, and one per-user-temp permission audit assertion. Two
CI-planning cases pass on clean main but fail in the uncommitted checkout; verify them again on the
committed patch. One filesystem-watcher timeout passes in isolated runs on both main and the patch.
This is not a green full-suite result. Keep publication draft until required final-head CI passes;
record its immutable links and the committed-checkout rerun in the PR.

No live model inference, physical-phone validation, daemon deployment or successful full-night run
is established by these deterministic tests.
