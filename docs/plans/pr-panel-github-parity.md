# PR panel: GitHub parity in small PRs

Audited 2026-09-09; implementation rebased onto current main before opening the PR. Start with visibility into feedback and CI; add writes as separate,
reviewable changes. This is a sequence of proposed PRs, not opened GitHub PRs.

## Current coverage and gaps

| Area                 | Existing Copse behavior                                                         | Gap                                                                                   |
| -------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| PR discovery         | Chat links, workspace open PRs, lazy cross-repo authored PRs, refresh, CI dots  | Search, filters, closed/merged history, review-requested queue, pagination            |
| Overview             | Markdown description, branches, change totals, draft/approved/auto-merge badges | Full lifecycle and review status, reviewers, labels, merge blockers                   |
| Conversation         | Description only before PR 1                                                    | Comments, reviews, inline discussions, replies, history                               |
| Checks               | Overall dot and rerun-failed action                                             | Named results, head SHA, logs, annotations, freshness, required checks                |
| Files changed        | Collapsible file list and Monaco diff                                           | Inline threads, viewed state, filtering, complete file pagination                     |
| Commits              | No section                                                                      | Commit list, authors, dates, per-commit diff                                          |
| Review/merge actions | Approve, mark ready, enable auto-merge                                          | Request changes, review body, reviewer requests, merge readiness and method selection |

## Delivery order

Each item should be independently reviewable and include focused validation. PR 1 is the
implementation in this worktree; the remaining items are planned. Avoid bundling all of them
into one feature branch.

### PR 1 — Read comments and check results (implemented)

- Add Overview / Comments / Checks navigation while keeping the existing file viewer in Overview.
- Read conversation comments and submitted reviews, ordered by timestamp, with author, rendered
  Markdown, and review outcome. Keep one PR-level Open on GitHub action instead of repeating it
  on every comment. This does not yet include inline code discussions.
- Show individual head-commit check runs **and legacy status contexts**, with explicit state and
  detail links. Keep failed results visible alongside running jobs; cancelled/unknown are not green.
- Share one GraphQL query/parser between CLI and token backends. Use the existing details IPC;
  no new write permission or action is introduced.
- Bound initial results to the latest 50 comments, latest 50 reviews, and first 100 checks.
  Label truncation and link to GitHub; label unavailable data instead of claiming it is empty.
- Keep manual refresh and the existing rerun action. Guard out-of-order detail responses.
- Validate parser, renderer, backend wiring, existing PR navigation/diff, and focused Electron
  screenshots: `pr-activity-overview.png`, `pr-activity-comments.png`, `pr-activity-checks.png`.

### PR 2 — Write conversation comments

- Add a Markdown composer with preview, explicit Post comment, pending state, and errors.
- Persist drafts by repository/PR; preserve text on error, refresh, navigation, and retry.
- Implement one comment mutation across CLI/API/mock, with main-frame IPC validation.
- Reconcile the returned comment ID; do not automatically repeat a mutation after an uncertain
  response. Keep edit/delete/reactions outside this PR.
- Test successful post, denied permission, network failure, duplicate-click prevention, and draft recovery.
- Depends on PR 1.

### PR 3 — Paginated inline review discussions

- Load review threads with path/line, replies, outdated/resolved markers, and explicit Load more.
- Show them in Comments; link to the matching file diff when the current line is available.
- Paginate conversation comments/reviews too, preserving order and deduplicating by ID.
- Read-only first: no reply or resolve actions yet.
- Test deleted authors/files, outdated lines, multiple pages, and switching PRs during loading.
- Depends on PR 1.

### PR 4 — Reply to and resolve review threads

- Add reply and resolve/unresolve actions with permission-aware controls and per-thread pending state.
- Retain drafts on failure and reconcile responses by thread/comment ID.
- Test unavailable permissions, stale threads, failed writes, and reply ordering.
- Depends on PR 3; reuse PR 2's draft and mutation behavior.

### PR 5 — CI refresh and run controls

- Refresh the visible Checks section while work is pending; stop polling when hidden/disposed.
- Pin reads and reruns to the head SHA, not only the branch name. Current rerun backends query by
  branch, which needs fixing before offering more granular run controls.
- Add check pagination, last-updated/retry state, and selected-run rerun; show logs/annotations
  through detail links initially. Keep required-check/merge-rule interpretation for PR 7.
- Fix list rollup gaps: fetch errors currently become `no_checks`, pending results can hide failures,
  and stale responses can affect cached list indicators. Guard stale CI cache responses on workspace changes.
- Test push-during-refresh, same-name runs on different commits, cancellation, legacy providers,
  rate limits, and partial failures.
- Depends on PR 1.

### PR 6 — Commits section

- Add a paginated commit list with subject, author, timestamp, short SHA, and GitHub link.
- Ship list navigation first; per-commit Monaco comparison can be a follow-up PR.
- Test force-push refresh, deleted authors, long subjects, and empty/unavailable states.
- Depends on PR 1 navigation.

### PR 7 — Merge readiness and reviewers

- Surface open/closed/merged, changes requested/review required, conflicts, required checks,
  unresolved conversations, and requested reviewers. Distinguish unknown from mergeable.
- Respect repository rules and viewer permissions. Show reasons the existing approve/ready/
  auto-merge actions cannot run. Do not infer readiness from green CI alone.
- Read-only readiness first; direct merge, merge-method selection, reviewer requests, and
  metadata editing each merit a separate follow-up.
- Test draft, self-review, stale approval, conflicts, pending rule evaluation, and restricted repos.
- Depends on PRs 1 and 5.

### PR 8 — Files and PR discovery polish (split into two independent PRs)

- **8a Files:** complete file pagination, filter by path/status, viewed state, per-file change totals.
  Test >100 files, renames/deletions, and reviewed-state invalidation after a push.
- **8b Discovery:** search plus open/closed/merged and review-requested filters, explicit loading/
  error/empty states, Load more. Test cross-repo identity and out-of-order search results.
- These can follow PR 1 independently of the conversation write work.

## UI direction and verification

Keep the PR list stable on the left and switch the detail content on the right. Use one scrollable
body per activity view; wrap long names and metadata. Avoid stacking comments and CI above Monaco
where they would compete for height. Keep the action area available across sections.

Use unit/component tests for mappings, state, and actions; add a minimal WebdriverIO Electron eval
for each new visible state with deterministic mock data. Run `pnpm run check`, `pnpm run build`, and
the affected e2e specs. Before opening each PR, rebase onto `origin/main` per AGENTS.md.

The screenshots in PR 1 are actual Electron renders with mock GitHub content, not live PR data.

### PR 1 validation results

- Rebased onto `origin/main`, retaining upstream image diffs, list watching, and pop-out behavior.
- Build, typecheck, and full lint passed on Node 24.20 with pnpm 10.34.5.
- The focused parser/backend/component/mock/style suite passed: 55 tests.
- Electron passed `pr-panel-activity`, `pr-panel`, and `pr-panel-actions` using the standard
  harness on Electron 44.1. Screenshots were regenerated and visually inspected. The comment view
  has no per-comment GitHub action; the PR-level action remains available.
- Full-suite results and any environmental limitations are recorded in the PR description.

## GitHub references

- [PR sections and conversation](https://docs.github.com/en/pull-requests/reference/pull-requests)
- [Commenting on pull requests](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/commenting-on-a-pull-request)
- [Reviewing proposed changes](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/reviewing-proposed-changes-in-a-pull-request)
- [Check states and the Checks tab](https://docs.github.com/en/pull-requests/reference/status-checks)
