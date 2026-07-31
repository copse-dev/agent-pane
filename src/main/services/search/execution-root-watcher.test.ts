import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureExecutionRootWatched,
  stopWatchingExecutionRoot,
  stopAllExecutionRootWatchers,
  watchedExecutionRootsForTest,
} from './execution-root-watcher.ts'
import {
  getCachedToolResult,
  setCachedToolResult,
  clearAllSearchResultCachesForTest,
} from './search-result-cache.ts'

/** fs.watch is asynchronous; poll rather than guess a fixed delay. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

describe('execution-root-watcher', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-exec-watch-'))
    clearAllSearchResultCachesForTest()
  })

  afterEach(async () => {
    stopAllExecutionRootWatchers()
    clearAllSearchResultCachesForTest()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('watches a root once, idempotently', () => {
    assert.equal(ensureExecutionRootWatched(root), true)
    assert.equal(ensureExecutionRootWatched(root), true)
    assert.deepEqual(watchedExecutionRootsForTest(), [root])
  })

  it('reports failure for a root that cannot be watched', () => {
    assert.equal(ensureExecutionRootWatched(join(root, 'does-not-exist')), false)
    assert.deepEqual(watchedExecutionRootsForTest(), [])
  })

  it('invalidates cached results when a file under the root changes', async () => {
    ensureExecutionRootWatched(root)
    setCachedToolResult('t1', root, 'search_code', { pattern: 'foo' }, 'stale')
    await writeFile(join(root, 'touched.ts'), 'export const a = 1\n')
    const cleared = await waitFor(
      () => getCachedToolResult('t1', root, 'search_code', { pattern: 'foo' }) === undefined,
    )
    assert.ok(cleared, 'expected the external write to drop the cached result')
  })

  it('ignores churn under ignored directories', async () => {
    ensureExecutionRootWatched(root)
    setCachedToolResult('t1', root, 'search_code', { pattern: 'foo' }, 'kept')
    await writeFile(join(root, 'node_modules'), 'not a real dep tree\n')
    // Give any event the same window the positive case gets before asserting.
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(getCachedToolResult('t1', root, 'search_code', { pattern: 'foo' }), 'kept')
  })

  it('stops delivering invalidations once the root is unwatched', async () => {
    ensureExecutionRootWatched(root)
    stopWatchingExecutionRoot(root)
    assert.deepEqual(watchedExecutionRootsForTest(), [])
    setCachedToolResult('t1', root, 'search_code', { pattern: 'foo' }, 'kept')
    await writeFile(join(root, 'touched.ts'), 'export const a = 1\n')
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(getCachedToolResult('t1', root, 'search_code', { pattern: 'foo' }), 'kept')
  })
})
