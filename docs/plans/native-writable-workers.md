# Isolated writable workers

Brief recorded before editing at `9920c32a9c69b645e21071720cbaa12418cfebc0`, based on `f507a7e56d151bd0ccb2680783ed5c3ffd13bad3`.

## Acceptance criteria

- `run_isolated_workers` runs explicitly named agents in different manager-owned local Git worktrees, never the parent checkout. Each worker has an independent thread identity and diff queue, and holds the existing dispatcher slot plus checkout-resource fence through cleanup so a reopened recovery chat cannot start a second writer. Unsupported targets fail before inference.
- Read-only and writable batches share two admissions per parent turn and the same supervisor concurrency class (two globally), 120-second deadline, one attempt, depth one and existing 12/30-step limits.
- Writable workers use root-confined native file tools and the existing preflight/approved preparation tools. Shell, MCP, arbitrary custom tools, recursion, commits and parent-plan updates remain unavailable. Agent and parent read-only restrictions only narrow access.
- Concurrent writes to the same relative path remain distinct. Absolute sibling paths, traversal and symlinks cannot overwrite another checkout. Tests exercise the actual tool/path boundaries.
- Cancellation fences reports immediately. Cleanup runs only after the worker's execution settles, including cancellation during allocation/preparation and late uncooperative completion. Clean checkouts retire through the existing manager; dirty, ignored, unmerged, staged-for-approval or uninspectable work is retained with durable ownership and recovery paths. Command hooks remain detached under the existing hooks contract: when enabled at worker start or cleanup, retain the checkout even if clean, without a hook drain barrier. No automatic merge or destructive cleanup.
- Runtime evidence verifies distinct writable results, attribution and cancellation; focused lifecycle tests cover races and resource release. Full `pnpm run check` is required because this touches ownership, persistence and control flow.

## Scope and risks

Foreground native workers only; no detached replay, plugin discovery, shell escalation, shared spend caps, model-role changes or child skill activation. Worktrees start through the existing allocation/snapshot/ignored-clone path from the parent's branch. Preparation remains fingerprinted and asks through the ordinary registry gate. A cancelled task can become terminal before an uncooperative handler stops: its checkout must stay present until its finalizer runs. Retained worker chats are recovery records, not resumable supervisor jobs.
