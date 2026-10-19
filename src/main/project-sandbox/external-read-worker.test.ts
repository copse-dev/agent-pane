import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { executeExternalRead, type ExternalReadAction } from './external-read-worker.ts'

describe('external read worker', () => {
  let base = ''
  let root = ''
  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'external-worker-')))
    root = join(base, 'approved')
    await mkdir(root)
    await writeFile(join(root, 'note.txt'), 'before\nneedle\nafter\n')
    await writeFile(join(base, 'sibling.txt'), 'needle outside\n')
  })
  afterEach(async () => { await rm(base, { recursive: true, force: true }) })
  const run = (action: ExternalReadAction, path = root, excludedRoots: string[] = []) =>
    executeExternalRead({ op: 'externalRead', path, excludedRoots, action })

  it('reads a regular file', async () => {
    assert.equal(await run({ kind: 'read' }, join(root, 'note.txt')), 'before\nneedle\nafter\n')
  })
  it('never reads credential files, including through an alias', async () => {
    await writeFile(join(root, '.env'), 'needle credential\n')
    await symlink(join(root, '.env'), join(root, 'alias.txt'))
    await assert.rejects(run({ kind: 'read' }, join(root, '.env')), /protected/)
    await assert.rejects(run({ kind: 'read' }, join(root, 'alias.txt')), /protected/)
    const result = await run({ kind: 'search', pattern: 'needle', fixed: true,
      caseSensitive: true, maxResults: 10, contextLines: 0 })
    assert.match(result, /note\.txt:2: needle/)
    assert.doesNotMatch(result, /credential|alias|\.env/)
  })
  it('does not traverse directory or file symlinks', async () => {
    await symlink(base, join(root, 'escape'))
    await symlink(join(base, 'sibling.txt'), join(root, 'linked.txt'))
    const result = await run({ kind: 'search', pattern: 'needle', fixed: true,
      caseSensitive: true, maxResults: 10, contextLines: 0 })
    assert.doesNotMatch(result, /outside|escape|linked/)
  })
  it('excludes the chat store nested under a granted ancestor', async () => {
    const chat = join(root, 'workspace')
    await mkdir(chat)
    await writeFile(join(chat, 'events.jsonl'), 'needle other conversation')
    const result = await run({ kind: 'search', pattern: 'needle', fixed: true,
      caseSensitive: true, maxResults: 10, contextLines: 0 }, root, [chat])
    assert.doesNotMatch(result, /conversation|events/)
    await assert.rejects(run({ kind: 'read' }, join(chat, 'events.jsonl'), [chat]), /protected/)
  })
  it('supports bounded context and filename filters', async () => {
    await writeFile(join(root, 'other.md'), 'needle ignored')
    const result = await run({ kind: 'search', pattern: 'NEEDLE', fixed: true,
      caseSensitive: false, maxResults: 1, contextLines: 1, glob: '*.txt' })
    assert.match(result, /note\.txt-1- before/)
    assert.match(result, /note\.txt:2: needle/)
    assert.match(result, /note\.txt-3- after/)
    assert.doesNotMatch(result, /other\.md/)
  })
  it('lists directories without opening protected children or links', async () => {
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'file.txt'), 'ok')
    await mkdir(join(root, '.ssh'))
    await symlink(base, join(root, 'escape'))
    assert.match(await run({ kind: 'list', recursive: false }), /d nested/)
    const recursive = await run({ kind: 'list', recursive: true })
    assert.match(recursive, /nested\/file\.txt/)
    assert.doesNotMatch(recursive, /\.ssh|escape/)
  })
})
