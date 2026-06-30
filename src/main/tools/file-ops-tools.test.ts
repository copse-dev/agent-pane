import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolRegistry, setPermissionGateForTests } from '../services/tool-registry.ts'
import { deleteFileTool, renameFileTool, makeDirectoryTool } from './file-ops-tools.ts'
import {
  applyDiffEntry,
  getDiffQueueForTest,
  clearDiffQueueForTest,
} from '../services/diff-queue.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'

import { normalizeToolExecuteResult } from '@shared/types'

function run(registry: ToolRegistry, name: string, args: Record<string, unknown>): Promise<string> {
  return registry
    .execute(name, args, new AbortController().signal)
    .then((r) => normalizeToolExecuteResult(r).result)
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

describe('file-ops tools (#122)', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined
  let registry: ToolRegistry

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-panel-file-ops-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
    registry = new ToolRegistry()
    registry.register(deleteFileTool)
    registry.register(renameFileTool)
    registry.register(makeDirectoryTool)
    setPermissionGateForTests(async () => true)
    clearDiffQueueForTest()
  })

  afterEach(async () => {
    setPermissionGateForTests(null)
    clearDiffQueueForTest()
    restoreWorkspace?.()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('delete_file stages a deletion that removes the file only after approval', async () => {
    await writeFile(join(tempRoot, 'gone.txt'), 'bye\n', 'utf8')
    const msg = await run(registry, 'delete_file', { path: 'gone.txt' })
    assert.match(msg, /Deletion of gone\.txt staged/)
    // Not removed yet.
    assert.equal(await exists(join(tempRoot, 'gone.txt')), true)

    const queue = getDiffQueueForTest()
    assert.equal(queue.length, 1)
    const [entry] = queue
    assert.ok(entry)
    const result = await applyDiffEntry(entry)
    assert.deepEqual(result, { status: 'written' })
    assert.equal(await exists(join(tempRoot, 'gone.txt')), false)
  })

  it('delete_file reports every removed line as edit stats for the tool card', async () => {
    await writeFile(join(tempRoot, 'gone.txt'), 'a\nb\nc\n', 'utf8')
    const { editStats } = normalizeToolExecuteResult(
      await registry.execute('delete_file', { path: 'gone.txt' }, new AbortController().signal),
    )
    assert.deepEqual(editStats, { additions: 0, deletions: 3 })
  })

  it('delete_file reports a missing file without staging', async () => {
    const msg = await run(registry, 'delete_file', { path: 'nope.txt' })
    assert.match(msg, /File not found: nope\.txt/)
    assert.equal(getDiffQueueForTest().length, 0)
  })

  it('rename_file stages a move applied only after approval', async () => {
    await writeFile(join(tempRoot, 'old.txt'), 'data\n', 'utf8')
    const msg = await run(registry, 'rename_file', { from: 'old.txt', to: 'sub/new.txt' })
    assert.match(msg, /Rename of old\.txt/)
    assert.equal(await exists(join(tempRoot, 'old.txt')), true)

    const [entry] = getDiffQueueForTest()
    assert.ok(entry)
    const result = await applyDiffEntry(entry)
    assert.deepEqual(result, { status: 'written' })
    assert.equal(await exists(join(tempRoot, 'old.txt')), false)
    assert.equal(await readFile(join(tempRoot, 'sub/new.txt'), 'utf8'), 'data\n')
  })

  it('rename_file refuses to clobber an existing destination', async () => {
    await writeFile(join(tempRoot, 'a.txt'), 'a\n', 'utf8')
    await writeFile(join(tempRoot, 'b.txt'), 'b\n', 'utf8')
    const msg = await run(registry, 'rename_file', { from: 'a.txt', to: 'b.txt' })
    assert.match(msg, /Destination already exists: b\.txt/)
    assert.equal(getDiffQueueForTest().length, 0)
  })

  it('make_directory stages creation applied only after approval', async () => {
    const msg = await run(registry, 'make_directory', { path: 'new/nested/dir' })
    assert.match(msg, /Creation of directory new\/nested\/dir staged/)
    assert.equal(await exists(join(tempRoot, 'new/nested/dir')), false)

    const [entry] = getDiffQueueForTest()
    assert.ok(entry)
    const result = await applyDiffEntry(entry)
    assert.deepEqual(result, { status: 'written' })
    assert.equal(await exists(join(tempRoot, 'new/nested/dir')), true)
  })

  it('make_directory reports an already-existing directory without staging', async () => {
    await mkdir(join(tempRoot, 'there'), { recursive: true })
    const msg = await run(registry, 'make_directory', { path: 'there' })
    assert.match(msg, /Directory already exists: there/)
    assert.equal(getDiffQueueForTest().length, 0)
  })
})
