# Stacked pull requests

Status: **Proposed**. Written 2026-10-11 against `main` at `685cb52`. Nothing here is
implemented yet.

GitHub now treats a chain of dependent pull requests as a first-class **stack**. This plan
adds stacks to the PR panel first, and to agent tools after that. It records the decisions
already made, the GitHub contract they rely on, the questions still open, and the delivery
order as small PRs, in the style of [PR panel: GitHub parity](pr-panel-github-parity.md).

## Decisions

These were agreed while reviewing a clickable prototype of the panel.

1. **The panel uses GitHub's API, not the `gh stack` extension.** Reading, linking, merging
   and unstacking all go through REST and GraphQL calls that both GitHub backends can
   already make (`gh api` in the CLI backend, `rest()` / `graphql()` in the token backend).
   Users do not need to install anything. The extension is only for local branch work
   (rebase, sync, submit), which belongs to the agent phase.
2. **The PR panel comes first; agent tools come later.** Agent tools reuse the same backend
   methods and approval path, so they are cheap once the panel work exists.
3. **The list shows one row per stack.** By default, a stack appears as a single row: its
   highest PR that is still open (not merged, not closed). If every PR in the stack is
   merged or closed, the row is the top PR. The row carries a small stack icon and nothing
   else; there is no "N hidden" note.
4. **A header toggle shows every PR in a stack.** It is off by default. When on, stacked PRs
   appear top first, with the lower PRs indented under the top one.
5. **The filter searches every PR.** Typing a number, title or branch finds a lower stacked
   PR even while its stack is collapsed.
6. **The stack row stays selected** while the detail view shows any PR in that stack.
7. **The detail view shows a stack map** above the description: each PR's position, state,
   review and CI result, a trunk row, and a footer saying what would merge with the selected
   PR and why it cannot merge yet, if it cannot.
8. **Moving between PRs in a stack never shifts the layout.** Every header row keeps a fixed
   height: the chip row is always present (Merged / Draft / Approved / Review required), the
   action row stays on one line, branch refs end in an ellipsis instead of wrapping, and the
   title has a fixed one-line height (two lines in a narrow pane) with the full text on hover.
   The "can't merge yet" reason lives in the stack map footer, not under the buttons.
9. **Auto-merge is not offered for stacked PRs.** GitHub does not support it yet. The menu
   shows it as unavailable with that reason, instead of offering an action that would fail.
10. **Merging a mid-stack PR merges everything below it.** The button says how many PRs will
    merge ("Merge 2 PRs"). A confirmation lists them, offers the merge method, and says the
    merge is all or nothing.

## GitHub contract

Source: the docs shipped in [`github/gh-stack`](https://github.com/github/gh-stack) at
v0.2.1 (commit `29a36d3`, 2026-10-09), under `docs/src/content/docs/reference/`. Check
GitHub's own pages before relying on anything here that later work depends on; see
[Open questions](#open-questions).

### What a stack is

- Two to 100 open PRs in the **same repository**. The bottom PR targets the stack's base
  (trunk); each PR above targets the head branch of the PR below. Stacks across forks are
  not supported.
- Every PR is held to the rules of the stack's base: required reviews, required checks,
  CODEOWNERS and a linear history between branches.
- Merging a PR merges every unmerged PR below it. A PR cannot merge while one below it stays
  open. After a partial merge, GitHub rebases the remaining branches so the next PR targets
  the base.
- No auto-merge and no rule bypass yet, for direct merges or the merge queue.
- GitHub Enterprise Server is not supported yet.

### Reading

- **REST:** every pull request object carries `stack` (`id`, `number`, `size`, `position`,
  `base.ref`, `base.sha`), or `null` when the PR is not in a stack. `position` is 1-based
  from the bottom.
- **Stacks API:** `GET /repos/{o}/{r}/stacks` lists stacks, newest first, paginated (max
  100 per page). `?pull_request=N` returns the stack containing PR N.
  `GET /repos/{o}/{r}/stacks/{number}` reads one. Each stack has `number`, `base.ref`,
  `open`, and `pull_requests` from bottom to top, each with `number`, `state`, `draft`,
  `merged_at`, `head.ref` and `head.sha`. **These endpoints return 404 when stacks are not
  enabled for the repository.**
- **GraphQL (read-only):** `PullRequest.stack` (`number`, `size`, `baseRefName`, paginated
  `entries`) and `PullRequest.stackEntry` (`position`). There are no stack mutations.
- **Webhooks:** `pull_request` events carry the same `stack` object.

### Writing

- **Create:** `POST /repos/{o}/{r}/stacks` with `{"pull_requests": [bottom, …, top]}`.
  Each PR's base must equal the head of the PR before it. Returns 201.
- **Add:** `POST /repos/{o}/{r}/stacks/{number}/add` appends PRs to the top. The first new
  PR's base must equal the current top's head.
- **Unstack:** `POST /repos/{o}/{r}/stacks/{number}/unstack` removes the unmerged PRs. It
  returns 200 with what is left (merged or queued PRs stay), or 204 when the stack is
  dissolved.
- **Merge:** the old synchronous merge endpoints and the `mergePullRequest` mutation refuse
  stacked PRs. Use the async merge API:
  - `PUT /repos/{o}/{r}/pulls/{n}/merge-async` with optional `merge_method`
    (`merge` / `squash` / `rebase`), `merge_action` (`default` / `direct_merge` /
    `merge_queue`), `commit_title`, `commit_message` and `sha` (the head SHA the PR must
    still have). The method and commit fields are not allowed with `merge_queue`.
  - The response is `202 pending` with a `uuid`; `200 merged` if already merged;
    `409 pending` with the existing `uuid` if a merge is already running (its options may
    differ); `400 failed` if closed or a draft; `404` if async merge is unavailable;
    `422` for an invalid body.
  - Poll `GET /repos/{o}/{r}/pulls/{n}/merge-async/{uuid}` (GitHub suggests once a
    second) until the status is `merged`, `enqueued` or `failed`. Results are kept for 24
    hours. `enqueued` is final for the request; the merge queue decides the rest.
  - Only open and not-draft are checked on submit. Rules are checked when the merge runs, and
    a rule failure comes back as `failed`. A stack merge is atomic: all of it lands or is
    queued, or none of it does.

### The `gh stack` extension

Installed with `gh extension install github/gh-stack` (needs `gh` 2.0+ and Git 2.36+). Stack
metadata lives in `.git/gh-stack`, shared by all linked worktrees. Non-interactive use:
`view --json`, `submit --auto`, `merge --yes --squash`, `link <prs…>`, `--print-path`, and
`GH_STACK_NO_UPDATE_NOTIFIER=1`. Exit codes run 0–8, with separate codes for rebase
conflicts, API failures and a locked stack. `rebase` and `sync` update every clean worktree
that owns a branch in the stack, stop on a dirty or busy one, and never stash. `modify` is an
interactive terminal UI and is not usable from Copse. The extension also ships an agent skill
(`gh skill install github/gh-stack`).

## What Copse has today

- **Backends:** `GitHubBackend` in `src/main/services/github/backend/backend.ts`, with
  `gh-cli-backend.ts`, `github-api-backend.ts` and `mock-backend.ts`, wrapped by
  `github-read-cache.ts`. Every write invalidates the read cache.
- **Lists:** the CLI backend lists PRs with `gh search prs --json …` and `gh pr list`, which
  have no stack field. The token backend uses `WORKSPACE_OPEN_PRS_QUERY` and
  `MY_OPEN_PRS_QUERY` in `github-graphql-prs.ts`. List items (`GhPrSummary`) carry
  `headRefName` but not the base.
- **Details:** `gh pr view --json` plus a GraphQL activity query in the CLI backend; GraphQL
  in the token backend. `GhPrDetails` has `baseRefName`, `mergeable`, `mergeStateStatus`,
  `isDraft` and `autoMergeEnabled`. There is no merge-queue state.
- **Writes:** `createPr`, `rerunFailedRuns`, `approvePr`, `markPrReady` and `enableAutoMerge`.
  `enableAutoMerge` (`gh pr merge --auto`, or the `enablePullRequestAutoMerge` mutation) is
  the template for new actions. Its path is `pr-pane.ts` → preload → `gh:enable-auto-merge`
  in `register-handlers.ts` → `gh-pr-actions-service.ts` → each backend. The results use
  `PrActionResult` in `src/shared/types/git.ts`.
- **No plain merge action exists.** The panel offers Approve, Rerun CI, Mark ready and
  Enable auto-merge only.
- **Nothing knows about stacks**, `gh` extensions or merge queues.
- **PR creation:** `pr-create-service.ts` targets the default branch unless `base` is
  passed, so the `gh_pr_create` tool can already open a PR against another PR's branch.
- **Thread worktrees** already accept a `baseBranch` (`worktree-manager.ts`). Only the
  default branch is fetched first; any other base resolves to the local branch.
- **Agent tools:** `gh-pr-action-tools.ts`, gated by `GITHUB_WRITE_TOOLS` and its prompt
  titles in `permission-policy.ts`. Raw `gh stack …` from `run_shell` is unclassified by
  `packages/shell-guard/src/gh-argv.ts`, so it always prompts.
- **The live polling path** is `github-list-watch.ts`, every 30 seconds.

## Open questions

Resolve these before or during the PR that first depends on them.

1. **Is the contract above what github.com serves today?** These docs could not be read from
   GitHub's own site while writing this plan. Before PR 1, run each call once against a
   scratch repository through both backends: list stacks, read `stack` / `stackEntry` via
   `gh api graphql`, create a stack, merge with merge-async, and unstack. Record the results
   here.
2. **Are stacks on for every repository, or does an owner turn them on?** The 404 rule covers
   both cases, but the empty state and any "turn on stacks" hint depend on the answer.
3. **Which token permissions do the Stacks API and merge-async need?** Check classic scopes
   and fine-grained permissions (`pull_requests: write`, `contents: write`). Copse should
   explain a 403 rather than show a raw error.
4. **Where does the list get stack membership?** Proposed: one `GET /stacks` per repository
   in the list, through the ETag cache in `github-http-cache.ts`, refreshed with the list
   watch. It works for both backends, gives the whole membership map in one call, and its 404
   doubles as the "stacks not enabled" check. The alternative is adding `stack` to each
   list query, which the CLI backend's `gh search prs` cannot do.
5. **How does a merge survive leaving the PR or restarting the app?** Proposed: polling runs
   in the main process, keyed by repository and PR. The `uuid` is held in memory and in the
   PR read cache. A restart within 24 hours resumes polling. A 409 adopts the running
   request instead of failing.
6. **How is merge-queue state shown?** After `enqueued`, the panel needs
   `mergeQueueEntry` (position, state) on the PR details, which today's query does not read.
7. **What does Copse do with local branches GitHub has rebased?** After a partial merge or
   the "Rebase stack" button on GitHub, the remaining branches are force-pushed. A thread
   whose worktree holds one of them is then out of date with the remote. Copse needs a rule:
   detect it from the list watch and offer a sync when the worktree is clean, or leave it to
   `gh stack sync`. Today's handling of a force-pushed branch has not been checked.
8. **How does a user build a stack from Copse threads?** This is the largest design question
   and has its own PR below. The pieces mostly exist: a thread worktree can start from
   another branch, and PR creation accepts a base. Missing are the user-facing entry point
   ("Start a thread on top of this PR"), fetching a non-default base before branching, and
   adding the new PR to the stack once it exists.
9. **Should the related-PRs section collapse stacks?** Proposed: no. A thread that produced a
   mid-stack PR should show that exact PR. Collapse only the repository and "other open
   PRs" sections.

## Delivery order

Each PR is independently reviewable and carries its own focused validation. Visible changes
need a focused WebdriverIO spec with a screenshot, per `AGENTS.md`.

### PR 0 — API spike and plan update (no product code)

- Answer open questions 1–3 against a scratch repository, through both backends.
- Record request and response shapes, the 404/403 behavior, and any differences from the
  docs above in this file.

### PR 1 — Read stack membership

- Add `stack: { number, size, position, baseRefName } | null` to `GhPrDetails`, and an
  optional stack membership to `GhPrSummary`, with zod decoders for each source.
- Add `listStacks(owner, repo)` to `GitHubBackend` (CLI: `gh api`; token: `rest()`; mock:
  fixture state). Treat 404 as "stacks not enabled" and cache that per repository.
- Read `stack` / `stackEntry` and the stack's entries in the details query.
- Mock backend: a three-PR stack fixture plus a repository without stacks, behind the
  existing `COPSE_PANEL_MOCK_GH` switches.
- Tests: decoders, the 404 path, cache invalidation, and both backends' wiring. No UI change.

### PR 2 — Show stacks in the PR panel

- List: one row per stack (decision 3), the stack icon, the header toggle (decision 4), the
  filter over every PR (decision 5), and the selected stack row (decision 6). Keep the
  related-PRs section uncollapsed (open question 9).
- Detail: the stack line, the stack map and its footer (decision 7), the fixed-height header
  (decision 8), and auto-merge shown as unavailable for stacked PRs (decision 9).
- Repositories without stacks look exactly as they do today.
- Visual evidence: a focused spec for the collapsed list, the expanded list, a filtered
  lower PR, and the header holding its position while you click through the stack map.

### PR 3 — Merge a stack

- Add `mergeStack(ref, { method, sha })` to the backends: submit with merge-async, then poll
  in the main process (open question 5). Add a new IPC channel validated like the existing
  PR writes, and a `PrActionResult` that can say pending, merged, enqueued or failed.
- Pass the head SHA the user saw, so a push made after the confirmation is rejected.
- Panel: "Merge N PRs" with the blocked reason in the stack map footer; a confirmation that
  lists the PRs and the merge method; a pending state that survives navigation; and success,
  enqueued and failure banners. A failure says nothing was merged.
- Show merge-queue state after `enqueued` (open question 6).
- Tests: every response code above, 409 adoption, polling stopped on success or expiry, a
  changed head SHA, and mock fixtures for success, failure and the queue.

### PR 4 — Link and unstack

- Detect open, unstacked PRs in the same repository whose branches already chain, and offer
  "Link as stack". Validate the chain locally before calling `POST /stacks`.
- "Add to stack" when a PR's base is the head of a stack's top PR.
- "Unstack" in the overflow menu, with the 200 / 204 outcomes.
- Tests: chain detection (gaps, forks, closed PRs, cycles), and rejected chains surfaced as
  GitHub's message.

### PR 5 — Build stacks from threads

- Design first, in this file (open question 8): the entry point, fetching a non-default base
  before branching, and joining the stack when the thread opens its PR.
- Decide how Copse keeps rebased branches current (open question 7), whether with Git
  directly or through `gh stack` when it is installed.

### PR 6 — Agent tools

- `gh_stack_link`, `gh_stack_merge` and `gh_stack_unstack` in `gh-pr-action-tools.ts`, on
  the same backend methods. Add them to `GITHUB_WRITE_TOOLS` with prompt titles that name
  every PR that will merge.
- Optionally detect the `gh stack` extension (`gh extension list`) and classify
  `gh stack view` as a read in `gh-argv.ts`. Any local `gh stack` write waits on PR 5's
  worktree rules.
- Read [hooks and feature packs](hooks-and-feature-packs.md) first if this touches agent
  hooks or loop control.

## Risks

- **A merge lands more than the user expects.** Mitigation: the button and the confirmation
  name every PR that will merge, and the request pins the head SHA.
- **The existing auto-merge action fails on stacked PRs.** PR 2 must ship the
  "unavailable" state before any stack is likely to be seen in the panel.
- **Polling costs rate limit.** One request per second during a merge, for one PR at a
  time; stop on any terminal status, on 404 (expired), and when the app quits.
- **The API is new and may change.** Keep every GitHub response behind a zod decoder, and
  treat an unknown status as an error the user can retry, never as success.
