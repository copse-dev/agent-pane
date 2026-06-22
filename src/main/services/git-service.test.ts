import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parsePorcelainV1 } from './git-service.ts'

describe('parsePorcelainV1', () => {
  it('returns empty lists for clean tree', () => {
    const result = parsePorcelainV1('')
    assert.deepEqual(result, { staged: [], unstaged: [] })
  })

  it('parses staged and unstaged modifications', () => {
    const raw = 'M  src/foo.ts\0 M src/bar.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.staged, [{ path: 'src/foo.ts', status: 'modified' }])
    assert.deepEqual(result.unstaged, [{ path: 'src/bar.ts', status: 'modified' }])
  })

  it('parses untracked files', () => {
    const raw = '?? new-file.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.unstaged, [{ path: 'new-file.ts', status: 'untracked' }])
    assert.equal(result.staged.length, 0)
  })

  it('ignores local codesearch database status entries', () => {
    const raw = '?? .codesearch.db/\0 M .codesearch.db/index\0?? src/file.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.unstaged, [{ path: 'src/file.ts', status: 'untracked' }])
    assert.equal(result.staged.length, 0)
  })

  it('parses staged deletion', () => {
    const raw = 'D  old.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.staged, [{ path: 'old.ts', status: 'deleted' }])
  })

  it('parses renames', () => {
    const raw = 'R  old.ts\0new.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.staged, [{ path: 'new.ts', status: 'renamed' }])
  })

  it('parses both staged and unstaged on same file', () => {
    const raw = 'MM src/both.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.staged, [{ path: 'src/both.ts', status: 'modified' }])
    assert.deepEqual(result.unstaged, [{ path: 'src/both.ts', status: 'modified' }])
  })
})
