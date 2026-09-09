# Recoverable edits without repeated file approvals

Status: implemented and validated, 9 September 2026.

## Problem and evidence

A reviewed ACP run repeatedly staged file edits because its first native write reported
`git has unowned changes that could not be backed up`. Later writes queued behind the pending
approval. Copse already creates recovery commits under `refs/copse/backups/`; adding ordinary
branch commits would duplicate that mechanism and consume the user's staging choices.

The immediate implementation is to make the existing first-write checkpoint reliable, with
regression coverage. Preserve the current approval fallback when recovery cannot be established.
Do not add a new run-start modal or suppress all later file approvals.

## Investigation and implementation

1. Reproduce checkpoint creation against the actual command/sandbox boundary. The local temporary
   Git index currently comes from the host `os.tmpdir()`, whereas sandboxed commands are given a
   separately sanctioned scratch directory. Check this mismatch before changing permission policy.
   Distinguish a demonstrated reproduction from the exact cause of the exported run, whose backup
   exception was discarded.
2. Allocate the temporary index where the existing sandbox already permits it, using the established
   scratch-path helper and the thread's resolved execution root. Keep the remote path allocated on
   the remote host. Do not widen the sandbox or run the snapshot unsandboxed. Clean up the index and
   its lock files on success and failure, without introducing scratch files into the snapshot.
3. Preserve useful, bounded failure diagnostics at the backup boundary rather than swallowing every
   failure as an unexplained null. Keep callers fail-closed and avoid logging source contents,
   credentials, whole environments or arbitrary unbounded Git stderr. Prefer the repository's
   existing diagnostic/error conventions. If a public result type must change, update all callers
   coherently; do not add a parallel backup implementation.
4. Verify the existing edit path: uncommitted files are checkpointed before an overwriting edit;
   later eligible edits continue directly. A pending user review, failed checkpoint, or concurrent
   user edit must still retain the existing approval/conflict behavior. Do not interpret old age as
   ownership, and do not treat a previous turn's checkpoint as authorization for a new turn.
5. Update this plan with the demonstrated cause, implementation boundaries and validation results.
   Keep prompt PR #2626 separate. A new recovery UI or approval-batching policy requires a separate
   design; this PR should fix the demonstrated failure without hiding failed recovery.

## Safety invariants

- HEAD, the current branch, real Git index, staged/unstaged distinctions and working files are
  unchanged by checkpoint creation. Nothing is pushed and no ordinary branch commit is made.
- Modified tracked files, deletions and eligible untracked files remain recoverable; Git ignore
  rules remain respected. The temporary index itself must not become snapshot content.
- The snapshot operates on the resolved thread checkout, including linked worktrees and workspaces
  below the repository root. Remote execution never uses a client-local temporary path.
- No broader filesystem/network grant, automatic unsandboxed retry, or weaker approval setting.
- Errors, concurrent file changes and pending review cannot become successful auto-approval.
- Existing turn/thread isolation and snapshot reset semantics remain intact. Any new stale-snapshot
  defect found during implementation must be reported explicitly, not papered over with a boolean.

## Acceptance tests

- A sandbox-boundary regression fails with the old temp-index placement and passes with the fix.
  Use an injected runner or existing sandbox harness; a string-only source assertion is insufficient.
- A real temporary Git repo preserves HEAD, real index contents, tracked edits, untracked files and
  partial staging while creating a readable recovery ref. Include a linked worktree or nested-root
  case and assert no temporary index is captured.
- Failure to allocate, write or register the snapshot remains observable and fails closed; cleanup
  runs. Test only meaningful failure boundaries with supported dependency injection.
- The dirty-worktree diff-queue path applies successive edits directly after a successful backup;
  failed backup and pending/conflicting edits still stage. Preserve native/ACP parity tests.
- Run focused Git snapshot/backup/diff/ACP tests, then the required repository check before commit.
  Any renderer or visual-copy changes require the focused visual eval specified in AGENTS.md;
  prefer avoiding unrelated UI changes in this first PR.

## Delegation and review

Implementation is delegated to `gpt-5.6-luna` at high reasoning effort. The primary agent independently
checks the sandbox/temp-path hypothesis, reviews the diff and tests, and owns final validation and PR
publication. Passing tests do not prove that a checkpoint authorizes an otherwise out-of-scope edit.

## Implementation evidence

The ASRT reproduction confirmed the failure boundary: a linked-worktree snapshot whose throwaway
`GIT_INDEX_FILE` was under the host `os.tmpdir()` failed at `read-tree` while creating the index lock
with `Operation not permitted`. The same snapshot runner and repository succeeded when the index was
allocated under the existing workspace scratch directory. The successful run preserved `HEAD`, the
real index, staged and unstaged content, and untracked content; the temporary index was cleaned up.

The implementation now uses `ensureWorkspaceTmpDir()` for local sandboxed checkpoints and keeps the
remote `mktemp` allocation on the remote host. Unsandboxed unit runs retain an isolated OS-temp
allocation. Git failure diagnostics remain fail-closed as `null`.
The linked-worktree sandbox regression covers a nested execution root, partial staging, untracked
content, unchanged `HEAD`/index/status, and temporary-index cleanup. Git diagnostics expose only a
checkpoint stage and bounded numeric or recognized OS error code; raw Git stderr is discarded.

Primary review ran 83 focused snapshot, backup, diff-queue, ACP permission and sandbox integration
tests successfully with no skips. Both integration tests used actual macOS ASRT containment. The
initial nested development sandbox could not bind ASRT's socket; rerunning with host permissions
exercised the real boundary. Linux sandbox execution remains for CI verification.

The required `pnpm run check` passed: typechecking, repository-wide lint, formatting, demo parity,
dead-code and test-selection guards, e2e syntax validation, and all 9,111 tests with no failures or
skips. No renderer or approval-copy changes were made, so a visual eval was not required.
