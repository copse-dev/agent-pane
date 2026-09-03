import { describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { ownedIt } from '../services/thread-execution-context.test-support.ts'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { normalizeToolExecuteResult } from '@shared/types'
import { strReplaceTool } from './str-replace-tool.ts'
import { clearStagedDiffsForTest, getStagedDiffEntry } from '../services/diff-queue.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'

async function runStrReplace(args: {
  path: string
  old_string: string
  new_string: string
  replace_all: boolean
}): Promise<string> {
  return normalizeToolExecuteResult(
    await strReplaceTool.execute(args, new AbortController().signal),
  ).result
}

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

  ownedIt('stages a diff message on unique match', async () => {
    await writeFile(join(tempRoot, 'f.ts'), 'const x = 1\n', 'utf-8')
    const out = await runStrReplace({
      path: 'f.ts',
      old_string: 'const x = 1',
      new_string: 'const x = 2',
      replace_all: false,
    })
    assert.match(out, /Diff staged/)
  })

  ownedIt('errors when old_string is missing', async () => {
    await writeFile(join(tempRoot, 'f.ts'), 'a', 'utf-8')
    const out = await runStrReplace({
      path: 'f.ts',
      old_string: 'missing',
      new_string: 'b',
      replace_all: false,
    })
    assert.match(out, /not found/)
  })

  ownedIt('errors on ambiguous match without replace_all', async () => {
    await writeFile(join(tempRoot, 'f.ts'), 'foo\nfoo\n', 'utf-8')
    const out = await runStrReplace({
      path: 'f.ts',
      old_string: 'foo',
      new_string: 'bar',
      replace_all: false,
    })
    assert.match(out, /2 times/)
  })

  ownedIt('writes `$` sequences in new_string literally', async () => {
    // `String#replace` expands `$$`, `$&`, `` $` `` and `$'` in a replacement
    // string even for a plain-string pattern, so the file got something other
    // than new_string. `$$` is the one that bites in ordinary code: a template
    // literal printing a currency symbol lost a `$`.
    for (const [before, oldString, newString] of [
      ['const price = 1\n', 'const price = 1', 'const label = `Total: $${price}`'],
      ['MARK\n', 'MARK', 'x.replace(/a/, "$&!")'],
      ['MARK\n', 'MARK', "echo $'\\n'"],
      ['MARK\n', 'MARK', 'echo $`date`'],
      ['MARK\n', 'MARK', 'a $$ b $& c'],
    ] as const) {
      clearStagedDiffsForTest()
      await writeFile(join(tempRoot, 'f.ts'), before, 'utf-8')
      await runStrReplace({
        path: 'f.ts',
        old_string: oldString,
        new_string: newString,
        replace_all: false,
      })
      assert.equal(
        getStagedDiffEntry('f.ts')?.after,
        before.replace(oldString, () => newString),
        `new_string ${JSON.stringify(newString)} must land verbatim`,
      )
    }
  })

  ownedIt('agrees with replace_all on a single occurrence', async () => {
    // The two branches used different replacement machinery, so only one of them
    // expanded `$`. On a unique match they must produce the same file.
    const newString = 'const label = `Total: $${price}`'
    const results: Array<string | undefined> = []
    for (const replaceAll of [false, true]) {
      clearStagedDiffsForTest()
      await writeFile(join(tempRoot, 'f.ts'), 'const price = 1\n', 'utf-8')
      await runStrReplace({
        path: 'f.ts',
        old_string: 'const price = 1',
        new_string: newString,
        replace_all: replaceAll,
      })
      results.push(getStagedDiffEntry('f.ts')?.after)
    }
    assert.equal(results[0], results[1])
    assert.equal(results[0], `${newString}\n`)
  })

  ownedIt(
    'composes replacements against pending proposed content without writing to disk',
    async () => {
      await writeFile(join(tempRoot, 'f.ts'), 'const x = 1\n', 'utf-8')
      await runStrReplace({
        path: 'f.ts',
        old_string: 'const x = 1',
        new_string: 'const x = 2',
        replace_all: false,
      })
      const out = await runStrReplace({
        path: 'f.ts',
        old_string: 'const x = 2',
        new_string: 'const x = 3',
        replace_all: false,
      })

      assert.match(out, /Updated pending staged diff/)
      assert.equal(getStagedDiffEntry('f.ts')?.before, 'const x = 1\n')
      assert.equal(getStagedDiffEntry('f.ts')?.after, 'const x = 3\n')
      assert.equal(await readFile(join(tempRoot, 'f.ts'), 'utf-8'), 'const x = 1\n')
    },
  )
})
