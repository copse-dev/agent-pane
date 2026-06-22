import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { strReplaceTool } from './str-replace-tool.ts'
import { clearStagedDiffsForTest, getStagedDiffEntry } from '../services/diff-queue.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'

describe('strReplaceTool', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    clearStagedDiffsForTest()
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-str-replace-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
  })

  afterEach(async () => {
    clearStagedDiffsForTest()
    restoreWorkspace?.()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('stages a diff message on unique match', async () => {
    await writeFile(join(tempRoot, 'f.ts'), 'const x = 1\n', 'utf-8')
    const out = await strReplaceTool.execute(
      { path: 'f.ts', old_string: 'const x = 1', new_string: 'const x = 2', replace_all: false },
      new AbortController().signal,
    )
    assert.match(out, /Diff staged/)
  })

  it('errors when old_string is missing', async () => {
    await writeFile(join(tempRoot, 'f.ts'), 'a', 'utf-8')
    const out = await strReplaceTool.execute(
      { path: 'f.ts', old_string: 'missing', new_string: 'b', replace_all: false },
      new AbortController().signal,
    )
    assert.match(out, /not found/)
  })

  it('errors on ambiguous match without replace_all', async () => {
    await writeFile(join(tempRoot, 'f.ts'), 'foo\nfoo\n', 'utf-8')
    const out = await strReplaceTool.execute(
      { path: 'f.ts', old_string: 'foo', new_string: 'bar', replace_all: false },
      new AbortController().signal,
    )
    assert.match(out, /2 times/)
  })

  it('composes replacements against pending proposed content without writing to disk', async () => {
    await writeFile(join(tempRoot, 'f.ts'), 'const x = 1\n', 'utf-8')
    await strReplaceTool.execute(
      { path: 'f.ts', old_string: 'const x = 1', new_string: 'const x = 2', replace_all: false },
      new AbortController().signal,
    )
    const out = await strReplaceTool.execute(
      { path: 'f.ts', old_string: 'const x = 2', new_string: 'const x = 3', replace_all: false },
      new AbortController().signal,
    )

    assert.match(out, /Updated pending staged diff/)
    assert.equal(getStagedDiffEntry('f.ts')?.before, 'const x = 1\n')
    assert.equal(getStagedDiffEntry('f.ts')?.after, 'const x = 3\n')
    assert.equal(await readFile(join(tempRoot, 'f.ts'), 'utf-8'), 'const x = 1\n')
  })
})
