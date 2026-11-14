# Unified change review

Design reference: [#4295](https://github.com/copse-dev/agent-pane/pull/4295).
Implementation base: `51550f12046505bb4d11914030fc5475685f2a21`.

## Combined surface

Local changes and pull requests share one **Review** destination in the titlebar and
portrait panel controls. The header's subject picker offers Local changes, related PRs,
workspace PRs, filtering, and the existing cross-repository PR list. Selecting a PR
closes the picker and gives its details the full review pane. Local review keeps
proposed, staged, unstaged and committed files, approvals, restore, and Copse Reviewer.
At narrow pane widths the local file list stacks above the diff.

The existing `changes` and `prs` mode identities remain for navigation, retained
selection, pop-out seeds, shortcuts and saved layouts. They are subjects within the
same review surface, rather than separate titlebar destinations. Creating a PR while
reviewing local work follows to its GitHub subject through the existing creation event.
Subject switching retains the local selection and PR tab/file; entering review from
another destination still refreshes it. Closing review stops the shared PR list watch.

Acceptance coverage: `tests/demo/unified-review.demo.ts` exercises subject navigation,
retained approvals and PR sections, narrow layout, keyboard dismissal and signed-out
GitHub. Existing PR, Changes and pane tests now enter through the shared controls.
Captured local macOS images are evidence, not replacements for Linux CI baselines.

## Remaining prototype features

This combines the implemented review functionality. The prototype also illustrates
features that need their own data and action contracts:

- Commit and push/create-PR as stage-dependent primary actions.
- Inline local findings and GitHub discussions in a common thread model.
- Private agent asides on public comments, with explicit publication of GitHub replies.
- Additional conflict resolution choices and an editable manual merge surface.
- Commits, reviewers, merge readiness, direct merge methods and a responsive Status drawer.

GitHub discussion writes, pagination, commit history and merge readiness follow the
[GitHub parity plan](pr-panel-github-parity.md). Local findings, private asides and
additional edit/merge actions require separate follow-ups; this change does not claim
those prototype interactions are implemented or close the broader owning issue.

## Local validation

- `pnpm run build` — passed.
- `pnpm test -- pr-pane panel-mode-controls pr-panel-follow git-changes-pane` — 124 passed.
- `pnpm run test:demo --spec tests/demo/unified-review.demo.ts --spec tests/demo/pr-thread-relationships.demo.ts` — 6 passed; wide/narrow captures inspected.
- `pnpm run test:e2e -- --spec tests/e2e/pr-panel-activity.e2e.ts --spec tests/e2e/git-changes-review-button.e2e.ts` — 3 passed; captures inspected. Used the existing cached Electron runtime through `ELECTRON_OVERRIDE_DIST_PATH` because the checkout's relative runtime link is broken.
- All `check:local` stages completed successfully within `pnpm run check`. The duplicate unit run after that gate was stopped; the separately started complete unit suite supplies broad coverage.
- `pnpm test -- native-screenshot-outputs` — 8 passed after auditing the moved controls and retiring the separate PR-loading capture.

The complete unit run finished with 17,784 passing, 12 failing and 2 skipped tests.
Two failures were stale screenshot ownership and smoke-selector records corrected
here: ownership now passes 8/8, and the inventory assertion passes in its isolated
rerun. The runner also detected the implementation edits made during the broad run;
final focused unit, browser and native checks ran against the completed changes.
The full unit suite is not a clean gate on this host. Isolated failures include
macOS Bash 3.2 rejecting empty arrays in unchanged CI scripts, screenshot review
fixtures refusing the `/var` symlink, and small-gate empty-diff assertions observing
this working tree's uncommitted changes. The unchanged per-user-temp permission
audit test also reproduces in isolation (183 pass, one fails because the expected
decision-log event is absent); its cause remains outside this UI change. These are
not waived CI gates; use a clean
Linux checkout for the corresponding required checks. The prototype follow-ups
above remain outside this implementation.
