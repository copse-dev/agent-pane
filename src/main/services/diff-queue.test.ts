import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyDiffEntry } from './diff-queue.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

describe('applyDiffEntry (stale-overwrite TOCTOU guard)', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'agent-pane-diff-queue-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
  })

  afterEach(async () => {
    restoreWorkspace?.()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('writes the after content when on-disk content still matches the staged before', async () => {
    await writeFile(join(tempRoot, 'a.txt'), 'original\n', 'utf-8')
    const result = await applyDiffEntry({
      path: 'a.txt',
      before: 'original\n',
      after: 'updated\n',
      language: 'plaintext',
    })
    assert.deepEqual(result, { status: 'written' })
    assert.equal(await readFile(join(tempRoot, 'a.txt'), 'utf-8'), 'updated\n')
  })

  it('refuses to overwrite when the file changed since staging, preserving the intervening change', async () => {
    // Staged against 'original', but something else wrote 'formatted' to disk.
    await writeFile(join(tempRoot, 'a.txt'), 'formatted\n', 'utf-8')
    const result = await applyDiffEntry({
      path: 'a.txt',
      before: 'original\n',
      after: 'updated\n',
      language: 'plaintext',
    })
    assert.deepEqual(result, { status: 'conflict', current: 'formatted\n' })
    // The intervening change must NOT be discarded.
    assert.equal(await readFile(join(tempRoot, 'a.txt'), 'utf-8'), 'formatted\n')
  })

  it('writes a brand new file when none existed at staging or approval', async () => {
    const result = await applyDiffEntry({
      path: 'new.txt',
      before: '',
      after: 'hello\n',
      language: 'plaintext',
    })
    assert.deepEqual(result, { status: 'written' })
    assert.equal(await readFile(join(tempRoot, 'new.txt'), 'utf-8'), 'hello\n')
  })

  it('reports a conflict when a file was created between staging and approval', async () => {
    // Staged as a new file (before ''), but another writer created it first.
    await writeFile(join(tempRoot, 'new.txt'), 'someone else\n', 'utf-8')
    const result = await applyDiffEntry({
      path: 'new.txt',
      before: '',
      after: 'hello\n',
      language: 'plaintext',
    })
    assert.deepEqual(result, { status: 'conflict', current: 'someone else\n' })
    assert.equal(await readFile(join(tempRoot, 'new.txt'), 'utf-8'), 'someone else\n')
  })

  it('creates missing parent directories for a new nested path (#120)', async () => {
    const result = await applyDiffEntry({
      path: 'src/feature/new/index.ts',
      before: '',
      after: 'export const x = 1\n',
      language: 'typescript',
    })
    assert.deepEqual(result, { status: 'written' })
    assert.equal(
      await readFile(join(tempRoot, 'src/feature/new/index.ts'), 'utf-8'),
      'export const x = 1\n',
    )
  })

  it('reports an error result instead of throwing when the write fails (#118)', async () => {
    // A directory occupies the target path, so writeFile fails (EISDIR).
    await mkdir(join(tempRoot, 'busy'), { recursive: true })
    const result = await applyDiffEntry({
      path: 'busy',
      before: '',
      after: 'data\n',
      language: 'plaintext',
    })
    assert.equal(result.status, 'error')
    if (result.status === 'error') assert.match(result.error, /EISDIR|illegal|directory/i)
  })
})
