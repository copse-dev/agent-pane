# Approval runtime coverage — #1680

Baseline: `main` at `74a8a61c4b5571fab0e7e83d94cf6c0829e7e4a0`, 20 September 2026.
Tracking: [#1680](https://github.com/copse-dev/agent-pane/issues/1680), SDLC roadmap R12.

## Acceptance and scope

- GitHub write approval, agent-task shell approval, and Guarded YOLO execute in CI.
- Shell approval is observed and answered even on a host with an active OS sandbox.
- Guarded YOLO still asks for bounded destructive work and hard-denies catastrophic deletion.
- Focused Electron runs save visual evidence and exercise real main/renderer IPC with mock model/GitHub services.
- Validate the default Linux CI environment as well as macOS before accepting reinstatement.

This work changes runtime tests, not permission policy. Do not raise transport timeouts or
infer an Electron crash from `invalid session id` alone. A historical 6 GiB runner failure
needs separate evidence; healthy runs on today's host cannot establish its original cause.

## Fresh baseline

The original issue and later comments contain competing missing-dialog and memory-pressure
hypotheses. Historical failures were on August runners; current main defaults to hosted Linux
and has subsequent approval-routing and test-harness changes.
GitHub reports the failure artifacts from run `31422696788` expired on 13 August; they are
unavailable for a retrospective crash diagnosis.

On macOS with Node 26.7.0 and Electron Chromium 152.0.7977.65:

- `agent-tasks-terminal`: both tests passed.
- `guarded-yolo`: all three tests passed, including bounded confirmation and catastrophic denial.
- `github-write-approval`: the mark-ready test passed; PR creation reached the dialog but failed
  a stale copy assertion. The product now explains that it pushes the current branch before
  creating the PR. This is an assertion failure, not a dead session.

No original session-death failure was reproduced in these baseline runs.

## Proposed changes

Remove the three CI quarantine wrappers, reconcile the PR-creation copy assertion with the
shipped behavior, and wait for rejected GitHub turns to settle before proceeding. Seed the
existing `autoRunSandboxCommands: false` setting in the terminal test and require its approval
dialog; the previous optional prompt check could pass without exercising approval at all.

## Validation and remaining evidence

- Build passed on the baseline above.
- The three reinstated suites plus `tool-activity-icon` passed together under `wdio.ci.conf.ts`
  on macOS: four files, eight tests, no skips. The terminal suite passed again after adding
  its required-prompt screenshot.
- Visual inspection confirms the shell prompt names the command and explains why approval is
  required; GitHub creation copy discloses the push; Guarded YOLO shows explicit opt-in,
  bounded confirmation, and the catastrophic denial reason. New reference evidence:
  [shell approval](../../tests/e2e/screenshots/agent-tasks-shell-approval.png) and
  [GitHub creation](../../tests/e2e/screenshots/github-write-approval-create-dialog.png).
- The oracle selects the three changed runtime suites (`mode=subset`) and the full unit tier.
- `pnpm run check` passed: all static checks and 9,396 unit tests, zero failures or skips.
- Linux PR CI remains pending; its immutable results will be recorded on the PR and #1680.

Keep #1680 open until review, merge, and a full production CI run establish reinstatement;
do not claim this PR diagnoses the old runner's memory pressure. If foundations PR #2720 lands
first, remove these three suites' obsolete entries from `tests/e2e/exclusions.json` during rebase.
The exclusion drift check should reject stale records, not be bypassed.
