import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildIndex, getIndex, invalidateIndex, whenFileIndexReady } from './file-index.ts'
import { getWorkspaceIndexStatus, resetWorkspaceIndexStatusForTest } from './index-status.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'

describe('file-index', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-panel-file-index-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
    invalidateIndex()
    await mkdir(join(tempRoot, 'src'), { recursive: true })
    await writeFile(join(tempRoot, 'src', 'main.ts'), 'export {}\n', 'utf-8')
    await writeFile(join(tempRoot, 'package.json'), '{}\n', 'utf-8')
  })

  afterEach(async () => {
    restoreWorkspace?.()
    invalidateIndex()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('builds a path index for the workspace', async () => {
    await buildIndex(tempRoot)
    const idx = getIndex()
    assert.ok(idx)
    assert.ok(idx.paths.includes('src/main.ts'))
    assert.ok(idx.paths.includes('package.json'))
    assert.ok(idx.lastBuilt > 0)
  })

  it('reports building while a build is in flight, then ready', async () => {
    resetWorkspaceIndexStatusForTest()
    const build = buildIndex(tempRoot)
    assert.equal(getWorkspaceIndexStatus().fileIndex.phase, 'building')
    await build
    assert.equal(getWorkspaceIndexStatus().fileIndex.phase, 'ready')
  })

  it('whenFileIndexReady rides an in-flight build and resolves immediately when idle', async () => {
    const build = buildIndex(tempRoot)
    await whenFileIndexReady()
    assert.ok(getIndex())
    await build
    // No build in flight — must resolve without hanging.
    await whenFileIndexReady()
  })
})
