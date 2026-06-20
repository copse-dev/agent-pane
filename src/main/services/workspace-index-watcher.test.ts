import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildIndex, getIndex, invalidateIndex } from './file-index.ts'
import {
  flushScheduledIndexRebuild,
  scheduleIndexRebuild,
  startWorkspaceIndexWatcher,
  stopWorkspaceIndexWatcher,
} from './workspace-index-watcher.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

describe('workspace-index-watcher', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'agent-pane-index-watch-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
    invalidateIndex()
    await buildIndex(tempRoot)
    startWorkspaceIndexWatcher(tempRoot)
  })

  afterEach(async () => {
    stopWorkspaceIndexWatcher()
    restoreWorkspace?.()
    invalidateIndex()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('rebuilds the file index after a debounced schedule', async () => {
    await writeFile(join(tempRoot, 'new-file.txt'), 'hello\n', 'utf-8')
    scheduleIndexRebuild()
    await flushScheduledIndexRebuild()
    const idx = getIndex()
    assert.ok(idx?.paths.includes('new-file.txt'))
  })
})
