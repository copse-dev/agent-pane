import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyApprovals } from './diff-queue.ts'

const entry = (path: string, after = `content of ${path}`) => ({
  path,
  before: '',
  after,
  language: 'typescript',
})

test('applyApprovals writes every entry and reports them as succeeded', async () => {
  const written: Record<string, string> = {}
  const { succeeded, failures } = await applyApprovals(
    [entry('a.ts'), entry('nested/dir/b.ts')],
    async (p, c) => {
      written[p] = c
    },
  )
  assert.deepEqual(succeeded, ['a.ts', 'nested/dir/b.ts'])
  assert.equal(failures.length, 0)
  assert.deepEqual(written, {
    'a.ts': 'content of a.ts',
    'nested/dir/b.ts': 'content of nested/dir/b.ts',
  })
})

test('applyApprovals isolates failures and still writes the rest (#118)', async () => {
  const written: string[] = []
  const { succeeded, failures } = await applyApprovals(
    [entry('ok-1.ts'), entry('boom.ts'), entry('ok-2.ts')],
    async (p) => {
      if (p === 'boom.ts') throw new Error('ENOENT: no such directory')
      written.push(p)
    },
  )
  // One failure does not abort the batch.
  assert.deepEqual(written, ['ok-1.ts', 'ok-2.ts'])
  assert.deepEqual(succeeded, ['ok-1.ts', 'ok-2.ts'])
  assert.equal(failures.length, 1)
  assert.equal(failures[0]?.path, 'boom.ts')
  assert.match(failures[0]?.error ?? '', /ENOENT/)
})
