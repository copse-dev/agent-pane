import { describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { ownedIt } from '../services/thread-execution-context.test-support.ts'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { normalizeToolExecuteResult } from '@shared/types'
import { applyPatchTool } from './apply-patch-tool.ts'
import { strReplaceTool } from './str-replace-tool.ts'
import {
  clearStagedDiffsForTest,
  getStagedDiffEntry,
  listStagedDiffEntries,
} from '../services/diff-queue.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'

function patch(...lines: string[]): string {
  return ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')
}

async function run(input: string): Promise<ReturnType<typeof normalizeToolExecuteResult>> {
  return normalizeToolExecuteResult(
    await applyPatchTool.execute({ input }, new AbortController().signal),
  )
}

describe('applyPatchTool', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    clearStagedDiffsForTest()
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-apply-patch-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
  })

  afterEach(async () => {
    clearStagedDiffsForTest()
    restoreWorkspace?.()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  ownedIt('stages every touched file through the diff queue and sums the line stats', async () => {
    await writeFile(join(tempRoot, 'a.ts'), 'one\ntwo\nthree\n', 'utf-8')
    await writeFile(join(tempRoot, 'gone.ts'), 'bye\n', 'utf-8')
    const out = await run(
      patch(
        '*** Update File: a.ts',
        ' one',
        '-two',
        '+2',
        '+2b',
        '*** Add File: src/new.ts',
        '+hello',
        '*** Delete File: gone.ts',
      ),
    )
    assert.match(out.result, /apply_patch handled 3 files/)
    assert.equal(getStagedDiffEntry('a.ts')?.after, 'one\n2\n2b\nthree\n')
    assert.equal(getStagedDiffEntry('src/new.ts')?.after, 'hello\n')
    assert.equal(getStagedDiffEntry('gone.ts')?.op, 'delete')
    // a.ts +2 -1, new.ts +1, gone.ts -1
    assert.deepEqual(out.editStats, { additions: 3, deletions: 2 })
  })

  ownedIt('changes nothing when any hunk fails to match', async () => {
    await writeFile(join(tempRoot, 'a.ts'), 'one\n', 'utf-8')
    await writeFile(join(tempRoot, 'b.ts'), 'real\n', 'utf-8')
    const out = await run(
      patch('*** Update File: a.ts', '-one', '+1', '*** Update File: b.ts', '-nope', '+x'),
    )
    assert.match(out.result, /no files were changed/)
    assert.match(out.result, /Hunk 1 of 1 for b\.ts failed/)
    assert.deepEqual(listStagedDiffEntries(), [])
  })

  ownedIt('rejects paths outside the workspace root before touching anything', async () => {
    await writeFile(join(tempRoot, 'a.ts'), 'one\n', 'utf-8')
    for (const escaping of ['../outside.txt', '/etc/passwd']) {
      const out = await run(
        patch('*** Update File: a.ts', '-one', '+1', `*** Add File: ${escaping}`, '+pwned'),
      )
      assert.match(out.result, /rejected .*Path outside workspace/)
      assert.match(out.result, /No files were changed/)
    }
    assert.deepEqual(listStagedDiffEntries(), [])
  })

  ownedIt('rejects a move destination outside the workspace root', async () => {
    await writeFile(join(tempRoot, 'a.ts'), 'one\n', 'utf-8')
    const out = await run(patch('*** Update File: a.ts', '*** Move to: ../a.ts', '-one', '+1'))
    assert.match(out.result, /Path outside workspace/)
    assert.deepEqual(listStagedDiffEntries(), [])
  })

  ownedIt('refuses to add over an existing file', async () => {
    await writeFile(join(tempRoot, 'a.ts'), 'one\n', 'utf-8')
    const out = await run(patch('*** Add File: a.ts', '+replaced'))
    assert.match(out.result, /a\.ts already exists/)
    assert.deepEqual(listStagedDiffEntries(), [])
  })

  ownedIt('reports a malformed patch without touching files', async () => {
    const out = await run('*** Update File: a.ts\n-x\n+y')
    assert.match(out.result, /first line of the patch must be '\*\*\* Begin Patch'/)
  })

  ownedIt('moves a file: stages the new path and the removal of the old one', async () => {
    await writeFile(join(tempRoot, 'old.ts'), 'x\n', 'utf-8')
    await run(patch('*** Update File: old.ts', '*** Move to: dir/new.ts', '-x', '+y'))
    assert.equal(getStagedDiffEntry('dir/new.ts')?.after, 'y\n')
    assert.equal(getStagedDiffEntry('old.ts')?.op, 'delete')
  })

  ownedIt('composes onto content already staged by str_replace', async () => {
    await mkdir(join(tempRoot, 'src'), { recursive: true })
    await writeFile(join(tempRoot, 'src/f.ts'), 'a\nb\nc\n', 'utf-8')
    await strReplaceTool.execute(
      { path: 'src/f.ts', old_string: 'a', new_string: 'A', replace_all: false },
      new AbortController().signal,
    )
    await run(patch('*** Update File: src/f.ts', ' b', '-c', '+C'))
    assert.equal(getStagedDiffEntry('src/f.ts')?.after, 'A\nb\nC\n')
  })

  ownedIt('refuses binary image paths', async () => {
    const out = await run(patch('*** Add File: logo.png', '+notapng'))
    assert.match(out.result, /binary images are not text/)
  })

  ownedIt('locates a hunk by context when indentation differs', async () => {
    await writeFile(join(tempRoot, 'f.py'), 'def f():\n    return 1\n', 'utf-8')
    await run(patch('*** Update File: f.py', '@@ def f():', '-return 1', '+return 2'))
    assert.equal(getStagedDiffEntry('f.py')?.after, 'def f():\nreturn 2\n')
  })

  ownedIt('composes two entries that spell the same file differently', async () => {
    await mkdir(join(tempRoot, 'dir'), { recursive: true })
    await writeFile(join(tempRoot, 'a.ts'), 'one\ntwo\n', 'utf-8')
    const out = await run(
      patch('*** Update File: a.ts', '-one', '+1', '*** Update File: dir/../a.ts', '-two', '+2'),
    )
    assert.match(out.result, /apply_patch handled 1 file:/)
    assert.equal(getStagedDiffEntry('a.ts')?.after, '1\n2\n')
    assert.equal(listStagedDiffEntries().length, 1)
  })
})
