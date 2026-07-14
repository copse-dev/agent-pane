## Problem

Copse threads share one git checkout. Concurrent agent threads clobber each other's working tree, the global `worktree-backup` singleton can restore the wrong baseline, and `gitBranch` labels are unreliable under concurrency.

## Proposal

Give each thread its own git worktree when appropriate so agents can run in parallel without fighting over the user's checkout.

Design is written up in `docs/plans/thread-worktrees.md`. Summary:

- **Lazy allocation** at first message (not thread creation).
- **Default policy**: new worktree when the project checkout is on the default branch; share checkout when the user is mid-feature on a non-default branch.
- **Placement**: `~/.copse/worktrees/<projectId>/<threadId>/`.
- **Dirty-main handling**: carry uncommitted work into the new worktree via the existing backup snapshot.
- **Setting**: `worktreeMode` — `from-default-branch` (default) · `always` · `never`.
- **Scope threading**: per-thread `workspaceRoot` through file/shell tools, sandbox, index, terminals, git service, and editor.
- **UX**: input-bar chip for worktree vs shared; one-click path to bring work back.

## Phases

1. `worktree-manager.ts` + per-thread backup map (replace process-global singleton).
2. Policy + first-message allocation in `input-bar.ts`.
3. Scope `workspaceRoot` through subsystems.
4. UI (chip, footer branch status, bring-back flow).

## Acceptance criteria

- Two threads on main can edit concurrently without cross-clobbering.
- User's editor checkout stays on their branch while agent threads use worktrees.
- Worktree threads show correct branch/status in the footer.
- Orphan worktrees are pruned when threads are deleted.
- Unit tests for allocation policy and worktree manager.

## Related

- `docs/plans/thread-worktrees.md`
- `src/main/services/worktree-backup.ts` (global singleton to replace)
- `src/shared/git/sync-thread-branch.ts`
