# Unified change review

Design reference: [#4295](https://github.com/copse-dev/agent-pane/pull/4295).

## Combined surface

Local changes and pull requests share one **Review** destination in the titlebar and
portrait panel controls. The header's subject picker offers Local changes, related PRs,
workspace PRs, filtering, and the existing cross-repository PR list. Selecting a PR
closes the picker and gives its details the full review pane. Local review keeps
proposed, staged, unstaged and committed files, approvals, restore, and Copse Reviewer.
Below the default pane width (at 420px and narrower) the local file list stacks above
the diff; a default-width pane keeps the list beside it.

The existing `changes` and `prs` mode identities remain for navigation, retained
selection, pop-out seeds, shortcuts and saved layouts. They are subjects within the
same review surface, rather than separate titlebar destinations. Creating a PR while
reviewing local work follows to its GitHub subject through the existing creation event.
Subject switching retains the local selection and PR tab/file.

Local review makes no GitHub calls. Its picker lists PRs only when it opens, and that
listing never selects or loads a PR. Only the PR subject loads details, auto-selects a
related PR and runs the PR list watch, which stops when the subject changes back or
review closes. A PR picked from local review loads once, with no second refresh as the
subject switches to it.

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
