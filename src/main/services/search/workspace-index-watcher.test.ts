import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildIndex, getIndex, invalidateIndex } from './file-index.ts'
import {
  ensureWorkingTreeWatched,
  flushScheduledIndexRebuild,
  handleWorkspaceWatchEvent,
  isRootWatched,
  isWorkingTreeWatched,
  scheduleIndexRebuild,
  startWorkspaceIndexWatcher,
  stopWorkspaceIndexWatcher,
} from './workspace-index-watcher.ts'
import {
  flushWorkspaceChangeNotify,
  resetWorkspaceChangeNotifyForTest,
  setWorkspaceChangeSink,
} from './workspace-change-notify.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'

describe('workspace-index-watcher', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-panel-index-watch-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
    invalidateIndex()
    resetWorkspaceChangeNotifyForTest()
    await buildIndex(tempRoot)
    startWorkspaceIndexWatcher(tempRoot)
  })

  afterEach(async () => {
    stopWorkspaceIndexWatcher()
    resetWorkspaceChangeNotifyForTest()
    restoreWorkspace?.()
    invalidateIndex()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('publishes tracked generated paths without rebuilding the index from them', async () => {
    const changedRoots: string[] = []
    setWorkspaceChangeSink((root) => changedRoots.push(root))
    const before = getIndex(tempRoot)?.paths.slice() ?? []

    handleWorkspaceWatchEvent(tempRoot, 'node_modules/tracked-generated.js')
    handleWorkspaceWatchEvent(tempRoot, '.git/objects/ab/cdef')
    flushWorkspaceChangeNotify()
    await flushScheduledIndexRebuild(tempRoot)

    assert.deepEqual(changedRoots, [tempRoot])
    assert.deepEqual(getIndex(tempRoot)?.paths, before)
  })

  it('rebuilds the index for source paths and coalesces the git signal', async () => {
    const changedRoots: string[] = []
    setWorkspaceChangeSink((root) => changedRoots.push(root))
    await mkdir(join(tempRoot, 'src'), { recursive: true })
    await writeFile(join(tempRoot, 'src', 'app.ts'), 'export {}\n', 'utf-8')

    handleWorkspaceWatchEvent(tempRoot, 'src/app.ts')
    handleWorkspaceWatchEvent(tempRoot, '.git/HEAD')
    flushWorkspaceChangeNotify()
    await flushScheduledIndexRebuild(tempRoot)

    assert.deepEqual(changedRoots, [tempRoot])
    assert.ok(getIndex(tempRoot)?.paths.includes('src/app.ts'))
  })

  it('arms a git-only watch without claiming the index is current', async () => {
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'copse-panel-git-only-watch-'))
    try {
      stopWorkspaceIndexWatcher(tempRoot)
      ensureWorkingTreeWatched(worktreeRoot)
      assert.equal(isWorkingTreeWatched(worktreeRoot), true)
      assert.equal(isRootWatched(worktreeRoot), false)

      const changedRoots: string[] = []
      setWorkspaceChangeSink((root) => changedRoots.push(root))
      handleWorkspaceWatchEvent(worktreeRoot, 'src/app.ts')
      flushWorkspaceChangeNotify()
      await flushScheduledIndexRebuild(worktreeRoot)
      assert.deepEqual(changedRoots, [worktreeRoot])
      assert.equal(getIndex(worktreeRoot), null)

      startWorkspaceIndexWatcher(worktreeRoot, { withSemantic: false })
      assert.equal(isRootWatched(worktreeRoot), true)
      await flushScheduledIndexRebuild(worktreeRoot)
      assert.ok(getIndex(worktreeRoot))
    } finally {
      stopWorkspaceIndexWatcher(worktreeRoot)
      invalidateIndex(worktreeRoot)
      await rm(worktreeRoot, { recursive: true, force: true })
    }
  })

  it('rebuilds the file index after a debounced schedule', async () => {
    await writeFile(join(tempRoot, 'new-file.txt'), 'hello\n', 'utf-8')
    scheduleIndexRebuild(tempRoot)
    await flushScheduledIndexRebuild(tempRoot)
    const idx = getIndex(tempRoot)
    assert.ok(idx?.paths.includes('new-file.txt'))
  })

  it('watches multiple roots independently — starting one does not stop another', async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), 'copse-panel-index-watch-other-'))
    try {
      startWorkspaceIndexWatcher(otherRoot, { withSemantic: false })
      await writeFile(join(tempRoot, 'a.txt'), 'a\n', 'utf-8')
      await writeFile(join(otherRoot, 'b.txt'), 'b\n', 'utf-8')
      scheduleIndexRebuild(tempRoot)
      scheduleIndexRebuild(otherRoot)
      await flushScheduledIndexRebuild(tempRoot)
      await flushScheduledIndexRebuild(otherRoot)
      assert.ok(getIndex(tempRoot)?.paths.includes('a.txt'))
      assert.ok(getIndex(otherRoot)?.paths.includes('b.txt'))
      assert.equal(getIndex(tempRoot)?.paths.includes('b.txt'), false)
    } finally {
      stopWorkspaceIndexWatcher(otherRoot)
      invalidateIndex(otherRoot)
      await rm(otherRoot, { recursive: true, force: true })
    }
  })

  it('stopping one root leaves the other watched', async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), 'copse-panel-index-watch-other-'))
    try {
      startWorkspaceIndexWatcher(otherRoot, { withSemantic: false })
      stopWorkspaceIndexWatcher(tempRoot)
      await writeFile(join(otherRoot, 'still-watched.txt'), 'x\n', 'utf-8')
      scheduleIndexRebuild(otherRoot)
      await flushScheduledIndexRebuild(otherRoot)
      assert.ok(getIndex(otherRoot)?.paths.includes('still-watched.txt'))
    } finally {
      stopWorkspaceIndexWatcher(otherRoot)
      invalidateIndex(otherRoot)
      await rm(otherRoot, { recursive: true, force: true })
    }
  })
})
