import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyStagedWrite } from './apply-staged-write.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

describe('applyStagedWrite', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-apply-staged-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
  })

  afterEach(async () => {
    restoreWorkspace?.()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('writes when disk still matches before snapshot', async () => {
    await writeFile(join(tempRoot, 'a.txt'), 'hello', 'utf-8')
    const result = await applyStagedWrite('a.txt', 'hello', 'hello world')
    assert.equal(result.ok, true)
    assert.equal(await readFile(join(tempRoot, 'a.txt'), 'utf-8'), 'hello world')
  })

  it('refuses when file changed after staging', async () => {
    await writeFile(join(tempRoot, 'b.txt'), 'v1', 'utf-8')
    await writeFile(join(tempRoot, 'b.txt'), 'external', 'utf-8')
    const result = await applyStagedWrite('b.txt', 'v1', 'v2')
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /changed on disk/)
    assert.equal(await readFile(join(tempRoot, 'b.txt'), 'utf-8'), 'external')
  })

  it('creates new file when before is empty and path is missing', async () => {
    const result = await applyStagedWrite('new.txt', '', 'content')
    assert.equal(result.ok, true)
    assert.equal(await readFile(join(tempRoot, 'new.txt'), 'utf-8'), 'content')
  })
})
