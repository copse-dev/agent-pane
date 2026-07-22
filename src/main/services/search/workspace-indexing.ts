import { buildIndex, getIndexStats } from './file-index.ts'
import { ensureSemanticIndex } from './semantic-index.ts'
import { setSemanticIndexScaleGuarded, setSemanticIndexUnavailable } from './index-status.ts'
import { isActiveSshWorkspace } from '../ssh-workspace/execution-target.ts'
import { startWorkspaceIndexWatcher } from './workspace-index-watcher.ts'
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
  beginWorkspaceIndexGate(root)
  void runWorkspaceIndexing(root).catch((err: unknown) => {
    console.warn('[copse-panel] workspace indexing orchestration failed:', err)
  })
}

async function runWorkspaceIndexing(root: string): Promise<void> {
  try {
    await buildIndex(root)
  } catch (err: unknown) {
    console.warn('[copse-panel] file index build failed:', err)
  }

  if (isActiveSshWorkspace()) {
    resolveWorkspaceIndexGate(root, { semantic: 'skipped', watch: 'skipped' })
    setSemanticIndexUnavailable()
    return
  }

  const stats = getIndexStats()
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
    startWorkspaceIndexWatcher(root)
  }
}

/** Test hook — clear gate + override between tests. */
export function resetWorkspaceIndexingForTest(): void {
  policyOverride = 'default'
  clearWorkspaceIndexGate()
}
