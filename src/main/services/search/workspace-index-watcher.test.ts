import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildIndex, getIndex, invalidateIndex } from './file-index.ts'
import {
  emitWorkspaceIndexWatcherErrorForTest,
  flushScheduledIndexRebuild,
  handleWorkspaceWatchEvent,
  isRootWatched,
  scheduleIndexRebuild,
  startWorkspaceIndexWatcher,
  stopWorkspaceIndexWatcher,
} from './workspace-index-watcher.ts'
import { setWorkspaceChangeSink } from './workspace-change-notify.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'

describe('workspace-index-watcher', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-panel-index-watch-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
    invalidateIndex()
    setWorkspaceChangeSink(null)
    await buildIndex(tempRoot)
    startWorkspaceIndexWatcher(tempRoot)
  })

  it('publishes every recursive change while keeping index exclusions narrow', async () => {
    const changedRoots: string[] = []
    setWorkspaceChangeSink((root) => changedRoots.push(root))

    handleWorkspaceWatchEvent(tempRoot, 'node_modules/tracked-generated.js')
    handleWorkspaceWatchEvent(tempRoot, 'src/app.ts')
    await flushScheduledIndexRebuild(tempRoot)

    assert.deepEqual(changedRoots, [tempRoot, tempRoot])
  })

  afterEach(async () => {
    stopWorkspaceIndexWatcher()
    restoreWorkspace?.()
    invalidateIndex()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
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

  it('drops the watcher on error instead of leaving an uncaught exception', () => {
    assert.equal(isRootWatched(tempRoot), true)
    assert.equal(
      emitWorkspaceIndexWatcherErrorForTest(tempRoot, new Error('ENOENT: watch root gone')),
      true,
    )
    assert.equal(isRootWatched(tempRoot), false)
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
