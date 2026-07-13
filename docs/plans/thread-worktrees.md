# Per-thread worktrees

Give each thread its own git working tree so threads can run in parallel
without fighting over the single checkout — and so the user's editor stays on
their branch while agents work. Allocation is **conditional**: a new thread
defaults to a fresh worktree **when the project checkout is on the default
branch** (main/master); otherwise it shares the checkout as today. Ergonomics
is the design driver throughout: no ceremony to get an isolated thread, no
surprise about what the agent can see, and a one-click path to bring work back.

## Why

Today one global `workspaceRoot` (`src/main/services/workspace.ts`) backs every
subsystem — file/shell tools, path containment, the seatbelt sandbox scope,
semantic index + watcher, terminal cwd, the git service, the editor. Threads
carry a `gitBranch` label, but it is a fiction under concurrency:

- `src/shared/git/sync-thread-branch.ts` exists to rebind a thread when
  _another thread_ moves HEAD under it.
- `src/main/services/worktree-backup.ts` keeps the pre-turn safety snapshot in
  a process-global singleton, so concurrent threads silently share one backup
  and "Restore pre-session changes" can restore the wrong baseline.

Two agents editing at once clobber each other's checkout and the user's open
buffers. Worktrees solve this at the git layer: shared object database, cheap
creation, independent HEAD/index/files per thread.

## Allocation policy

Decided lazily at **first message** (not thread creation — blank threads and
drafts stay free), at the same point `bindThreadGitBranchIfUnset` runs today
(`src/renderer/views/input-bar.ts`).

| Situation at first message                                          | Default                                                                                         |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Checkout on the default branch (`getDefaultBranch()`)               | **New worktree**, new branch `copse/<thread-slug>`                                              |
| Checkout on a non-default branch                                    | Share the checkout (status quo — user is mid-feature and likely wants the agent alongside them) |
| Not a git repo / no default branch resolvable / submodules detected | Share the checkout                                                                              |
| Explicit user choice (chip in the input bar, see UX)                | Wins over all of the above                                                                      |

Rationale for the main-branch trigger: work started from main is almost always
a _new_ task, where isolation is pure upside; work started from a feature
branch is usually _continuation_, where the user expects the agent to see the
branch state and their editor.

Project-level setting `worktreeMode`: `from-default-branch` (default) ·
`always` · `never`.

### Dirty main checkout

If the checkout is on main but dirty, we still allocate a worktree and **carry
the uncommitted work into it**: `createWorktreeBackup()` already snapshots the
entire tree (staged + unstaged + untracked) into a commit ref without touching
the index — seed the new worktree from HEAD, then apply that snapshot on top.
The agent sees exactly what the user sees; the user's checkout is untouched.
The input-bar chip says so ("includes your 3 uncommitted files") so nothing is
invisible or surprising.

## Architecture

### Phase 0 — prerequisites (standalone wins, land first)

1. **Root-parameterize the git service.** `git-service.ts` reads
   `getWorkspaceRoot()` internally; `getGithubRepoSlug(root)` already shows the
   target shape. Give every exported function an explicit `root` argument
   (call sites pass the thread root once Phase 2 lands; until then a default
   keeps the diff mechanical).
2. **Per-thread session backup.** Replace the module singletons in
   `worktree-backup.ts` (`current`, `inFlight`) with a `Map<threadId, …>`.
   Fixes the concurrent-backup bug that exists today regardless of this plan.
3. **Thread-scoped root resolution.** Introduce a `ThreadContext { root }`
   threaded through the tool registry so `resolveWorkspacePath`,
   `assertWorkspaceWriteTarget`, shell-tool cwd, and the read/write fs IPC
   resolve against the thread's root instead of the global. The global
   `workspaceRoot` remains the _project_ root; a thread without a worktree has
   `root === workspaceRoot`, so the shared-checkout path stays the same code
   path, not a second mode.

### Phase 1 — worktree manager

New `src/main/services/worktree-manager.ts`:

- `allocate(projectRoot, threadId, title, opts)` →
  `git worktree add -b copse/<slug> <dir> <default-branch>`, optional dirty
  snapshot apply. Registers the new root with
  `registerAllowedWorkspaceRoot()` and the seatbelt scope so containment and
  sandboxing are per-thread-root from the start.
- `remove(threadId, { force })`, `list(projectRoot)`,
  `pruneOrphans(projectRoot)` (worktrees whose thread no longer exists in the
  catalog _and_ whose branch is merged/clean; anything dirty or unmerged is
  kept and surfaced, never silently deleted).
- Placement: `~/.copse/worktrees/<projectId>/<threadId>/` — outside the repo
  (no `.gitignore` change, never indexed by the project, consistent with the
  `~/.copse` store). Honors `COPSE_WORKSPACE_DIR`-style override
  (`COPSE_WORKTREES_DIR`).
- Branch naming: `copse/<slug>` from the thread title (same slugging as thread
  ids), collision-suffixed. Bound via `setThreadGitBranch` so the existing
  footer/PR machinery keeps working unchanged.

`Thread` gains a persisted field:

```ts
/** Isolated working tree allocated to this thread, when any. */
worktree?: { path: string; baseBranch: string; baseCommit: string; createdAt: number }
```

### Phase 2 — policy + composer UX

- Policy function (pure, unit-tested) in `src/shared/git/worktree-policy.ts`
  taking `{ currentBranch, defaultBranch, isGitRepo, hasSubmodules, setting,
explicitChoice }` → `'worktree' | 'shared'`.
- **Composer chip** (input bar, pre-first-message): shows what will happen —
  `⎇ isolated · copse/fix-flicker` or `⎇ shared · main` — click to flip. After
  the first message it becomes the existing footer branch status. One glance
  answers "where will this thread's edits go", which is the core ergonomic
  contract.
- Footer branch status (`footer-branch-status.ts`) learns the worktree state;
  the mismatch warning path is unnecessary for worktree threads (HEAD cannot
  be moved by another thread).

### Phase 3 — UI re-rooting on thread switch

The three-pane UI follows the **active thread's root**:

- Editor file tree / Monaco open-file resolution, `fs:*` IPC, and the git pane
  resolve against `getThreadRoot(activeThreadId)`.
- Terminal: new terminals spawn in the thread root. Existing terminal sessions
  keep their cwd (they are processes); the terminal tab shows which root it
  belongs to.
- Search: **v1 keeps the single semantic index on the project root.** Worktree
  trees are near-identical, relative paths carry over, and read/write tools
  already operate on the thread root — so search results stay useful, at the
  cost of staleness for files the thread itself changed. Documented
  limitation; follow-up is an index overlay of the thread's touched files
  (the diff queue already knows them).

### Phase 4 — bringing work back (the other half of ergonomics)

Isolation is only ergonomic if the return trip is one click:

- **Changes chip** on each worktree thread: ahead/behind vs `baseBranch`,
  dirty-file count (data via the root-parameterized `getGitChangeStats`).
- **"Bring into project" action** with three modes:
  1. _Merge to <base>_ — commit (existing `commitWithAttribution`), then
     fast-forward/merge in the main checkout; conflicts open the existing
     diff view.
  2. _Create PR_ — reuses the existing remote-agent/PR flow; the thread
     already owns a real branch, so this is free.
  3. _Keep branch_ — just leave `copse/<slug>` for manual handling.
- After a successful merge + clean tree, offer to retire the worktree.

### Phase 5 — lifecycle, environment bootstrap, polish

- **GC:** on startup, `git worktree prune` + `pruneOrphans`. Thread deletion
  removes its worktree (guarded: dirty/unmerged ⇒ confirm, listing what would
  be lost). Settings: retention count/age.
- **Environment bootstrap:** untracked state (`node_modules`, `.env`) does not
  come along in a worktree. Two opt-in project settings:
  - `worktreeSetupCommand` — run in the new tree after creation (e.g.
    `npm install`), streamed to the thread like a normal shell tool call so
    failures are visible and retryable.
  - `worktreeCopyGlobs` — untracked files copied from the main checkout (e.g.
    `.env`, `.env.local`). Copy, never symlink — trees diverge.
    First worktree in a project without these configured gets a one-time,
    dismissible hint when the agent's first command fails in a way that smells
    like missing deps. v2: warm-spare tree (pre-created + pre-installed) to make
    allocation instant for heavyweight projects.

## Edge cases

- **Branch already checked out elsewhere:** `git worktree add` refuses; the
  manager retries with a suffixed branch name.
- **Default-branch detection fails** (no remote, detached HEAD): policy
  returns `shared` — never guess.
- **Submodules:** worktree support is poor; policy returns `shared` and the
  chip explains why.
- **User deletes the worktree directory manually:** thread falls back to
  shared mode with a notice; `git worktree prune` cleans the stale entry.
- **Disk pressure:** worktree checkout cost is tracked-files only, but setup
  commands can be heavy; GC settings plus the changes chip keep it visible.
- **`workspace:set` gating:** worktree roots are registered as _allowed_ roots
  for containment but are not offered as openable projects — they belong to
  their parent project.

## Testing

- Unit: policy function (all rows of the table above); worktree-manager
  against throwaway git repos (pattern exists in `git-service.test.ts`);
  per-thread backup map; dirty-snapshot seeding (staged + unstaged +
  untracked all arrive).
- e2e (wdio): start thread on main → worktree allocated, chip correct; two
  threads editing the same file in parallel → no interference; merge-back
  happy path; thread deletion with dirty tree prompts.
- Regression: shared-mode threads exercise the identical code path with
  `root === workspaceRoot` (Phase 0.3), so existing suites keep covering it.

## Sequencing / risk

Phases 0–2 are independently shippable and fix real bugs (global backup
singleton) even if the default never flips. Phase 3 is the widest diff
(UI re-rooting) and the main schedule risk; it can ship behind the `never`
setting until stable. The default (`from-default-branch`) flips on only after
Phase 4, because isolation without the one-click return trip is a net
ergonomic loss.
