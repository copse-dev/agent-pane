import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { strReplaceTool } from './str-replace-tool.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'

describe('strReplaceTool', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-str-replace-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
  })

  afterEach(async () => {
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
})
