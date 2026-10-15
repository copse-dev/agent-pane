# Backlog snapshot

`pnpm run backlog:snapshot` prints one bounded, read-only view of the open pull requests so an
agent or maintainer can pick up work without polling every PR. It groups the backlog into ready
work, failing checks, missing visual decisions, substantive acceptance holds, superseded originals,
and in-progress work, lists screenshot-stack membership, and links recovery batches to the originals
they carry. It writes `.tmp/backlog-snapshot/snapshot.json` (the shareable record) and
`snapshot.md` (the rendering), and prints the Markdown.

It is a **snapshot, not a source of truth**. Every row is what GitHub reported at the moment it was
observed. Recheck the live PR before acting on it, and never treat a "ready" row as an approval: it
only means the signals the script reads were all green at that time.

## When to run it

- At the start of a batch or handoff, to choose an owner's next PR and to fill the batch record in
  [the recovery throughput plan](plans/recovery-throughput.md#4-make-ownership-and-handoff-cheap).
- When a session ends, so the next agent inherits one snapshot instead of a transcript. Paste the
  rendering or commit the JSON somewhere the next agent can reach; a temporary directory on another
  machine is not a handoff.
- Instead of each agent asking GitHub about every PR. One snapshot per batch is the intended rate.

## Requirements and cost

It needs `gh` authenticated for the repository and uses only `gh api --method GET` requests, so it
cannot add labels, comments, statuses or branches. The first run reads the open and recently closed
PR lists, one page of recent repository comments, and five endpoints per open PR (details,
check runs, combined status, head commit, reviews); about 150 reads for 30 PRs. Later runs reuse
the previous `snapshot.json` for every PR whose head, base and `updated_at` are unchanged and whose
signals had settled, so a refresh is typically a dozen reads. Reused rows show their original
observation time in the rendering.

Options:

| Flag                        | Effect                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `--since <ISO or 6h or 2d>` | Refresh only PRs updated after this time; everything else comes from the cache, settled or not.     |
| `--no-cache`                | Ignore the previous snapshot and read everything again (use after the script's rules change).       |
| `--cache <file>`            | Read a different previous snapshot (default: the JSON this run will overwrite).                     |
| `--out <dir>`               | Write outputs elsewhere than `.tmp/backlog-snapshot`.                                               |
| `--repo <owner/repo>`       | Another repository (default `copse-dev/agent-pane`).                                                |
| `--comment-days <n>`        | How far back to scan repository comments and merged batches for supersession and hold wording (14). |
| `--limit <n>`               | Maximum open PRs to include; the rendering says when the list was truncated (200).                  |
| `--quiet`                   | Write the files without printing the Markdown.                                                      |

Mergeability can change when the base branch moves without the PR's `updated_at` changing, so a
reused row's "conflicts" or "ready" signal can be older than the base. `--no-cache` refreshes it.

## How each group is decided

The rendering ends with the same list, so a reader of the shared snapshot sees it too.

- **Failing checks**: the `CI Passed` check run on the head SHA has a failure, cancelled, timed-out
  or action-required conclusion, or any other completed check run on that SHA does (cancelled jobs
  count only inside the newest CI run), or the `CLA` or `Screenshot review` status is in error.
  Because the script reads the head SHA, every failure it names is on the current head; when the
  head has no CI yet, the previous head's result from the cache is shown as context only.
- **Missing visual decision**: the `Screenshot review` status is pending, or the
  `screenshots-need-review` label is set.
- **Substantive acceptance holds** (conservative): a reviewer whose latest review is "changes
  requested"; the labels `security`, `area:security`, `status:needs-verification`, `ga-blocker` or
  `review-has-feedback`; or a line in the PR body or a human comment that names an independent
  security review, native or supported-platform acceptance, a product or owner decision,
  "do not merge", "blocking acceptance" or an upper-case `HOLD`. Bot-authored comments, the
  reviewer bot's appended summary and quoted lines are ignored, and the matched line is recorded as
  evidence so the reader can disagree with it.
- **Superseded originals**: the PR body or a comment says it was "superseded by", "folded into",
  "recovered in" or "retired in" another PR, or a batch PR (open, draft, or merged within the
  comment window) pins it by head SHA (`#N` directly followed by a 40-hex SHA) or names it after a
  recovery verb in a sentence without exclusion wording. A PR based on another PR's branch is its
  stacked child and is never read as a batch of it. Links are recorded in both directions, with the
  batch's state, so an original folded into an open batch reads differently from one whose batch
  has merged.
- **Ready**: not a draft, GitHub reports it mergeable, `CI Passed`, `Screenshot review` and `CLA`
  are all successful on the head, nothing is pending, and no hold was detected.
- **In progress or waiting**: everything else, with the reason (draft, conflicts, CI not run or
  still running, no screenshot status, mergeability not yet computed).

A PR appears in exactly one group, chosen in the order superseded, failing checks, acceptance hold,
missing visual decision, ready, in progress. Its other signals stay visible in the Flags column.

Screenshot stacks are parsed with the same declaration rules as the stack gate
(`scripts/screenshot-stack.mts`); a member whose head moved after it was pinned shows as
"pin stale".
