import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildIndex, getIndex, invalidateIndex } from './file-index.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

describe('file-index', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'agent-pane-file-index-'))
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
    assert.ok(idx!.paths.includes('src/main.ts'))
    assert.ok(idx!.paths.includes('package.json'))
    assert.ok(idx!.lastBuilt > 0)
  })
})
