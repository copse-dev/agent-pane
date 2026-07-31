import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  getCachedToolResult,
  setCachedToolResult,
  invalidateThreadSearchCache,
  invalidateSearchResultCacheUnderRoot,
  clearAllSearchResultCachesForTest,
} from './search-result-cache.ts'

const ROOT = '/projects/app'
const WORKTREE = '/home/u/.copse/worktrees/p1/t2'

describe('search-result-cache', () => {
  beforeEach(() => {
    clearAllSearchResultCachesForTest()
  })

  it('returns undefined on a miss and the stored result on a hit', () => {
    assert.equal(getCachedToolResult('t1', ROOT, 'search_code', { pattern: 'foo' }), undefined)
    setCachedToolResult('t1', ROOT, 'search_code', { pattern: 'foo' }, 'result-a')
    assert.equal(getCachedToolResult('t1', ROOT, 'search_code', { pattern: 'foo' }), 'result-a')
  })

  it('is insensitive to argument key order', () => {
    setCachedToolResult('t1', ROOT, 'search_code', { a: 1, b: 2 }, 'r')
    assert.equal(getCachedToolResult('t1', ROOT, 'search_code', { b: 2, a: 1 }), 'r')
  })

  it('treats different tool names or args as distinct entries', () => {
    setCachedToolResult('t1', ROOT, 'find_files', { pattern: '*.ts' }, 'ts-files')
    assert.equal(getCachedToolResult('t1', ROOT, 'find_files', { pattern: '*.js' }), undefined)
    assert.equal(getCachedToolResult('t1', ROOT, 'list_dir', { pattern: '*.ts' }), undefined)
  })

  it('never shares entries between threads', () => {
    setCachedToolResult('t1', ROOT, 'find_files', { pattern: '*.ts' }, 'from-t1')
    assert.equal(getCachedToolResult('t2', ROOT, 'find_files', { pattern: '*.ts' }), undefined)
    assert.equal(getCachedToolResult('t1', ROOT, 'find_files', { pattern: '*.ts' }), 'from-t1')
  })

  // Two threads on separate worktrees of one project must not see each other's
  // results even though the tool and args are identical.
  it('keeps worktree threads isolated from shared-checkout threads', () => {
    setCachedToolResult('shared', ROOT, 'search_code', { pattern: 'x' }, 'project-result')
    setCachedToolResult('wt', WORKTREE, 'search_code', { pattern: 'x' }, 'worktree-result')
    assert.equal(
      getCachedToolResult('shared', ROOT, 'search_code', { pattern: 'x' }),
      'project-result',
    )
    assert.equal(
      getCachedToolResult('wt', WORKTREE, 'search_code', { pattern: 'x' }),
      'worktree-result',
    )
  })

  it('treats a changed root for the same thread as a miss', () => {
    setCachedToolResult('t1', ROOT, 'find_files', {}, 'old')
    assert.equal(getCachedToolResult('t1', WORKTREE, 'find_files', {}), undefined)
  })

  it('invalidateThreadSearchCache clears only that thread', () => {
    setCachedToolResult('t1', ROOT, 'find_files', {}, 'a')
    setCachedToolResult('t2', ROOT, 'find_files', {}, 'b')
    invalidateThreadSearchCache('t1')
    assert.equal(getCachedToolResult('t1', ROOT, 'find_files', {}), undefined)
    assert.equal(getCachedToolResult('t2', ROOT, 'find_files', {}), 'b')
  })

  it('invalidates every thread rooted at or under a changed root', () => {
    setCachedToolResult('t1', ROOT, 'find_files', {}, 'a')
    setCachedToolResult('t2', `${ROOT}/packages/web`, 'find_files', {}, 'b')
    setCachedToolResult('t3', WORKTREE, 'find_files', {}, 'c')
    invalidateSearchResultCacheUnderRoot(ROOT)
    assert.equal(getCachedToolResult('t1', ROOT, 'find_files', {}), undefined)
    assert.equal(getCachedToolResult('t2', `${ROOT}/packages/web`, 'find_files', {}), undefined)
    // A worktree lives outside the project, so it survives the project's edit.
    assert.equal(getCachedToolResult('t3', WORKTREE, 'find_files', {}), 'c')
  })

  it('does not treat a sibling root sharing a name prefix as a descendant', () => {
    setCachedToolResult('t1', `${ROOT}-backup`, 'find_files', {}, 'a')
    invalidateSearchResultCacheUnderRoot(ROOT)
    assert.equal(getCachedToolResult('t1', `${ROOT}-backup`, 'find_files', {}), 'a')
  })

  it('evicts the oldest entry once a thread exceeds its entry cap', () => {
    for (let i = 0; i < 201; i++) {
      setCachedToolResult('t1', ROOT, 'find_files', { i }, `r${String(i)}`)
    }
    assert.equal(getCachedToolResult('t1', ROOT, 'find_files', { i: 0 }), undefined)
    assert.equal(getCachedToolResult('t1', ROOT, 'find_files', { i: 200 }), 'r200')
  })

  it('bounds how many threads are retained, evicting least-recently-used', () => {
    for (let i = 0; i < 9; i++) {
      setCachedToolResult(`t${String(i)}`, ROOT, 'find_files', {}, `r${String(i)}`)
    }
    assert.equal(getCachedToolResult('t0', ROOT, 'find_files', {}), undefined)
    assert.equal(getCachedToolResult('t8', ROOT, 'find_files', {}), 'r8')
  })
})
