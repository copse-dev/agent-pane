import { resolve } from 'node:path'
import {
  buildIndex,
  getIndexAgeMs,
  getIndexMemoryBytes,
  getIndexStats,
  invalidateIndex,
} from './file-index.ts'
import { ensureSemanticIndex } from './semantic-index.ts'
import { setSemanticIndexScaleGuarded, setSemanticIndexUnavailable } from './index-status.ts'
import { isActiveSshWorkspace } from '../ssh-workspace/execution-target.ts'
import {
  isRootWatched,
  startWorkspaceIndexWatcher,
  stopWorkspaceIndexWatcher,
} from './workspace-index-watcher.ts'
import { stopWatchingExecutionRoot } from './execution-root-watcher.ts'

/** The most recently opened renderer-selected workspace root, if any. */
let primaryWorkspaceRoot: string | null = null
let primaryWorkspaceGeneration = 0
const dormantPrimaryIndexes = new Map<string, number>()

// File lists are compact compared with transcripts and semantic indexes, but a
// user may have hundreds of saved projects. Retain warm project snapshots only
// inside a fixed heap budget; worktree indexes have their own lifecycle and are
// never entered into this primary-project MRU.
const DORMANT_PRIMARY_INDEX_BUDGET_BYTES = 32 * 1024 * 1024
import {
  decideWorkspaceIndexPolicy,
  policyAllowsSemantic,
  policyAllowsWatch,
  type IndexPolicyOverride,
} from './workspace-index-policy.ts'
import {
  beginWorkspaceIndexGate,
  clearWorkspaceIndexGate,
  resolveWorkspaceIndexGate,
} from './workspace-index-gate.ts'

let policyOverride: IndexPolicyOverride = 'default'

/** Test / future "index anyway" hook — force or never override the scale guard. */
export function setWorkspaceIndexPolicyOverrideForTest(override: IndexPolicyOverride): void {
  policyOverride = override
}

function scaleGuardReason(reasons: string[]): string {
  return reasons[0] ?? 'Workspace exceeds the semantic-index scale guard'
}

/**
 * How long an *unwatched* root's listing stays good enough to reuse. A watched
 * root never expires — its watcher re-lists on every change — so this only
 * bounds the roots that have no change signal at all (fs.watch refused, SSH).
 */
const UNWATCHED_INDEX_MAX_AGE_MS = 2 * 60 * 1000

export interface DormantIndexSnapshot {
  root: string
  bytes: number
}

/** Return oldest-first entries to evict until `snapshots` fits `maxBytes`. */
export function selectDormantIndexEvictions(
  snapshots: readonly DormantIndexSnapshot[],
  maxBytes: number,
): string[] {
  let retainedBytes = snapshots.reduce((total, snapshot) => total + snapshot.bytes, 0)
  const evictions: string[] = []
  for (const snapshot of snapshots) {
    if (retainedBytes <= maxBytes) break
    evictions.push(snapshot.root)
    retainedBytes -= snapshot.bytes
  }
  return evictions
}

function retainDormantPrimaryIndex(root: string): void {
  const key = resolve(root)
  const bytes = getIndexMemoryBytes(key)
  if (bytes === null) return
  // Delete + set promotes a project that was selected more recently.
  dormantPrimaryIndexes.delete(key)
  dormantPrimaryIndexes.set(key, bytes)
  const snapshots = [...dormantPrimaryIndexes].map(([snapshotRoot, snapshotBytes]) => ({
    root: snapshotRoot,
    bytes: snapshotBytes,
  }))
  for (const evictedRoot of selectDormantIndexEvictions(
    snapshots,
    DORMANT_PRIMARY_INDEX_BUDGET_BYTES,
  )) {
    dormantPrimaryIndexes.delete(evictedRoot)
    invalidateIndex(evictedRoot)
  }
}

/**
 * Whether registering `root` should pay for a fresh listing (#1694).
 *
 * Registration is not a change signal. `resolveThreadExecutionContext`
 * re-registers a thread's execution root on every git/fs IPC, so selecting a
 * thread fires a handful of them (git status, change stats, branch status, the
 * file tree) before the user has touched anything. Listing the whole checkout on
 * each one cost ~20s of "Indexing…" per switch on a large repo and produced the
 * snapshot the watcher was already holding.
 *
 * Actual change signals are unaffected: the watcher's own rebuild,
 * `scheduleIndexRebuild`, and the diff queue after a write all call `buildIndex`
 * directly and always re-list.
 */
function needsFreshListing(root: string): boolean {
  const age = getIndexAgeMs(root)
  if (age === null) return true // Never listed — nothing to reuse.
  if (isRootWatched(root)) return false
  return age >= UNWATCHED_INDEX_MAX_AGE_MS
}

/**
 * Kick off all workspace indexing without blocking the caller.
 *
 * Opening a workspace must not wait on index builds — the renderer swaps to
 * the full layout immediately and the footer index indicator reports build
 * progress instead. Consumers that need the file index ride the in-flight
 * build via `whenFileIndexReady()`; semantic searches already coalesce onto
 * the in-flight `ensureSemanticIndex` run.
 *
 * Sequencing (#795): the bounded file index provides path-count scale evidence
 * before Gortex tracking or a recursive watcher begins. Above the reviewed cap,
 * text/regex search stays available while semantic indexing and broad watching
 * enter `limited`/`skipped` (not `error`/`unavailable`).
 *
 * Every open path (workspace:open / workspace:set IPC, the native
 * File ▸ Open Folder menu) must go through here so none of them misses the
 * semantic index or the rebuild watcher.
 *
 * SSH workspaces skip semantic indexing (v1) and the local fs.watch watcher
 * (remote edits are handled in Phase 3c). The in-memory file index still builds
 * via remote `rg --files` / `find` — that can surface as the footer chip
 * ("Building file index…"), which is not gortex. Listings use a longer timeout
 * than ordinary tool subprocesses (`FILE_INDEX_LIST_TIMEOUT_MS`).
 */
export function startWorkspaceIndexing(root: string): void {
  const key = resolve(root)
  // Switching workspaces replaces the previous primary root: stop its watcher,
  // but retain the last coherent listing in the bounded dormant-project MRU.
  // Worktree execution roots (registered via startExecutionRootIndexing) are
  // untouched — they track their own thread's lifetime, not the renderer's
  // selected workspace.
  const previous = primaryWorkspaceRoot
  primaryWorkspaceRoot = key
  const generation = ++primaryWorkspaceGeneration
  dormantPrimaryIndexes.delete(key)
  if (previous && previous !== key) {
    stopWorkspaceIndexWatcher(previous)
    retainDormantPrimaryIndex(previous)
  }

  beginWorkspaceIndexGate(key)
  void runWorkspaceIndexing(key, generation).catch((err: unknown) => {
    console.warn('[copse-panel] workspace indexing orchestration failed:', err)
  })
}

async function runWorkspaceIndexing(root: string, generation: number): Promise<void> {
  try {
    // Re-selecting the project you are already on re-runs this; the scale
    // evidence below reads the existing listing rather than rebuilding it.
    if (needsFreshListing(root)) await buildIndex(root)
  } catch (err: unknown) {
    console.warn('[copse-panel] file index build failed:', err)
  }

  // A large listing can finish after another project was selected. Keep its
  // coherent snapshot as dormant data, but never let an obsolete orchestration
  // re-arm the outgoing root's watcher or semantic work.
  if (generation !== primaryWorkspaceGeneration) {
    if (root !== primaryWorkspaceRoot) retainDormantPrimaryIndex(root)
    return
  }

  if (isActiveSshWorkspace()) {
    resolveWorkspaceIndexGate(root, { semantic: 'skipped', watch: 'skipped' })
    setSemanticIndexUnavailable()
    return
  }

  const stats = getIndexStats(root)
  const policy = decideWorkspaceIndexPolicy({
    pathCount: stats?.pathCount ?? 0,
    byteEstimate: stats?.byteEstimate ?? null,
    nestedRepos: [],
    override: policyOverride,
    discoveryConfidence: stats ? 'complete' : 'failed',
  })

  resolveWorkspaceIndexGate(root, {
    semantic: policy.semantic,
    watch: policy.watch,
  })

  if (!policyAllowsSemantic(policy)) {
    const phase = policy.semantic === 'limited' ? 'limited' : 'skipped'
    setSemanticIndexScaleGuarded(phase, scaleGuardReason(policy.reasons))
    if (policy.reasons.length > 0) {
      console.info(`[copse-panel] semantic index ${phase}: ${policy.reasons.join('; ')}`)
    }
  } else {
    void ensureSemanticIndex(root)
  }

  if (policyAllowsWatch(policy)) {
    startWorkspaceIndexWatcher(root, { withSemantic: true })
  }
}

/** Test hook — clear gate + override between tests. */
export function resetWorkspaceIndexingForTest(): void {
  policyOverride = 'default'
  primaryWorkspaceRoot = null
  primaryWorkspaceGeneration = 0
  dormantPrimaryIndexes.clear()
  clearWorkspaceIndexGate()
}

/**
 * Kick off file indexing (and its rebuild watcher) for a thread's worktree
 * execution root — a linked checkout under `~/.copse/worktrees/<project>/
 * <thread>/`, outside the primary workspace root the functions above cover.
 *
 * Deliberately skips per-worktree semantic indexing: gortex scopes its shared
 * daemon to one active repo, so tracking every linked checkout would thrash it.
 * Semantic queries reuse the project checkout's index and overlay the current
 * worktree delta in `executeSemanticSearch`.
 *
 * Safe — and cheap — to call repeatedly for the same root, so callers can fire
 * this on every worktree context resolution rather than tracking whether a
 * given thread has already been registered. The watcher registration is a
 * no-op once armed, and the listing is skipped while that watcher is keeping
 * the index current (#1694); only the first registration of a root, or one
 * whose watcher never armed and whose listing has gone stale, pays for a walk.
 */
export function startExecutionRootIndexing(root: string): void {
  if (needsFreshListing(root)) {
    void buildIndex(root).catch((err: unknown) => {
      console.warn('[copse-panel] execution root index build failed:', err)
    })
  }
  startWorkspaceIndexWatcher(root, { withSemantic: false })
}

/** Release a worktree execution root's index/watcher once its thread's checkout is retired. */
export function stopExecutionRootIndexing(root: string): void {
  stopWorkspaceIndexWatcher(root)
  // The tool-result cache watches this root too (`ensureExecutionRootWatched`,
  // via the tool registry). Nothing else stops it, and a recursive `fs.watch`
  // left on a directory that has been removed is not inert: on a change event
  // Node's recursive watcher scandirs the subtree it thinks is still there and
  // the ENOENT surfaces as an uncaught exception, taking the main process with
  // it. Retiring, pruning, and deleting a worktree all funnel through
  // `releaseWorktreeRoot` into here, so this is where the watcher goes.
  stopWatchingExecutionRoot(root)
  invalidateIndex(root)
}
