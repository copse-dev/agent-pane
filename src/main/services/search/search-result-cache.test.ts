import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  getCachedToolResult,
  setCachedToolResult,
  invalidateSearchResultCache,
  clearAllSearchResultCachesForTest,
} from './search-result-cache.ts'

describe('search-result-cache', () => {
  beforeEach(() => {
    clearAllSearchResultCachesForTest()
  })

  it('returns undefined on a miss and the stored result on a hit', () => {
    assert.equal(getCachedToolResult('/root', 'search_code', { pattern: 'foo' }), undefined)
    setCachedToolResult('/root', 'search_code', { pattern: 'foo' }, 'result-a')
    assert.equal(getCachedToolResult('/root', 'search_code', { pattern: 'foo' }), 'result-a')
  })

  it('is insensitive to argument key order', () => {
    setCachedToolResult('/root', 'search_code', { a: 1, b: 2 }, 'r')
    assert.equal(getCachedToolResult('/root', 'search_code', { b: 2, a: 1 }), 'r')
  })

  it('treats different tool names or args as distinct entries', () => {
    setCachedToolResult('/root', 'find_files', { pattern: '*.ts' }, 'ts-files')
    assert.equal(getCachedToolResult('/root', 'find_files', { pattern: '*.js' }), undefined)
    assert.equal(getCachedToolResult('/root', 'list_dir', { pattern: '*.ts' }), undefined)
  })

  it('scopes cache entries per workspace root', () => {
    setCachedToolResult('/root-a', 'find_files', { pattern: '*.ts' }, 'a-result')
    assert.equal(getCachedToolResult('/root-b', 'find_files', { pattern: '*.ts' }), undefined)
    assert.equal(getCachedToolResult('/root-a', 'find_files', { pattern: '*.ts' }), 'a-result')
  })

  it('invalidateSearchResultCache clears only the given root', () => {
    setCachedToolResult('/root-a', 'find_files', {}, 'a')
    setCachedToolResult('/root-b', 'find_files', {}, 'b')
    invalidateSearchResultCache('/root-a')
    assert.equal(getCachedToolResult('/root-a', 'find_files', {}), undefined)
    assert.equal(getCachedToolResult('/root-b', 'find_files', {}), 'b')
  })

  it('evicts the oldest entry once a root exceeds its cap', () => {
    for (let i = 0; i < 201; i++) {
      setCachedToolResult('/root', 'find_files', { i }, `r${String(i)}`)
    }
    assert.equal(getCachedToolResult('/root', 'find_files', { i: 0 }), undefined)
    assert.equal(getCachedToolResult('/root', 'find_files', { i: 200 }), 'r200')
  })
})
