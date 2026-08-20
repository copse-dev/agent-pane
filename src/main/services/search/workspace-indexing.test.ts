import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { getWorkspaceIndexStatus, resetWorkspaceIndexStatusForTest } from './index-status.ts'
import { getIndex, invalidateIndex } from './file-index.ts'
import {
  semanticIndexAllowed,
  semanticIndexPending,
  watchIndexAllowed,
} from './workspace-index-gate.ts'
import {
  resetWorkspaceIndexingForTest,
  selectDormantIndexEvictions,
  setWorkspaceIndexPolicyOverrideForTest,
  startExecutionRootIndexing,
  startWorkspaceIndexing,
} from './workspace-indexing.ts'
import {
  ensureWorkingTreeWatched,
  flushScheduledIndexRebuild,
  isRootWatched,
  isWorkingTreeWatched,
  scheduleIndexRebuild,
  stopWorkspaceIndexWatcher,
} from './workspace-index-watcher.ts'
import { setSemanticBackendForTest } from './semantic-index.ts'

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('workspace-indexing scale gate (#795)', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  afterEach(async () => {
    stopWorkspaceIndexWatcher()
    resetWorkspaceIndexingForTest()
    resetWorkspaceIndexStatusForTest()
    setSemanticBackendForTest(null)
    invalidateIndex()
    restoreWorkspace?.()
    restoreWorkspace = undefined
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
    tempRoot = ''
  })

  async function prepWorkspace(): Promise<string> {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-panel-ws-index-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
    await mkdir(join(tempRoot, 'src'), { recursive: true })
    await writeFile(join(tempRoot, 'src', 'main.ts'), 'export {}\n', 'utf-8')
    return tempRoot
  }

  it('marks the gate pending until file-index scale evidence is ready, then allows ordinary repos', async () => {
    const root = await prepWorkspace()
    // No semantic backend — we only assert gate sequencing, not gortex spawn.
    setSemanticBackendForTest(null)
    startWorkspaceIndexing(root)
    assert.equal(semanticIndexPending(root), true)
    await waitFor(() => !semanticIndexPending(root))
    assert.equal(semanticIndexAllowed(root), true)
    assert.equal(watchIndexAllowed(root), true)
  })

  it('skips semantic indexing and watching when the policy override is never', async () => {
    const root = await prepWorkspace()
    setSemanticBackendForTest(null)
    setWorkspaceIndexPolicyOverrideForTest('never')
    startWorkspaceIndexing(root)
    await waitFor(() => getWorkspaceIndexStatus().semantic.phase === 'skipped')
    assert.equal(getWorkspaceIndexStatus().semantic.phase, 'skipped')
    assert.match(
      getWorkspaceIndexStatus().semantic.reason ?? '',
      /Override disables semantic indexing/,
    )
    assert.equal(semanticIndexAllowed(root), false)
    assert.equal(watchIndexAllowed(root), false)
    assert.equal(isRootWatched(root), false)
    ensureWorkingTreeWatched(root)
    assert.equal(isWorkingTreeWatched(root), true)
    assert.equal(isRootWatched(root), false)
  })

  it('retains a warm project listing across A → B → A switches (#1728)', async () => {
    const rootA = await prepWorkspace()
    const rootB = await mkdtemp(join(tmpdir(), 'copse-panel-ws-index-b-'))
    try {
      // Snapshot retention is independent of recursive watching. Keep this
      // regression deterministic even on hosts that have exhausted their
      // macOS watcher allocation; #1698's watcher tests cover watched roots.
      setWorkspaceIndexPolicyOverrideForTest('never')
      await writeFile(join(rootB, 'other.ts'), 'export {}\n', 'utf-8')
      startWorkspaceIndexing(rootA)
      await waitFor(() => getIndex(rootA) !== null)
      const listingA = getIndex(rootA)
      assert.ok(listingA)

      startWorkspaceIndexing(rootB)
      await waitFor(() => getIndex(rootB) !== null)
      assert.equal(isRootWatched(rootA), false)
      assert.equal(getIndex(rootA), listingA)

      startWorkspaceIndexing(rootA)
      assert.equal(getIndex(rootA), listingA)
    } finally {
      await rm(rootB, { recursive: true, force: true })
    }
  })

  it('evicts dormant snapshots from least to most recently used to fit a byte budget', () => {
    const snapshots = [
      { root: '/oldest', bytes: 4 },
      { root: '/middle', bytes: 5 },
      { root: '/newest', bytes: 6 },
    ]

    assert.deepEqual(selectDormantIndexEvictions(snapshots, 11), ['/oldest'])
    assert.deepEqual(selectDormantIndexEvictions(snapshots, 6), ['/oldest', '/middle'])
    assert.deepEqual(selectDormantIndexEvictions(snapshots, 0), ['/oldest', '/middle', '/newest'])
  })
})

describe('execution root registration (#1694)', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-panel-exec-root-index-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
    setSemanticBackendForTest(null)
    invalidateIndex()
    resetWorkspaceIndexStatusForTest()
    await writeFile(join(tempRoot, 'main.ts'), 'export {}\n', 'utf-8')
  })

  afterEach(async () => {
    stopWorkspaceIndexWatcher()
    setSemanticBackendForTest(null)
    resetWorkspaceIndexStatusForTest()
    invalidateIndex()
    restoreWorkspace?.()
    restoreWorkspace = undefined
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
    tempRoot = ''
  })

  it('lists a root once, then reuses that listing on every later registration', async () => {
    // A registration starts its listing synchronously (`indexBuildStarted` runs
    // before `buildIndex`'s first await), so the phase read straight after the
    // call reports whether this registration paid for a walk.
    startExecutionRootIndexing(tempRoot)
    assert.equal(getWorkspaceIndexStatus().fileIndex.phase, 'building')
    await waitFor(() => getWorkspaceIndexStatus().fileIndex.phase === 'ready')
    const listing = getIndex(tempRoot)
    assert.ok(listing)
    assert.equal(isRootWatched(tempRoot), true)

    // Selecting a thread re-resolves its execution root through several git/fs
    // IPCs, each of which registers the root again. Re-listing the whole
    // checkout on each one cost ~20s per switch on a large repo, and the
    // watcher above was already keeping this listing current.
    startExecutionRootIndexing(tempRoot)
    startExecutionRootIndexing(tempRoot)
    assert.equal(getWorkspaceIndexStatus().fileIndex.phase, 'ready')
    assert.equal(getIndex(tempRoot), listing)
  })

  it('still picks up disk changes, so the reused listing is never stale', async () => {
    startExecutionRootIndexing(tempRoot)
    await waitFor(() => getWorkspaceIndexStatus().fileIndex.phase === 'ready')

    await writeFile(join(tempRoot, 'added-later.ts'), 'export {}\n', 'utf-8')
    scheduleIndexRebuild(tempRoot)
    await flushScheduledIndexRebuild(tempRoot)

    assert.ok(getIndex(tempRoot)?.paths.includes('added-later.ts'))
  })
})
